#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

action="${1:-status}"

run_as_codexops() {
  runuser -u codexops -- env HOME=/var/lib/codexops CODEX_HOME=/var/lib/codexops/.codex "$@"
}

case "$action" in
  login)
    run_as_codexops codex login --device-auth
    ;;
  logout)
    run_as_codexops codex logout
    ;;
  status)
    run_as_codexops codex login status
    ;;
  *)
    echo "Usage: $0 [login|logout|status]" >&2
    exit 2
    ;;
esac
