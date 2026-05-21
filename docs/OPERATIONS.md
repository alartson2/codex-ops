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

## Running task control

- `/codex task`: inspect the currently active Codex task and pending queue.
- Regular requests sent while Codex is busy are queued; edit the original Telegram message before it starts to update the queued request.
- `/codex stop` or `/stop`: emergency-stop the active task. The bot sends `SIGTERM` to the managed process group, waits `CODEX_STOP_KILL_GRACE_MS`, then sends `SIGKILL` if needed.
- `/codex steer <instruction>` or `/steer <instruction>`: stop the active process and resume the latest Codex session with new guidance.

Use steer when the task is still useful but needs a course correction. Use stop when the current task should not continue or should not send a final answer.

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
