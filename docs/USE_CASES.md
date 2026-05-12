# Use Cases

`codex-ops` is useful when the target server is not just a deployment destination, but the real development and operations environment.

## Remote multi-agent system development

OpenClaw-based systems often have many moving parts:

- agent prompts and profiles
- wrappers around OpenClaw services
- server-side scripts and tools
- container-local files and logs
- host-level systemd, Docker, cron, and network state
- runtime credentials and environment variables that should not be copied to a laptop

`codex-ops` lets Codex inspect and modify that system in place, then report back through Telegram. This shortens the loop from "open laptop, SSH, remember paths, run commands, paste output" to "describe the task in Telegram and wait for the result".

## Build where it runs

Some systems are hard to reproduce locally because they depend on:

- real VPS paths and permissions
- mounted volumes
- long-lived state
- local-only service endpoints
- private credentials
- container networking
- production-like logs and data

In those cases, local development can create false confidence. `codex-ops` keeps the work close to the real runtime while still providing a conversational control surface.

## Telegram as an operations cockpit

Telegram becomes the lightweight UI for common server work:

- ask Codex to inspect a service
- run OpenClaw diagnostics
- check current project context
- switch project context
- request a runbook or latest incident note
- trigger native Codex login
- receive progress updates during long-running tasks

This is useful when you are away from your main workstation, using a phone, or working from a machine that does not have your full local setup.

## Long-running Codex tasks

Large tasks may take longer than a typical chat timeout. `codex-ops` can wait for real `codex exec` completion and send periodic progress updates while the task is still running.

This helps with work such as:

- large refactors on a VPS project
- multi-step diagnostics
- OpenClaw agent setup
- deployment audits
- changelog or documentation generation from live server context
- test-and-fix loops that need multiple commands

Progress updates are explicitly marked as non-final, so the operator can distinguish them from the final report.

## Out-of-band incident response

If OpenClaw is unhealthy, an assistant running inside the same application layer may be unavailable or misleading. `codex-ops` runs on the host, outside the OpenClaw container, so it can still:

- inspect Docker state
- read host logs
- inspect mounted files
- check ports and process trees
- write incident notes
- advise on safe recovery steps

This makes it a useful control plane during outages.

## Shared operational memory

The bot keeps lightweight chat history and project-aware context. It can also point Codex at runbooks, notes, incident archives, and a global changelog stored on the VPS.

This gives remote work a memory layer without requiring every detail to live in Telegram history or in a local-only notebook.

## Headless native Codex auth

Many VPS setups do not have a browser. `codex-ops` supports a Telegram-triggered Codex device login flow:

1. request `/codex login`
2. receive the device URL and one-time code in Telegram
3. approve login in a browser elsewhere
4. let the VPS keep using native Codex subscription auth

This avoids using API keys when the intended workflow is native Codex subscription authentication.

## Safer chat output for operations

Server commands and agent runs can generate too much output. `codex-ops` limits Telegram chunks, retries on Telegram rate limits, stores raw diagnostics in server files, and avoids dumping raw stdout/stderr into chat.

This keeps Telegram usable even when a command or Codex run produces noisy output.
