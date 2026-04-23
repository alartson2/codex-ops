#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sudo ./scripts/install-vps.sh <repo-url> [target-dir]

Examples:
  sudo ./scripts/install-vps.sh https://github.com/alartson2/codex-ops.git
  sudo ./scripts/install-vps.sh https://github.com/alartson2/codex-ops.git /root/codex-ops
EOF
}

die() {
  printf '[install-vps] ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "Run as root (use sudo)."
fi

REPO_URL="${1:-}"
TARGET_DIR="${2:-/root/codex-ops}"

if [[ -z "${REPO_URL}" ]]; then
  usage
  exit 2
fi

printf '[install-vps] Installing git if needed...\n'
apt-get update -y
apt-get install -y git

if [[ -d "${TARGET_DIR}/.git" ]]; then
  printf '[install-vps] Existing git repository found at %s, updating...\n' "${TARGET_DIR}"
  git -C "${TARGET_DIR}" pull --ff-only
else
  if [[ -e "${TARGET_DIR}" && -n "$(ls -A "${TARGET_DIR}" 2>/dev/null || true)" ]]; then
    die "Target directory ${TARGET_DIR} exists and is not empty."
  fi
  printf '[install-vps] Cloning repository to %s...\n' "${TARGET_DIR}"
  git clone "${REPO_URL}" "${TARGET_DIR}"
fi

cd "${TARGET_DIR}"
chmod +x ./scripts/bootstrap-vps.sh
printf '[install-vps] Running bootstrap...\n'
./scripts/bootstrap-vps.sh

printf '[install-vps] Done. Next step: sudo /opt/codex-ops/scripts/codex-auth.sh login\n'
