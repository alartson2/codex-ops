#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

OPENCLAW_CONTAINER_DEFAULT="openclaw-yvrh-openclaw-1"
OPENCLAW_CONTAINER="${OPENCLAW_CONTAINER:-$OPENCLAW_CONTAINER_DEFAULT}"

log() {
  printf '[bootstrap] %s\n' "$*"
}

die() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "Run as root (use sudo)."
  fi
}

require_ubuntu() {
  if [[ ! -f /etc/os-release ]]; then
    die "Cannot detect OS. /etc/os-release is missing."
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    die "This bootstrap script currently supports Ubuntu only."
  fi
}

ensure_base_packages() {
  log "Installing base packages..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg lsb-release rsync docker.io
  systemctl enable --now docker
}

ensure_node() {
  local need_node=1
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "${major}" =~ ^[0-9]+$ ]] && (( major >= 20 )); then
      need_node=0
    fi
  fi

  if (( need_node == 0 )); then
    log "Node.js is already present and compatible."
    return
  fi

  log "Installing Node.js 22.x..."
  install -d -m 0755 /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  fi
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
}

ensure_codex_cli() {
  if command -v codex >/dev/null 2>&1; then
    log "Codex CLI is already installed: $(codex --version 2>/dev/null || echo unknown)"
    return
  fi
  log "Installing Codex CLI..."
  npm install -g @openai/codex
}

ensure_user() {
  if ! id -u codexops >/dev/null 2>&1; then
    log "Creating user codexops..."
    useradd -m -d /var/lib/codexops -s /bin/bash codexops
  fi

  if ! getent group docker >/dev/null 2>&1; then
    log "Creating docker group..."
    groupadd docker
  fi

  usermod -aG docker codexops
}

deploy_tree() {
  log "Deploying codex-ops files to /opt/codex-ops..."
  install -d -m 0755 /opt/codex-ops
  rsync -a --delete \
    --exclude '.git' \
    --exclude '.idea' \
    --exclude '.vscode' \
    "${REPO_DIR}/" /opt/codex-ops/
}

prepare_paths() {
  log "Preparing runtime paths..."
  install -d -m 0755 /etc/codex-ops
  install -d -m 0755 /srv/codex-ops
  install -d -m 0755 /srv/codex-ops/incidents
  install -d -m 0755 /srv/codex-ops/projects/openclaw
  install -d -m 0755 /srv/codex-ops/projects/server
  install -d -m 0755 /var/lib/codexops/state
  install -d -m 0755 /var/lib/codexops/.codex
}

seed_context_files() {
  if [[ ! -f /srv/codex-ops/OPS_CONTEXT.md ]]; then
    cat >/srv/codex-ops/OPS_CONTEXT.md <<'EOF'
# Codex Ops Context

Host-level Codex + Telegram operations layer for OpenClaw.
EOF
  fi

  if [[ ! -f /srv/codex-ops/RUNBOOK_OPENCLAW.md ]]; then
    cat >/srv/codex-ops/RUNBOOK_OPENCLAW.md <<'EOF'
# OpenClaw Runbook

Fast check list:
1. docker ps for openclaw container
2. docker logs --since 25m
3. internal ports 18789 and 18791
EOF
  fi

  if [[ ! -f /srv/codex-ops/projects/server/NOTES.md ]]; then
    cat >/srv/codex-ops/projects/server/NOTES.md <<'EOF'
# Server Notes
EOF
  fi

  if [[ ! -f /srv/codex-ops/projects/openclaw/NOTES.md ]]; then
    cat >/srv/codex-ops/projects/openclaw/NOTES.md <<'EOF'
# OpenClaw Notes
EOF
  fi
}

install_env_file() {
  local env_file="/etc/codex-ops/bot.env"
  if [[ -f "${env_file}" ]]; then
    log "Keeping existing ${env_file}."
    return
  fi

  log "Creating ${env_file} from template..."
  cat >"${env_file}" <<EOF
# Dedicated Telegram bot token for codex-ops.
TELEGRAM_BOT_TOKEN=
# Comma-separated list of allowed Telegram chat IDs.
ALLOWED_CHAT_IDS=
INCIDENTS_DIR=/srv/codex-ops/incidents
STATE_DIR=/var/lib/codexops/state
OPENCLAW_CONTAINER=${OPENCLAW_CONTAINER}
CODEX_CWD=/srv/codex-ops/incidents
HOST_LABEL=$(hostname)
EOF
  chmod 0600 "${env_file}"
  chown root:root "${env_file}"
}

install_systemd_unit() {
  local src="${REPO_DIR}/deploy/systemd/codex-telegram-bot.service"
  local dst="/etc/systemd/system/codex-telegram-bot.service"
  [[ -f "${src}" ]] || die "Missing systemd unit at ${src}"
  log "Installing systemd unit..."
  install -m 0644 "${src}" "${dst}"
  systemctl daemon-reload
  systemctl enable codex-telegram-bot.service
}

fix_permissions() {
  log "Applying file ownership..."
  chown -R codexops:codexops /opt/codex-ops
  chown -R codexops:codexops /srv/codex-ops
  chown -R codexops:codexops /var/lib/codexops
  chmod 0755 /opt/codex-ops/scripts/*.sh || true
}

can_start_service_now() {
  local env_file="/etc/codex-ops/bot.env"
  local token
  local chats
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "${env_file}" | cut -d= -f2- || true)"
  chats="$(grep -E '^ALLOWED_CHAT_IDS=' "${env_file}" | cut -d= -f2- || true)"
  [[ -n "${token}" && -n "${chats}" ]]
}

main() {
  require_root
  require_ubuntu
  ensure_base_packages
  ensure_node
  ensure_codex_cli
  ensure_user
  deploy_tree
  prepare_paths
  seed_context_files
  install_env_file
  install_systemd_unit
  fix_permissions

  if can_start_service_now; then
    log "Starting codex-telegram-bot.service..."
    systemctl restart codex-telegram-bot.service
    systemctl --no-pager --full status codex-telegram-bot.service | sed -n '1,25p'
  else
    log "Service was enabled but not started."
    log "Edit /etc/codex-ops/bot.env and set TELEGRAM_BOT_TOKEN + ALLOWED_CHAT_IDS."
  fi

  log "Next step: native ChatGPT login for codexops"
  log "Run: sudo /opt/codex-ops/scripts/codex-auth.sh login"
}

main "$@"
