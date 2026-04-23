# VPS Installation Guide

This guide installs `codex-ops` on a fresh Ubuntu VPS and keeps setup reproducible.

## Supported target

- Ubuntu 22.04 or 24.04
- root or sudo access
- outbound network access to Telegram API and OpenAI/Codex endpoints

## Option A: standard install from git clone

```bash
git clone https://github.com/alartson2/codex-ops.git /root/codex-ops
cd /root/codex-ops
chmod +x ./scripts/bootstrap-vps.sh
sudo ./scripts/bootstrap-vps.sh
```

## Option B: quick wrapper install (clone + bootstrap)

```bash
curl -fsSL https://raw.githubusercontent.com/alartson2/codex-ops/master/scripts/install-vps.sh | sudo bash -s -- https://github.com/alartson2/codex-ops.git
```

The wrapper script installs `git` (if needed), clones or updates the repository, then runs bootstrap.

## Configure runtime variables

Edit:

```bash
sudo nano /etc/codex-ops/bot.env
```

Required:

- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_CHAT_IDS`

Recommended base values:

- `INCIDENTS_DIR=/srv/codex-ops/incidents`
- `STATE_DIR=/var/lib/codexops/state`
- `OPENCLAW_CONTAINER=openclaw-yvrh-openclaw-1`
- `CODEX_CWD=/srv/codex-ops/incidents`

## Native Codex login (subscription device auth)

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh login
```

Check status:

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh status
```

Expected output includes successful login status.

## Start and verify service

```bash
sudo systemctl restart codex-telegram-bot.service
sudo systemctl status --no-pager codex-telegram-bot.service
```

Smoke checks:

```bash
sudo systemctl is-active codex-telegram-bot.service
sudo journalctl -u codex-telegram-bot.service -n 80 --no-pager
```

Codex check as service user:

```bash
sudo runuser -u codexops -- env HOME=/var/lib/codexops CODEX_HOME=/var/lib/codexops/.codex codex login status
```

## Update on an existing VPS

```bash
cd /root/codex-ops
git pull
sudo ./scripts/bootstrap-vps.sh
sudo systemctl restart codex-telegram-bot.service
```

## Rollback strategy

Before major changes:

- snapshot `/etc/codex-ops/bot.env`
- snapshot `/srv/codex-ops`
- snapshot `/var/lib/codexops`

Simple rollback:

- restore previous repository commit
- rerun bootstrap
- restart service

## Next docs

- [Configuration reference](CONFIGURATION.md)
- [Operations runbook](OPERATIONS.md)
- [Troubleshooting](TROUBLESHOOTING.md)
