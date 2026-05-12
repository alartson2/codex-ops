# Operational Memory

`codex-ops` gives Codex a small durable memory layer on the VPS. The goal is to keep useful operational knowledge close to the system being built and operated, instead of relying only on Telegram history or a local notebook.

## Files created out of the box

On bootstrap and bot startup, these memory files are created if they are missing:

- `/srv/codex-ops/CHANGELOG.md`: global chronological memory for completed changes and planned-but-not-done work.
- `/srv/codex-ops/OPS_CONTEXT.md`: global host-level context.
- `/srv/codex-ops/RUNBOOK_OPENCLAW.md`: global OpenClaw runbook.
- `/srv/codex-ops/projects/<project>/CONTEXT.md`: project-specific facts and scope.
- `/srv/codex-ops/projects/<project>/RUNBOOK.md`: project-specific operations checklist.
- `/srv/codex-ops/projects/<project>/NOTES.md`: project-specific durable notes, pitfalls, pending work, and decisions.

The default projects are `openclaw` and `server`. New projects created with `/project new <name>` get their own `CONTEXT.md`, `RUNBOOK.md`, and `NOTES.md`.

## How Codex sees the memory

Each `codex exec` prompt includes:

- global ops context
- global runbook
- global changelog
- active project context
- active project runbook
- active project notes
- recent Telegram chat history
- latest matching incident note

This lets Codex see both short-term conversation state and durable server-side memory.

## What belongs in CHANGELOG.md

Use the global changelog for chronological state:

- what was changed
- what was fixed
- what was deployed
- what was intentionally not done
- what was planned but not completed yet
- important dates and versions

The bot prompt instructs Codex to write changelog updates to `GLOBAL_CHANGELOG_FILE` and not to create changelogs inside the incident directory unless explicitly requested.

## What belongs in NOTES.md

Use project notes for durable project knowledge:

- stable facts about the runtime
- known pitfalls
- architectural decisions
- pending work
- unfinished migration steps
- operational lessons that should survive chat history truncation

`NOTES.md` is project-scoped, so switching projects changes which notes are loaded into the prompt.

## Why this matters for remote agent systems

When multi-agent systems are built directly on a VPS, a lot of important information lives in the runtime:

- which agents were created
- which wrappers or tools were changed
- what was tested from Telegram
- what still needs to be tested
- what should not be repeated
- which server-specific paths, ports, and services matter

The changelog and notes files make that work recoverable. Codex can come back later, read the server-side memory, and continue from the actual operational history instead of starting from a blank prompt.
