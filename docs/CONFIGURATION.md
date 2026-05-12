# Configuration Reference

All runtime configuration is loaded from `/etc/codex-ops/bot.env`.

## Required variables

- `TELEGRAM_BOT_TOKEN`: Telegram bot token from BotFather.
- `ALLOWED_CHAT_IDS`: comma-separated list of Telegram chat IDs allowed to use the bot.

## Core paths and identity

- `INCIDENTS_DIR` (default: `/srv/codex-ops/incidents`): incident and diagnostic notes.
- `STATE_DIR` (default: `/var/lib/codexops/state`): bot offset/chat state/debug logs.
- `OPENCLAW_CONTAINER` (default: `openclaw-yvrh-openclaw-1`): container used by OpenClaw diagnostics.
- `CODEX_CWD` (default: `/srv/codex-ops/incidents`): working directory for `codex exec`.
- `HOST_LABEL` (default: hostname): display label in bot responses.
- `ASSISTANT_LANGUAGE` (default: `Russian`): language instruction passed into Codex prompts.

## Context memory tuning

- `HISTORY_ITEMS` (default: `8`): number of recent user/assistant items kept per chat.
- `HISTORY_ITEM_CHARS` (default: `1400`): max chars per history item.
- `HISTORICAL_INCIDENT_LIMIT` (default: `4000`): max chars of latest incident fed into prompt.

## Telegram output and anti-flood tuning

- `TELEGRAM_FORMAT` (default: `html`): output formatting mode. Use `html` to render Codex Markdown as Telegram-native bold, italic, links, inline code, and code blocks. Use `plain` to disable formatting.
- `MAX_MESSAGE` (default: `3500`): per-message chunk size (hard capped in code).
- `MAX_MESSAGE_CHUNKS` (default: `4`): max outbound chunks per response.
- `OUTBOUND_DELAY_MS` (default: `250`): delay between chunks.
- `TG_RETRY_ATTEMPTS` (default: `3`): retries for Telegram 429 responses.
- `TG_RETRY_FALLBACK_DELAY_MS` (default: `2000`): fallback wait when retry_after is absent.
- `TG_RETRY_MAX_WAIT_MS` (default: `120000`): max backoff wait.

## Auth flow tuning

- `CODEX_DEVICE_AUTH_TIMEOUT_MS` (default: `900000`): timeout for `/codex login` device auth flow.
- `CODEX_EXEC_TIMEOUT_MS` (default: `0`): timeout for `codex exec` runs in milliseconds. Set `0` to disable timeout and wait for real completion.
- `CODEX_PROGRESS_INTERVAL_MS` (default: `300000`): interval for "Codex progress update" Telegram messages while `codex exec` is still running. Set `0` to disable. Positive values below `60000` are raised to `60000`.
- `CODEX_PROGRESS_MAX_CHARS` (default: `1800`): max length of streamed assistant progress copied into each progress update.

## Suggested presets

Balanced (recommended default):

```env
TELEGRAM_FORMAT=html
HISTORY_ITEMS=8
HISTORY_ITEM_CHARS=1400
MAX_MESSAGE=3500
MAX_MESSAGE_CHUNKS=4
OUTBOUND_DELAY_MS=250
```

Conservative anti-flood:

```env
MAX_MESSAGE_CHUNKS=2
OUTBOUND_DELAY_MS=350
HISTORY_ITEMS=6
HISTORY_ITEM_CHARS=900
```

Higher context depth (more token usage):

```env
HISTORY_ITEMS=12
HISTORY_ITEM_CHARS=1800
MAX_MESSAGE_CHUNKS=5
```

## Example bot.env

```env
TELEGRAM_BOT_TOKEN=<redacted>
ALLOWED_CHAT_IDS=123456789,987654321
INCIDENTS_DIR=/srv/codex-ops/incidents
STATE_DIR=/var/lib/codexops/state
OPENCLAW_CONTAINER=openclaw-yvrh-openclaw-1
CODEX_CWD=/srv/codex-ops/incidents
HOST_LABEL=prod-vps-1
ASSISTANT_LANGUAGE=Russian
HISTORY_ITEMS=8
HISTORY_ITEM_CHARS=1400
MAX_MESSAGE=3500
MAX_MESSAGE_CHUNKS=4
OUTBOUND_DELAY_MS=250
TG_RETRY_ATTEMPTS=3
TG_RETRY_FALLBACK_DELAY_MS=2000
TG_RETRY_MAX_WAIT_MS=120000
HISTORICAL_INCIDENT_LIMIT=4000
CODEX_DEVICE_AUTH_TIMEOUT_MS=900000
CODEX_EXEC_TIMEOUT_MS=0
CODEX_PROGRESS_INTERVAL_MS=300000
CODEX_PROGRESS_MAX_CHARS=1800
```
