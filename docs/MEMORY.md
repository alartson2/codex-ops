# Operational Memory

`codex-ops` gives Codex a small durable memory layer on the VPS. The goal is to keep useful project knowledge close to the system being built and operated, instead of relying only on Telegram history or a local notebook.

## Project files created out of the box

On bootstrap and bot startup, these files and directories are created for each project if they are missing:

- `/srv/codex-ops/projects/<project>/repo`: project-local git repository used as the default `codex exec` workspace.
- `/srv/codex-ops/projects/<project>/CONTEXT.md`: project-specific facts and scope.
- `/srv/codex-ops/projects/<project>/RUNBOOK.md`: project-specific operations checklist.
- `/srv/codex-ops/projects/<project>/CHANGELOG.md`: project-specific chronological memory for completed changes and planned-but-not-done work.
- `/srv/codex-ops/projects/<project>/NOTES.md`: project-specific durable notes, pitfalls, pending work, and decisions.

The default projects are `openclaw` and `server`. New projects created with `/project new <name>` get their own `repo`, `CONTEXT.md`, `RUNBOOK.md`, `CHANGELOG.md`, and `NOTES.md`.

If an older project directory does not have `repo` yet, the bot creates it automatically the next time that project is ensured, switched to, shown in context, or used for a Codex request. Repositories start without a git remote; until a remote is configured, Codex can commit locally but has nowhere to push.

Before sending a final Telegram report for a regular Codex request or steer resume, the bot checks the active project repository. If files changed, it stages all repository changes and creates a local snapshot commit. The report includes the commit hash when a snapshot was created. This is local-only unless the project repository has a remote and someone pushes it.

The host-level files `/srv/codex-ops/OPS_CONTEXT.md` and `/srv/codex-ops/RUNBOOK_OPENCLAW.md` are still used for broad operational context, but project history belongs in project memory.

## How Codex sees the memory

Each `codex exec` prompt includes:

- global ops context
- global runbook
- active project context
- active project runbook
- active project changelog
- active project notes
- recent Telegram chat history
- latest matching incident note

This lets Codex see both short-term conversation state and durable project memory.

The prompt also includes request-level context status metadata. This metadata is an estimate of the bot-controlled prompt input size, not an exact model context-window counter. Codex should use it for a qualitative final-report footer and should not invent exact used or remaining context numbers.

## What belongs in project CHANGELOG.md

Use the active project changelog for chronological state:

- what was changed
- what was fixed
- what was deployed
- what was intentionally not done
- what was planned but not completed yet
- important dates and versions

The bot prompt instructs Codex to write changelog updates to the active project's `CHANGELOG.md` unless the user explicitly gives another path. It also tells Codex not to create changelog files inside the incident directory.

## What belongs in project NOTES.md

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

The project changelog and notes files make that work recoverable. Codex can come back later, read the active project's memory, and continue from the actual operational history instead of starting from a blank prompt.
