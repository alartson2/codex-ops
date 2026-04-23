# Operations Runbook

## Service lifecycle

Start or restart:

```bash
sudo systemctl restart codex-telegram-bot.service
```

Stop:

```bash
sudo systemctl stop codex-telegram-bot.service
```

Status:

```bash
sudo systemctl status --no-pager codex-telegram-bot.service
```

Logs:

```bash
sudo journalctl -u codex-telegram-bot.service -n 200 --no-pager
```

## Codex auth lifecycle

Status:

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh status
```

Login:

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh login
```

Logout:

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh logout
```

Or from Telegram:

- `/codex login`
- `/codex login status`
- `/codex login cancel`

## Day-2 maintenance

Update repository and service:

```bash
cd /root/codex-ops
git pull
sudo ./scripts/bootstrap-vps.sh
sudo systemctl restart codex-telegram-bot.service
```

Check active settings:

```bash
sudo grep -Ev '^\s*($|#)' /etc/codex-ops/bot.env
```

## Incident note workflow

- `/diag openclaw` collects runtime evidence and stores a diagnostic markdown note.
- incident output path is controlled by `INCIDENTS_DIR`.
- use `/lastincident openclaw` to retrieve latest note summary.

## Public release hygiene checklist

Before pushing to public remote:

- verify no secrets in tracked files
- verify no private key material is tracked
- verify no internal incident dumps are tracked
- verify docs and command examples match current code behavior

Useful checks:

```bash
git status --short
git ls-files
```
