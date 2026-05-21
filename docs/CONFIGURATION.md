# Configuration Reference

All runtime configuration is loaded from `/etc/codex-ops/bot.env`.

## Required variables

- `TELEGRAM_BOT_TOKEN`: Telegram bot token from BotFather.
- `ALLOWED_CHAT_IDS`: comma-separated list of Telegram chat IDs allowed to use the bot. Multiple IDs enable multi-chat mode for trusted operators.

## Core paths and identity

- `INCIDENTS_DIR` (default: `/srv/codex-ops/incidents`): incident and diagnostic notes.
- `STATE_DIR` (default: `/var/lib/codexops/state`): bot offset/chat state/debug logs.
- `UPLOADS_DIR` (default: `$STATE_DIR/uploads`): downloaded Telegram image attachments passed to `codex exec --image`.
- `OPENCLAW_CONTAINER` (default: `openclaw-yvrh-openclaw-1`): container used by OpenClaw diagnostics.
- `CODEX_CWD` (default: `/srv/codex-ops/incidents`): fallback working directory for `codex exec` when no active project repository is available. Normal project requests run from `/srv/codex-ops/projects/<project>`.
- `HOST_LABEL` (default: hostname): display label in bot responses.
- `ASSISTANT_LANGUAGE` (default: `Russian`): language instruction passed into Codex prompts.

## Durable host request queues

The deployed application tree under `/opt/codex-ops` is treated as deploy-managed code. Local runtime behavior that should survive deploys belongs in `/etc/codex-ops/bot.env`, `STATE_DIR`, or project memory under `PROJECTS_DIR`.

The bot can wake itself up from durable request files. This is the preferred mechanism for reminders, delayed follow-up, and host-side requests created by another agent:

- `HOST_REQUEST_POLL_INTERVAL_MS` (default: `3600000`): interval for scanning host request queues. Set `0` to disable.
- `HOST_REQUEST_STARTUP_DELAY_MS` (default: `30000`): startup delay before the first scan, so already-pending files are picked up soon after restart.
- `HOST_REQUEST_RUNNING_STALE_MS` (default: `21600000`): age after which a `running/` request with no in-memory task is moved back to `pending/` for retry. Set `0` to disable recovery.
- `HOST_REQUEST_DIR_NAMES` (default: `host-requests,staging-requests,scheduled-requests`): per-project queue directory names scanned under each `/srv/codex-ops/projects/<project>`.
- `HOST_REQUEST_DIRS`: semicolon/comma/newline-separated extra absolute queue directories. Defaults include `$STATE_DIR/host-requests`, `$STATE_DIR/scheduled-requests`, and OpenClaw runtime mirror request directories under `/data/.openclaw/team-memory`.

Each queue may contain Markdown, text, or JSON files directly in the queue directory or in its `pending/` subdirectory. The bot ignores `README.md`, `.gitkeep`, and files whose names start with `_`. Picked files move to `running/`; they move to `done/` only after the Codex task completes successfully, or to `failed/` when the task fails.

For a one-shot smoke test, run the service environment with `CODEX_OPS_HOST_REQUEST_POLL_ONCE=1 node /opt/codex-ops/bot.mjs`. The process scans due requests, waits for any started tasks to finish, and exits instead of entering the Telegram polling loop.

Markdown request example:

```md
---
project: openclaw
title: Check pending runtime request
runAt: 2026-05-21T15:30:00+05:00
---

Check the pending OpenClaw host request and report what changed.
```

JSON request example:

```json
{
  "project": "openclaw",
  "runAt": "2026-05-21T15:30:00+05:00",
  "question": "Check the pending OpenClaw host request and report what changed."
}
```

## Context memory tuning

- `HISTORY_ITEMS` (default: `8`): number of recent user/assistant items kept per chat.
- `HISTORY_ITEM_CHARS` (default: `1400`): max chars per history item.
- `HISTORICAL_INCIDENT_LIMIT` (default: `4000`): max chars of latest incident fed into prompt.

## Multi-chat behavior

One bot instance can be attached to multiple allowed Telegram chats by setting `ALLOWED_CHAT_IDS=123,456,...`.

Per-chat state is stored under each Telegram `chat.id` in `CHAT_STATE_FILE`. This includes the active project, recent history, pending images, and Codex model/reasoning overrides. In Telegram groups, everyone in the same group shares the same group chat session because Telegram exposes the group `chat.id` to the bot.

Project files are shared across chats when the same project is selected. That includes the project repository and memory files under `PROJECTS_DIR`. The Codex worker is also shared: the process runs one active Codex task at a time and queues new requests FIFO.

For separate trust boundaries, run separate bot instances with different `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS`, `STATE_DIR`, `PROJECTS_DIR`, and `CODEX_HOME`. A separate service user is recommended when filesystem permissions, credentials, or Codex login state should not be shared.

## Telegram image input tuning

- `TELEGRAM_IMAGE_MAX_BYTES` (default: `10000000`): max downloaded image size. Larger Telegram photos or image documents are rejected before reaching Codex.
- `PENDING_IMAGE_TTL_MS` (default: `1800000`): how long a captionless image remains attached to the next text question. Set `0` to disable expiration.
- `PENDING_IMAGE_MAX_ITEMS` (default: `4`): max pending images per chat. Higher values are capped in code.

## Telegram voice input via OpenRouter

Voice messages are not sent directly to `codex exec`. The bot downloads the Telegram voice file, transcribes it through OpenRouter, generates a short review plan, and shows three inline buttons: confirm implementation, send a supplement, or cancel. Codex starts only after the confirm button is pressed.

- `OPENROUTER_API_KEY`: OpenRouter API key. Keep the real value only in server-side config such as `/etc/codex-ops/bot.env`.
- `OPENROUTER_API_KEY_FILE` (default: empty): optional path to a server-only file containing either the raw key or an `OPENROUTER_API_KEY=...` line.
- `OPENROUTER_SCAN_PROJECT_ENV` (default: `1`): when no key is configured directly, scan direct project env files under `PROJECTS_DIR` for `OPENROUTER_API_KEY` or `OPENROUTER_TOKEN`.
- `OPENROUTER_BASE_URL` (default: `https://openrouter.ai/api/v1`): OpenRouter API base URL.
- `OPENROUTER_STT_MODEL` (default: `openai/whisper-1`): speech-to-text model used for voice transcription.
- `OPENROUTER_PLAN_MODEL` (default: `openai/gpt-4o-mini`): chat model used to turn the transcript into a concise implementation plan. Set `none` or `off` to use the local fallback template.
- `OPENROUTER_TRANSCRIPTION_LANGUAGE` (default: empty): optional ISO-639-1 language hint, for example `ru`; empty lets the provider auto-detect.
- `OPENROUTER_TIMEOUT_MS` (default: `60000`): timeout for OpenRouter transcription and plan requests.
- `TELEGRAM_VOICE_MAX_BYTES` (default: `25000000`): max downloaded voice file size.
- `VOICE_DRAFT_TTL_MS` (default: `1800000`): how long an unconfirmed voice draft remains available for the inline buttons. Set `0` to disable expiration.

## Telegram output and anti-flood tuning

- `TELEGRAM_FORMAT` (default: `html`): output formatting mode. Use `html` to render Codex Markdown as Telegram-native bold, italic, links, inline code, and code blocks. Use `plain` to disable formatting.
- `MAX_MESSAGE` (default: `3500`): per-message chunk size (hard capped in code).
- `MAX_MESSAGE_CHUNKS` (default: `4`): max outbound chunks per response.
- `OUTBOUND_DELAY_MS` (default: `250`): delay between chunks.
- `TG_RETRY_ATTEMPTS` (default: `3`): retries for Telegram 429 responses.
- `TG_RETRY_FALLBACK_DELAY_MS` (default: `2000`): fallback wait when retry_after is absent.
- `TG_RETRY_MAX_WAIT_MS` (default: `120000`): max backoff wait.
- `TELEGRAM_POLL_ERROR_LOG_INTERVAL_MS` (default: `60000`): throttle for `getUpdates` failure logs in journald. Set `0` to log every polling failure.

## Auth flow tuning

- `CODEX_DEVICE_AUTH_TIMEOUT_MS` (default: `900000`): timeout for `/codex login` device auth flow.
- `CODEX_EXEC_TIMEOUT_MS` (default: `0`): timeout for `codex exec` runs in milliseconds. Set `0` to disable timeout and wait for real completion.
- `CODEX_MODEL_CATALOG_TIMEOUT_MS` (default: `30000`): timeout for reading the current Codex model catalog with `codex debug models`.
- `CODEX_PROGRESS_INTERVAL_MS` (default: `300000`): interval for "Codex progress update" Telegram messages while `codex exec` is still running. Set `0` to disable. Positive values below `60000` are raised to `60000`.
- `CODEX_PROGRESS_MAX_CHARS` (default: `1800`): max length of streamed assistant progress copied into each progress update. Tool transcripts, patch output, and diffs are filtered out of progress updates.
- `CODEX_STOP_KILL_GRACE_MS` (default: `10000`): grace period after `/codex stop` or `/codex steer` sends `SIGTERM`; after this, the bot sends `SIGKILL` if the managed process group is still alive.

## Codex task control

Long Codex runs execute in the background so the Telegram polling loop can still process control commands.

- Regular text requests sent while a Codex task is active are appended to an in-memory FIFO queue.
- Editing a queued Telegram text message or image caption before it starts updates that queued request.
- `/codex task`: show the currently active Codex task, phase, elapsed time, request summary, and pending queue.
- `/codex stop` or `/stop`: request emergency cancellation of the active task. The bot stops the child process and suppresses its final answer.
- `/codex steer <instruction>` or `/steer <instruction>`: stop the current process, then resume the latest Codex session with the new operator instruction. Steering is accepted only after the current Codex session has started.

Steering is implemented as interrupt plus `codex exec resume --last --all`. It is not live stdin injection into an already-running `codex exec` process.

## Final report context status

The bot prompt asks remote Codex runs to end final working reports with a concise context status footer.

This footer is intentionally qualitative:

- the bot can estimate the assembled prompt input size it controls
- the bot can label context pressure as low, medium, or high
- the bot cannot reliably know exact total context-window usage, exact percentage used, or exact remaining tokens unless Codex exposes those counters

Do not make the assistant invent exact context usage numbers. If exact counters are unavailable, the report should say that exact used and remaining context are unavailable.

## Codex model controls

Telegram model controls are stored in chat state, not in `config.toml`.

- `/codex settings`: show current model and reasoning settings.
- `/codex model`: list models from the current `codex debug models` catalog and show buttons.
- `/codex model <slug>`: set a Telegram model override for future `codex exec` runs in this chat.
- `/codex model default`: clear the model override and use Codex config/default behavior.
- `/codex reasoning`: list reasoning levels supported by the current model.
- `/codex reasoning <effort>`: set a Telegram reasoning override for future `codex exec` runs in this chat.
- `/codex reasoning default`: clear the reasoning override and use Codex config/model default behavior.

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
UPLOADS_DIR=/var/lib/codexops/state/uploads
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
TELEGRAM_IMAGE_MAX_BYTES=10000000
PENDING_IMAGE_TTL_MS=1800000
PENDING_IMAGE_MAX_ITEMS=4
OPENROUTER_API_KEY=<redacted>
OPENROUTER_STT_MODEL=openai/whisper-1
OPENROUTER_PLAN_MODEL=openai/gpt-4o-mini
TELEGRAM_VOICE_MAX_BYTES=25000000
VOICE_DRAFT_TTL_MS=1800000
CODEX_DEVICE_AUTH_TIMEOUT_MS=900000
CODEX_EXEC_TIMEOUT_MS=0
CODEX_MODEL_CATALOG_TIMEOUT_MS=30000
CODEX_PROGRESS_INTERVAL_MS=300000
CODEX_PROGRESS_MAX_CHARS=1800
CODEX_STOP_KILL_GRACE_MS=10000
```
