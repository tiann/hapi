# DeepSeek Harness (dsh)

HAPI integrates [DeepSeek Harness](https://deepseek.com/harness/) as a first-class
agent runtime. A HAPI `dsh` session spawns an official DSH host process on the
runner machine (loopback only, **no web UI**) and drives it through the same
official client wire protocol the DeepSeek Harness web app uses — so session-level
features (conversation, reasoning, tools, permissions, user questions, goals,
subagents, background jobs, workflows, produced files, plan mode, commands,
skills, agent presets, model selection) keep their native DSH semantics.

> HAPI replaces the outer frontend/session-management experience. DSH keeps the
> inner agent runtime; HAPI owns security, remote access, persistence, and
> cross-session control.

## Prerequisites

- **Node.js** (≥ 20) on the machine running the HAPI Runner. The DSH host loads
  NAPI modules (node-pty) that crash under Bun, so the host always runs under
  `node` even though HAPI itself may run under Bun.
- The DSH runtime is installed automatically on first use under
  `$HAPI_HOME/dsh-runtime` (pinned to `@deepseek-ai/dsh@0.1.0-rc.6`; bun install
  with npm fallback). Override the binary with `HAPI_DSH_RUNTIME_PATH`, disable
  auto-install with `HAPI_DSH_NO_INSTALL=1`.
- Model provider credentials for the DSH host come from the runner environment
  (e.g. `DEEPSEEK_API_KEY`) or from the DSH settings under `~/.dsh`
  (`DSH_HOME` can be overridden per session by HAPI configuration).

## Starting a session

1. Start Hub + Runner as usual.
2. Open HAPI Web → **New session** → choose **DeepSeek Harness**.
3. Pick a machine and directory; create the session.

HAPI spawns the HAPI CLI `dsh` runner, which spawns the host-only DSH runtime
(`dsh --profile web --patch <host-only overlay> --port <free loopback port>`),
connects over loopback, and maps the session:

```
HAPI session id  ⇄  DSH session id   (same UUID; official create-as-resume)
```

Resume/reopen reuses the recorded `dshSessionId` — the DSH host restores the
native JSONL session log from `~/.dsh` (idempotent `session.create`).

## Architecture

```
HAPI Web ──REST/SSE──► HAPI Hub ──Socket.IO/RPC──► HAPI CLI/Runner ──official HTTP+WS client──► DSH Host (127.0.0.1)
```

- **Web → Hub**: standard HAPI auth + REST. DSH actions are an allowlisted typed
  protocol (`DshActionSchema`) — no arbitrary method proxy.
- **Hub → CLI**: existing session-scoped Socket.IO RPC (`dsh-action`,
  `dsh-models`, `dsh-skills`).
- **CLI → DSH**: official `@deepseek-ai/dsh-host-apiproxy` wire contract
  (HTTP POST `/api/<endpoint>` + WebSocket `/api/events.mux|host`) via a
  Node transport subclassing the official `AbstractApiClient`.
- **Events**: native DSH session events are projected two ways — generic HAPI
  messages (text/reasoning/tool/usage, for list previews, notifications,
  search) and durable `dsh_native` / `dsh_state` payloads (tool trees,
  subagents, workflows, jobs, goal/plan/queue snapshots). Both persist in the
  hub; the web folds `dsh_state` with higher-seq-wins. `assistant/chunk`
  streams as live snapshots with stable ids (reconnect-safe).

## Security boundary

- The DSH host binds **127.0.0.1 only** on a HAPI-allocated port; no
  `--trusted-host` is configured; the web UI is stripped via the host-only
  overlay (GET `/` → 404).
- The port never reaches the browser. All actions go through HAPI auth and
  session-scoped RPC with Zod validation.
- Host-global DSH surfaces (settings, credentials, provider configuration,
  agent-preset authoring, native path opening) are **not** exposed remotely.
- Session ids are validated against the caller's namespace before any RPC.

## Supported features

| Feature | Status | Notes |
| ------- | ------ | ----- |
| Conversation (text/reasoning streaming, replay, errors) | Full | chunk-level streaming projected to live snapshots |
| Tool calls / results (incl. nested trees) | Full | native events persisted, generic cards rendered |
| Permission / approval | Full | allow-once / reject (official two-outcome vocabulary) |
| User questions | Full | single / multi / free-form + plan-review intent |
| Interrupt / steer / queue (edit/remove) | Full | official `session.cancel`, queue snapshots + actions |
| Model discovery / switch / reasoning effort | Full | runtime-discovered, never hardcoded |
| Plan mode + plan review | Full | plan-review question intent |
| Goals | Full | create / edit / pause / resume / complete / clear |
| Commands (slash) | Full | leading-`/` prompts |
| Skills | Full | leading-`/` reference + skill catalog |
| Subagents | Full | list / history / prompt / interrupt |
| Background jobs | Full | DSH-native jobs (separate from HAPI attached jobs) |
| Workflows | Full | native events + child navigation |
| Produced files / deliverables | Full | projection + native persistence |
| Attachments (images) | Full | HAPI upload transport, DSH image limits |
| Usage / context window | Full | `request/context` + usage projection |
| Agent presets | Partial | list + select (blank sessions); authoring intentionally omitted |
| Fork (at message) | Full | official `session.fork`, anchored by native event seq |
| Rewind (at message) | Full | implemented as fork + archive of the old session |
| Message feedback (comments) | Partial | put/list/delete via the official Typert gateway channel |
| Session export | Partial | HAPI view export works; native DSH log ZIP not yet wired |
| Terminal (agent PTY) | Intentionally omitted | DSH has no HAPI PTY; DSH terminal work surfaces via jobs |
| Handoff local | Intentionally omitted | no DSH terminal to hand off to |
| Credentials / provider settings | Intentionally omitted | host-privileged; configure on the runner |
| Agent-preset authoring | Intentionally omitted | host-privileged |
| Cross-session search (DSH) | Intentionally omitted | HAPI search replaces it |

## Troubleshooting

- **"DSH runtime missing / install failed"** — check `$HAPI_HOME/dsh-runtime`;
  run `hapi doctor`. The host needs Node.js; bun-only machines must install Node.
- **"DSH host exited before readiness"** — check the stderr tail in the session
  error message; common causes: missing model credentials, port collision
  (retry picks a new port), or an incompatible DSH release (HAPI pins
  `0.1.0-rc.6`).
- **Model calls fail** — the DSH host reads credentials from its environment or
  `~/.dsh` settings. Set `DEEPSEEK_API_KEY` (or the provider's key) on the
  runner.
- **Resume shows an empty session** — verify `metadata.dshSessionId` is set;
  the DSH store lives under `DSH_HOME` (default `~/.dsh`).

## DSH version pin

All `@deepseek-ai/*` packages are pinned to `0.1.0-rc.6` (npm `latest`). The
DSH protocol is a developer preview and changes fast — breaking changes are
absorbed inside `cli/src/dsh/` (the HapiDshAdapter boundary); update the pin
and the host-only overlay together.
