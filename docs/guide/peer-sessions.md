---
description: "Let agents list, inspect, message and spawn other HAPI sessions with the peer tools, delivery modes (auto, queue, steer) and reply forwarding."
---

# Peer sessions

Agents running under HAPI can find, read, message, and start other HAPI sessions on the same hub and namespace. Use this to hand work to another agent, ask a session that already has the context, or split a task across several sessions and collect the answers.

The agent does this through four MCP tools that HAPI adds to the session. The same actions are available as `hapi` shell commands.

## The tools

| MCP tool | Shell fallback | What it does |
|----------|----------------|--------------|
| `list_peers` | `hapi ping-peer --list [--all]` | List peer sessions: id, active, busy/idle, agent, machine, working directory, name. Active sessions only unless `includeInactive` (`--all`). Default 30 rows, max 100. |
| `inspect_peer` | `hapi inspect-peer <id> [--limit N]` | Read a session's metadata and recent message text (default 30 messages, max 100). Read-only; it never resumes the session. |
| `ping_peer` | `hapi ping-peer <id> <message>` | Send a message to another session. |
| `spawn_peer` | `hapi spawn-peer --dir PATH --name TITLE <message>` | Create a new session and deliver its first message (the remit). |

Scripts and non-Node hosts can also call the MCP tools directly with `hapi peer-tool <tool>`: JSON arguments on stdin, the MCP tool result as JSON on stdout. See [CLI reference](./cli-reference.md#peer-sessions).

Sessions are addressed by id or a unique id prefix (8 characters is usually enough; the full UUID is best). Titles are only labels — the tools and the agent's instructions treat the UUID as the identity, so renaming a session never breaks a reference.

Inside a session, prefer the MCP tools. The shell commands use the CLI's own hub URL and token (`HAPI_API_URL` / `CLI_API_TOKEN`, or `~/.hapi/settings.json` from `hapi auth login`); on a runner that talks to a hub on another host, `list_peers` already works with the session's credentials while `hapi ping-peer --list` needs that configuration. See [Installation → Split hub + remote runner](./installation.md#split-hub-remote-runner-peer-discovery).

For Claude, `list_peers` is pre-approved; `inspect_peer`, `ping_peer`, and `spawn_peer` go through the normal permission prompt unless the session's permission mode auto-approves them.

## Pointing an agent at another session

You can cite a session in your message and the agent will read or message it:

- **Web, iOS, Android:** type `@` in the composer and pick a session. It is sent as a `[title](/sessions/<id>)` link.
- **Web:** **Copy reference** in a session's action menu copies `See session "…" (/sessions/<id>) for context`, which you can paste anywhere.

Agents are instructed that `/sessions/<id>` is a hub path, not a file, and to call `inspect_peer` with that id.

## Sending messages

`ping_peer` posts a message into the target session the same way a message from you would arrive.

### Delivery modes

| Mode | Behavior |
|------|----------|
| `auto` (default) | Steer into the target's current turn when it is active, mid-turn, and supports steering; otherwise queue. |
| `queue` | Add the message to the target's queue. It runs after the current turn, or starts a turn if the target is idle. |
| `steer` | Insert the message into the target's running turn. Refused, with nothing sent, if the target is inactive, idle, controlled from its local terminal, or its agent cannot steer. |

Steering is supported for remote Claude, Codex, OpenCode, Pi, Cursor ACP, and Antigravity (ACP) sessions. Steering does not abort the target's turn or guarantee an immediate answer. Use `steer` for findings the peer needs now, such as a correction or blocker; use `queue` for updates that can wait.

From the shell: `hapi ping-peer <id> <message> --delivery-mode auto|queue|steer`. Read the message from a file with `--message-file PATH`, or from stdin with `--message-file -`.

When `auto` cannot confirm a steer after the hub accepted the message, it keeps that one accepted message instead of sending it again, and the result says why it did not steer. If a send is unconfirmed, inspect the target before retrying.

### Inactive peers

`ping_peer` refuses an inactive target and sends nothing, unless you pass `wake: true` (shell: `--wake`). Waking resumes the session, waits for it to come online (default 60 s; `--wait SECONDS` or `HAPI_WAIT_ACTIVE_SECS`), then queues the message. The shell command exits with code 5 when it refuses an inactive target.

Agents are told to wake a peer only when you asked for it or the handed-off work requires that peer to act — never for status or "done" notes — and to message only peers tied to their task: a session you cited, their parent, or sessions they spawned. `list_peers` is a directory, not a broadcast list.

### Waiting for a reply

Pass `waitForReply: true` to `ping_peer` or `spawn_peer` and the calling agent can end its turn. When the peer's turn ends, HAPI posts the peer's latest reply back into the calling session as a new message, which starts the caller's next turn:

- If the peer took further messages before finishing, the reply to your task and the peer's latest reply are both included.
- If the task is canceled before it runs, or the peer stops without replying, the caller is told so.
- HAPI stops waiting after 6 hours and tells the caller to check the peer with `inspect_peer`.

Reply forwarding has no `hapi ping-peer` / `hapi spawn-peer` flag. Through MCP it runs inside the calling session's HAPI process: if that process exits first, the reply stays only in the peer session. `hapi peer-tool` hands it to a detached background process and returns at once. Pi peers do not report the end of a turn, so the tool returns immediately and asks the caller to check with `inspect_peer` instead.

## Spawning peers

`spawn_peer` creates a session and delivers a required first message. A session that ends up with no user message counts as a failed spawn and returns an error.

| Parameter | Shell flag | Notes |
|-----------|------------|-------|
| `directory` | `--dir` | Must exist on the target machine. Relative paths resolve against the calling session's working directory (MCP) or the shell's current directory (CLI). |
| `message` | message argument or `--message-file` | Required. |
| `name` | `--name` | Session title. Optional for MCP, required for the shell command. |
| `machine` | `--machine` | Runner UUID or hostname. Defaults to this machine. |
| `agent` | `--agent` | Agent to run. Defaults to the hub's peer spawn default, otherwise Claude. |
| `model`, `effort` | `--model`, `--effort` | Overrides for the resolved agent. |
| `sessionType` | `--session-type` | `simple` (default) uses the directory as is; `worktree` creates a new git worktree from it, so the directory must be a git repository. |
| `permissionMode` | `--permission-mode` | Defaults to the hub's peer spawn default (stock: yolo, mapped to each agent's auto-approve equivalent). Agents are told not to copy their own mode, only to tighten it or use one you name. |
| `waitForReply` | — | See [Waiting for a reply](#waiting-for-a-reply). |

### Parent stamp

When a session spawns a peer (MCP `spawn_peer`, or `hapi spawn-peer` with `HAPI_SESSION_ID` set), HAPI prepends a `## Parent` block to the remit with a `[title](/sessions/<uuid>)` link to the spawning session. The child can always find and message its parent by UUID, even after either session is renamed. The block is not added twice if the remit already cites the parent under `## Parent`. An in-session MCP spawn without a known parent session id is refused.

### Spawn defaults

**Settings → General → Agents** in the web app sets hub-wide defaults used by both New Session and peer spawns when the caller omits them: default agent, default permission mode, and a default model per agent. Without settings, peers start as Claude with the `sonnet` model in yolo mode. These settings are web-only.

## Which agents get the tools

| Agent | Peer tools |
|-------|------------|
| Claude | Local and remote |
| Codex | Local and remote |
| OpenCode | Local and remote |
| Pi | Yes |
| Cursor (ACP) | Remote |
| GitHub Copilot, Kimi, Grok | Remote |
| DeepSeek Harness | Offered over ACP; usable only if the configured DSH ACP server accepts MCP servers (see [Agents](./agents.md)) |
| Antigravity | Not offered. It can still receive messages, including steers, from other sessions. |

Any session can be the target of `ping_peer` and `inspect_peer`, whatever its agent.

## Disabling peer tools

Set `HAPI_DISABLE_PEER_TOOLS=1` (or `true` / `yes`) in the runner's environment to keep agents out of other sessions. The four tools are not registered, the peer instructions are dropped from agent system prompts, and `hapi ping-peer` / `inspect-peer` / `spawn-peer` run from inside a wrapped agent fail with an explicit error. Agents that see a pasted `/sessions/<id>` are told to ask you for the context instead. Your own terminal, without the variable, keeps full CLI access. See [Installation → Disabling peer tools on a runner](./installation.md#disabling-peer-tools-on-a-runner).

## Limits

- Peers must be on the same hub and namespace.
- `directory` must already exist on the target machine.
- Only one target per call. There is no broadcast.
- Do not create sessions with `POST /api/machines/:id/spawn` plus a message field — the hub rejects it. Use `spawn_peer`.
