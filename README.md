# codex-ops

Host-level Telegram operations bot for Codex CLI, designed for remote agent systems and general VPS operations.

## What this project does

`codex-ops` runs on the target host and gives you a stable operational channel in Telegram:

- ask Codex to investigate issues directly from the server
- build, inspect, and test remote agent systems where they actually run
- run targeted diagnostics (`/status`, `/diag [project]`)
- send Telegram photos or image documents to Codex as visual context
- send Telegram voice messages for OpenRouter transcription and pre-run plan review
- keep short per-chat context with project switching
- share one bot across multiple allowed Telegram chats, with separate lightweight chat sessions
- perform native Codex device login through Telegram (`/codex login`)
- protect Telegram from flood output with message chunk limits and safe fallback behavior
- receive periodic progress updates during long-running Codex tasks
- stop or steer a running Codex task from Telegram

## Why this exists

Modern agent systems are often easiest to build on the machine where they will actually run. They depend on real host paths, containers, credentials, services, logs, ports, cron jobs, systemd units, and production-like data. Recreating that environment locally can be slow, incomplete, or risky.

`codex-ops` turns a VPS into a remote Codex workbench controlled from Telegram. You can ask for changes, diagnostics, tests, and operational follow-up from anywhere, while Codex works directly inside the server context. This is especially useful for building remote agent systems: the agents, wrappers, logs, runtime state, and test surface all stay in one place instead of being split between a local laptop, SSH sessions, and a deployment target.

It also keeps the control layer outside the application runtime it operates. When an application or container is unhealthy, diagnostics from inside that runtime may be hard to trust or hard to reach. `codex-ops` stays on the host, so incident response and repair work can continue even when the application layer is broken.

The goal is not to replace SSH completely. The goal is to make the common loop faster:

1. describe the task in Telegram
2. let Codex inspect the real server
3. receive progress updates while long tasks run
4. review the final result in Telegram
5. keep the useful context and changelog on the VPS

## Main features

- Telegram bot frontend with access control (`ALLOWED_CHAT_IDS`)
- Multi-chat mode for trusted operators, with per-chat session history, active project, pending images, and model settings
- Codex CLI integration (`codex exec`) for investigations and Q/A
- Telegram controls for Codex model and reasoning effort
- Native subscription device auth flow (`/codex login`)
- Persistent lightweight chat state and project-aware context
- Out-of-the-box project memory files (`CHANGELOG.md`, `NOTES.md`, context, and runbooks)
- Per-project git repositories rooted at `/srv/codex-ops/projects/<project>`
- Automatic local git snapshot commits, with auto-push when `origin` is configured, before final Telegram reports
- Telegram project remote setup flow with generated deploy keys
- Durable host/scheduled request queues for autonomous follow-up work outside deploy-managed code
- Project-aware diagnostics and incident note generation
- Telegram image input for Codex vision-capable investigations
- Telegram voice input with transcript review, implementation confirmation, supplements, and cancel
- Periodic progress updates for long-running Codex tasks
- Emergency task control with `/codex stop` and `/codex steer <instruction>`
- Ambiguity guardrail: when Codex is unsure about the target project, environment, or requested change, it should ask a concise question or return a short plan before making changes
- Context status guidance for final remote Codex reports
- Telegram HTML rendering for Codex Markdown output
- 429-aware Telegram send retry logic and anti-flood truncation

## Common use cases

- Remote multi-agent system development: create and refine agents, wrappers, orchestration scripts, prompts, tools, and runtime glue directly on the VPS where they will execute.
- Mobile operations cockpit: run server checks, ask Codex to inspect logs, and receive final reports from Telegram without keeping an SSH session open.
- Production-adjacent test loops: change code, run commands, inspect service state, and verify behavior against real containers, ports, files, and systemd units.
- Out-of-band incident response: keep a host-level assistant available even when an application layer or container runtime is degraded.
- Long-running remote work: start larger Codex tasks from Telegram and receive periodic "Codex progress update" messages until the final answer arrives.
- Operator steering: interrupt a long task when priorities change, then resume the latest Codex session with new guidance instead of waiting for an outdated final answer.
- Multi-operator access: attach several trusted Telegram chats to the same host bot while keeping their lightweight chat sessions separate.
- Shared operational memory: keep lightweight project context, runbooks, incident notes, and project changelogs on the server instead of scattering them across local machines.
- Native Codex subscription auth on headless hosts: start device login from Telegram and complete browser confirmation elsewhere.
- Safer Telegram output: convert Codex Markdown to Telegram-native formatting while limiting message chunks and avoiding raw stdout/stderr floods.

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
- normal text message while Codex is busy: queue the request
- photo/image with caption: ask Codex about that image
- photo/image without caption: save it for the next text question
- voice message: transcribe through OpenRouter, show a plan, then wait for confirm/supplement/cancel
- editing a queued Telegram text/caption before it starts updates that queued request
- `/ask <question>`
- `/status`
- `/diag [project]`
- `/lastincident [project]`
- `/runbook [project]`
- `/projects`
- `/project <name>`
- `/project new <name>`
- `/project key`
- `/project remote`
- `/project remote <git-url>`
- `/context show`
- `/session reset`
- `/codex task`
- `/codex stop`
- `/codex steer <instruction>`
- `/codex settings`
- `/codex model`
- `/codex model <slug|default>`
- `/codex reasoning`
- `/codex reasoning <effort|default>`
- `/codex login`
- `/codex login keep`
- `/codex login status`
- `/codex login cancel`

## Multi-user mode

`codex-ops` can serve several trusted Telegram chats from one bot instance by listing multiple chat IDs in `ALLOWED_CHAT_IDS`.

What is isolated per Telegram chat:

- active project selection
- recent lightweight chat history
- pending image attachments
- Codex model and reasoning overrides

What is shared by the bot instance:

- project repositories rooted at `/srv/codex-ops/projects/<project>`
- project memory files (`CONTEXT.md`, `RUNBOOK.md`, `CHANGELOG.md`, `NOTES.md`)
- the single active Codex worker and FIFO task queue
- Codex authentication, host permissions, environment, and service account

When another allowed chat has the active Codex task, `/codex task` only reports that another chat is busy and shows this chat's own queue. It does not show the other chat's request text.

Use one shared instance for trusted operators working on the same host and project memory. Use separate bot instances, state directories, project directories, Codex homes, and preferably separate service users when operators should not share repository state, credentials, task queue, or long-term memory.

## Documentation

- [Use cases](docs/USE_CASES.md)
- [Operational memory](docs/MEMORY.md)
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
