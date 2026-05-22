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
- `UPLOADS_DIR=/var/lib/codexops/state/uploads`
- `PROJECTS_DIR=/srv/codex-ops/projects`
- `DEFAULT_PROJECT=server`
- `CODEX_CWD=/srv/codex-ops/incidents` as the fallback workspace. Project requests normally run from `/srv/codex-ops/projects/<project>`.

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

## First server setup workflow

After a fresh install, start from the host-level project:

```text
/project server
```

Ask Codex to collect server context before creating application-specific projects:

```text
Collect the initial context for this server: OS, services, Docker state, important paths, available credentials or env files without exposing secrets, deployment constraints, and recommended next steps. Save durable facts into the server project memory.
```

Use the `server` project to install or bootstrap the target multi-agent system, for example OpenClaw, Hermes, or another application stack. This keeps host discovery, package installation, service setup, DNS, firewall, Docker, and systemd work in the host-level memory bucket.

After the target system exists, create and switch to a dedicated project:

```text
/project new <project-name>
/project <project-name>
```

From there, continue normal setup and operations in that project. Project-specific facts, runbooks, changelog entries, and notes should live in that project memory, not in public repository defaults.

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
