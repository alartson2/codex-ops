# codex-ops

Host-level Telegram operations bot for Codex CLI, designed for OpenClaw and general VPS operations.

## What this project does

`codex-ops` runs outside your OpenClaw container and gives you a stable operational channel in Telegram:

- ask Codex to investigate issues directly from the server
- run targeted diagnostics (`/status`, `/diag openclaw`)
- keep short per-chat context with project switching
- perform native Codex device login through Telegram (`/codex login`)
- protect Telegram from flood output with message chunk limits and safe fallback behavior

## Why this exists

When OpenClaw or its container runtime is unhealthy, diagnostics from inside the container are often hard to trust or hard to reach. `codex-ops` keeps the control layer on the host, so incident response still works during runtime failures.

## Main features

- Telegram bot frontend with access control (`ALLOWED_CHAT_IDS`)
- Codex CLI integration (`codex exec`) for investigations and Q/A
- Native subscription device auth flow (`/codex login`)
- Persistent lightweight chat state and project-aware context
- OpenClaw-focused diagnostics and incident note generation
- 429-aware Telegram send retry logic and anti-flood truncation

## Quick install (Ubuntu VPS)

1. Clone repository:

```bash
git clone https://github.com/alartson2/codex-ops.git /root/codex-ops
cd /root/codex-ops
```

2. Run bootstrap:

```bash
chmod +x ./scripts/bootstrap-vps.sh
sudo ./scripts/bootstrap-vps.sh
```

3. Configure bot settings:

```bash
sudo nano /etc/codex-ops/bot.env
```

Set required variables:

- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_CHAT_IDS`

4. Complete native Codex login:

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh login
```

5. Restart and verify:

```bash
sudo systemctl restart codex-telegram-bot.service
sudo systemctl status --no-pager codex-telegram-bot.service
```

## Telegram commands

- normal text message: ask Codex directly
- `/ask <question>`
- `/status`
- `/diag openclaw`
- `/lastincident openclaw`
- `/runbook openclaw`
- `/projects`
- `/project <name>`
- `/project new <name>`
- `/context show`
- `/session reset`
- `/codex login`
- `/codex login status`
- `/codex login cancel`

## Documentation

- [Detailed installation guide](docs/INSTALL.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Operations runbook](docs/OPERATIONS.md)
- [Troubleshooting guide](docs/TROUBLESHOOTING.md)

## Security and public repo hygiene

- never commit real secrets (`.env`, API tokens, private keys)
- keep only `.pub` keys in repository, never private key material
- review logs and incident files before publishing (they may contain host details)
- restrict Telegram access with `ALLOWED_CHAT_IDS`

## Update flow

```bash
cd /root/codex-ops
git pull
sudo ./scripts/bootstrap-vps.sh
sudo systemctl restart codex-telegram-bot.service
```

## Development checks

```bash
node --check bot.mjs
```

```bash
git status --short
```
