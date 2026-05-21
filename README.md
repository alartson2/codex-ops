# codex-ops

Host-level Telegram operations bot for Codex CLI, designed for OpenClaw, remote agent systems, and general VPS operations.

## What this project does

`codex-ops` runs on the target host and gives you a stable operational channel in Telegram:

- ask Codex to investigate issues directly from the server
- build, inspect, and test remote agent systems where they actually run
- run targeted diagnostics (`/status`, `/diag openclaw`)
- send Telegram photos or image documents to Codex as visual context
- keep short per-chat context with project switching
- perform native Codex device login through Telegram (`/codex login`)
- protect Telegram from flood output with message chunk limits and safe fallback behavior
- receive periodic progress updates during long-running Codex tasks
- stop or steer a running Codex task from Telegram

## Why this exists

Modern agent systems are often easiest to build on the machine where they will actually run. They depend on real host paths, containers, credentials, services, logs, ports, cron jobs, systemd units, and production-like data. Recreating that environment locally can be slow, incomplete, or risky.

`codex-ops` turns a VPS into a remote Codex workbench controlled from Telegram. You can ask for changes, diagnostics, tests, and operational follow-up from anywhere, while Codex works directly inside the server context. This is especially useful for building multi-agent systems around OpenClaw: the agents, wrappers, logs, runtime state, and test surface all stay in one place instead of being split between a local laptop, SSH sessions, and a deployment target.

It also keeps the control layer outside the OpenClaw container. When OpenClaw or its runtime is unhealthy, diagnostics from inside the container may be hard to trust or hard to reach. `codex-ops` stays on the host, so incident response and repair work can continue even when the application layer is broken.

The goal is not to replace SSH completely. The goal is to make the common loop faster:

1. describe the task in Telegram
2. let Codex inspect the real server
3. receive progress updates while long tasks run
4. review the final result in Telegram
5. keep the useful context and changelog on the VPS

## Main features

- Telegram bot frontend with access control (`ALLOWED_CHAT_IDS`)
- Codex CLI integration (`codex exec`) for investigations and Q/A
- Telegram controls for Codex model and reasoning effort
- Native subscription device auth flow (`/codex login`)
- Persistent lightweight chat state and project-aware context
- Out-of-the-box project memory files (`CHANGELOG.md`, `NOTES.md`, context, and runbooks)
- OpenClaw-focused diagnostics and incident note generation
- Telegram image input for Codex vision-capable investigations
- Periodic progress updates for long-running Codex tasks
- Emergency task control with `/codex stop` and `/codex steer <instruction>`
- Telegram HTML rendering for Codex Markdown output
- 429-aware Telegram send retry logic and anti-flood truncation

## Common use cases

- Remote multi-agent system development: create and refine OpenClaw agents, wrappers, orchestration scripts, prompts, tools, and runtime glue directly on the VPS where they will execute.
- Mobile operations cockpit: run server checks, ask Codex to inspect logs, and receive final reports from Telegram without keeping an SSH session open.
- Production-adjacent test loops: change code, run commands, inspect service state, and verify behavior against real containers, ports, files, and systemd units.
- Out-of-band incident response: keep a host-level assistant available even when the OpenClaw application layer or container runtime is degraded.
- Long-running remote work: start larger Codex tasks from Telegram and receive periodic "Codex progress update" messages until the final answer arrives.
- Operator steering: interrupt a long task when priorities change, then resume the latest Codex session with new guidance instead of waiting for an outdated final answer.
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
- editing a queued Telegram text/caption before it starts updates that queued request
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
- `/codex task`
- `/codex stop`
- `/codex steer <instruction>`
- `/codex settings`
- `/codex model`
- `/codex model <slug|default>`
- `/codex reasoning`
- `/codex reasoning <effort|default>`
- `/codex login`
- `/codex login status`
- `/codex login cancel`

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
