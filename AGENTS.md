# codex-ops Agent Notes

This repository builds a host-level Telegram operations bot for Codex CLI. When a user asks for behavior changes, assume they usually mean the Telegram bot and the remote `codex exec` sessions it launches, not the current local Codex chat.

## Project Vocabulary

- "bot" means the Telegram bot implemented in `bot.mjs`.
- "report", "final report", or "working report" usually means the final Telegram answer produced by a remote `codex exec` run.
- "progress update" means the periodic Telegram message generated while a long `codex exec` run is still active.
- "context" can mean several things. Clarify from code and surrounding task text before acting.
- Telegram chat history stored in `CHAT_STATE_FILE`.
- Project memory loaded from `/srv/codex-ops/projects/<project>/CONTEXT.md`, `RUNBOOK.md`, `CHANGELOG.md`, and `NOTES.md`.
- The assembled prompt sent to `codex exec` by `buildQuestionPrompt()`.
- The current local Codex conversation context inside this development session.

## Context Status Footer

If the user asks to show context usage at the end of each report, implement it for the Telegram bot's remote Codex reports unless they explicitly say they mean this local Codex chat.

The reliable implementation boundary is:

- The bot can estimate the assembled prompt input size it controls.
- The bot cannot know exact total model context-window usage, exact percentage used, or exact remaining tokens unless Codex exposes a reliable runtime counter.
- Do not fabricate exact context percentages or exact remaining-token numbers.
- Prefer a concise qualitative footer such as low, medium, or high context pressure, with approximate prompt input size if useful, and a note that exact used/remaining counters are unavailable.

Relevant code:

- `buildQuestionPrompt()` in `bot.mjs` assembles the remote Codex prompt.
- `formatHistory()` controls short Telegram history included in the prompt.
- `HISTORY_ITEMS`, `HISTORY_ITEM_CHARS`, and `HISTORICAL_INCIDENT_LIMIT` control memory size.

## Public Repository Hygiene

- Keep public docs and code in English and ASCII unless there is a strong reason otherwise.
- Never commit real secrets, private keys, tokens, `.env`, or server-only config.
- Do not overwrite `/etc/codex-ops/bot.env` during deploys.
- Hostinger runtime currently uses `/opt/codex-ops`, repo mirror `/var/lib/codexops/codex-ops-repo`, state `/var/lib/codexops/state`, and service `codex-telegram-bot.service`.
- Deploy to production only when the user asks for deploy/update.
