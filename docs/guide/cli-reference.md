---
description: "Every hapi command and its main flags: agent launchers, hub, runner, auth, resume, peer tools, jobs, usage and diagnostics."
---

# CLI Reference

Every `hapi` command, its purpose and its main flags. Options for agent
commands go after the agent name. For environment variables, see
[Configuration](./configuration.md).

```bash
hapi                       # Choose an installed agent interactively
hapi <agent> [options]     # Start an agent session
hapi <command> [options]   # Run a HAPI command
hapi --help                # Short help (-h, help)
hapi --version             # Print the version (-v)
```

Running `hapi` with no arguments needs an interactive terminal. Scripts and
services must name the agent or command explicitly.

## Agent sessions

Each command starts the agent in the current directory and registers the
session with the hub. If `HAPI_API_URL` and `apiUrl` are unset, this machine
has run a hub before (its token is in `settings.json`), and nothing listens
on port 3006, the CLI starts a hub in the background for the duration of the
session. `hapi claude` also starts the runner if it is not running the
installed version.

| Command | Agent |
|---------|-------|
| `hapi claude` | Claude Code |
| `hapi codex` | OpenAI Codex |
| `hapi cursor` | Cursor Agent |
| `hapi copilot` | GitHub Copilot |
| `hapi grok` | Grok Build |
| `hapi opencode` | OpenCode |
| `hapi kimi` | Kimi Code |
| `hapi pi` | Pi |
| `hapi dsh` | DeepSeek Harness (ACP) |
| `hapi agy` | Antigravity |

`hapi gemini` only prints a notice: the Gemini CLI was retired in June 2026.
Existing Gemini sessions remain viewable.

See [Supported Agents](./agents.md) for installation, permission modes and
agent-specific behavior.

### Common flags

Support varies by agent. Claude, Codex and Cursor pass unknown flags through
to the agent; the other agents ignore them.

| Flag | Description |
|------|-------------|
| `--permission-mode <mode>` | Initial permission mode. Allowed values depend on the agent (for example Claude `default`, `acceptEdits`, `auto`, `bypassPermissions`, `plan`). Pi has none. |
| `--yolo` | Shortcut for the agent's auto-approve mode (`bypassPermissions`, `yolo` or `always-proceed`). Ignored when `--permission-mode` is given. |
| `--model <id>` | Model to start with. |
| `--effort <level>` | Reasoning effort, where the agent supports it. Codex uses `--model-reasoning-effort`; `hapi dsh` rejects it. |
| `--resume <id>` | Resume a native agent conversation. Codex uses `hapi codex resume` instead. |

### Per-agent flags

| Agent | Flags |
|-------|-------|
| Claude | Unknown flags pass through to `claude`, so `hapi claude --resume` and `--continue` work; when HAPI already owns that conversation, the existing HAPI session is reopened. `--dangerously-skip-permissions` is treated as `--yolo`. `--model=<id>` is accepted. |
| Codex | `--model-reasoning-effort <level>`, `--service-tier fast\|standard`, `--collaboration-mode default\|plan`, `--dangerously-bypass-approvals-and-sandbox` (same as `--yolo`). `hapi codex resume <thread-id>` or `hapi codex resume --last [--all]` resumes a native thread. `fork`, `exec`, `review`, `login` and `logout` must be run with native `codex`. |
| Cursor | `--mode <mode>`, `--plan`, `--force` (same as `--yolo`), `--auto-review`, `--cursor-worktree [name]`, `--cursor-add-dir <dir>` (repeatable), `--continue`. `hapi cursor resume <chat-id>` or `--resume <chat-id>` resumes a chat. |
| Copilot | `--copilot-agent-mode interactive\|plan\|autopilot` (alias `--mode`). |
| OpenCode | `-s` / `--session <id>` resumes an OpenCode session. |
| Pi | `--session-id <id>` resumes a Pi session. |
| DeepSeek Harness, Antigravity | Remote-only; there is no local terminal UI. The ACP server for `hapi dsh` is set with `HAPI_DSH_ACP_*`. |

Flags beginning with `--hapi-` and `--started-by`, `--existing-session-id`
are used internally when the runner spawns a session.

## Hub

### `hapi hub`

Starts the hub: API, web app, Socket.IO and notifications. `hapi server` is an
alias.

| Flag | Description |
|------|-------------|
| `--host <addr>` | Bind address (sets `HAPI_LISTEN_HOST`). Default `127.0.0.1`. |
| `--port <port>` | Port (sets `HAPI_LISTEN_PORT`). Default `3006`. |
| `--relay` | Expose the hub through the public relay tunnel and print a link and QR codes. |
| `--no-relay` | Disable the relay (the default). The last of `--relay` / `--no-relay` wins. |

`--host` and `--port` also accept `--host=<addr>` / `--port=<port>`. Like the
environment variables they set, they are saved to `settings.json` when
`listenHost` / `listenPort` is not set there yet, and later runs without the
flag keep the saved value. A flag always wins over the file for its run.

```bash
hapi hub --relay
hapi hub --host 0.0.0.0 --port 8080
```

See [Installation → Hub setup](./installation.md#hub-setup) and
[Deployment](./deployment.md).

## Runner

### `hapi runner`

Manages the background service that spawns sessions on request from the web
or native apps.

| Subcommand | Description |
|------------|-------------|
| `start` | Start the runner in the background. Stops an existing runner first, so new flags and environment take effect. |
| `start-sync` | Run the runner in the foreground. Use this under systemd, launchd or pm2. |
| `stop` | Stop the runner. Sessions keep running. |
| `status` | Show runner diagnostics. |
| `list` | List sessions the runner is tracking. |
| `stop-session <session-id>` | Stop one runner-managed session. |
| `logs` | Print the path of the latest runner log. |

`--workspace-root <path>` (repeatable, `~` expanded) restricts directory
browsing and spawning to the given directories. It applies to `start` and
`start-sync`. Running `hapi runner` without a subcommand prints help.

See [Installation → Runner setup](./installation.md#runner-setup).

## Sessions

### `hapi resume [session-id]`

Reopens an existing HAPI session on this machine in the terminal, with its
original agent and settings. Without an id it shows a picker; in a
non-interactive shell it prints the resumable sessions and exits. If the
session is running remotely, control is handed back to this terminal.

### `hapi set-mode <session> <mode>`

Changes the permission mode of a session, like the web permission picker.
Active sessions switch immediately; inactive sessions use it on next resume.
`<session>` may be an id prefix (8 characters is usually enough). An invalid
mode prints the allowed list.

### `hapi usage`

Shows when agents were working across every machine on the hub.

| Flag | Description |
|------|-------------|
| `--since <time>` | Window start: `30m`, `24h`, `7d`, an ISO date, or epoch milliseconds. Default: 24 hours ago. |
| `--until <time>` | Window end. Windows are at most 31 days. |
| `--json` | Machine-readable output (schema `hapi.activity.v1`). |

Exit codes: `2` bad arguments, `3` not signed in or refused, `4` hub too old,
`1` other errors.

### `hapi attach` / `hapi detach` (experimental, macOS)

Bridges HAPI to a thread already loaded in an external Codex app-server, such
as Codex Desktop, without taking ownership of it.

```bash
hapi attach --socket /absolute/path.sock --list           # List attachable threads
hapi attach <thread-id> --socket /absolute/path.sock [--new-view]
hapi detach <hapi-session-id>
```

`attach` runs in the foreground. Ctrl-C, `detach`, and ending the session in
HAPI disconnect HAPI only; the external thread keeps running.

## Peer sessions

These commands let one session, script or agent work with another session on
the same hub and namespace. Inside a session, agents should prefer the
equivalent MCP tools (`list_peers`, `inspect_peer`, `ping_peer`,
`spawn_peer`). All of them fail when `HAPI_DISABLE_PEER_TOOLS` is set.

### `hapi ping-peer`

Sends a message to another session, or lists sessions.

```bash
hapi ping-peer --list [--all]                    # Active sessions; --all adds inactive
hapi ping-peer <session> "<message>"
hapi ping-peer <session> --message-file <path|->  # - reads stdin
```

| Flag | Description |
|------|-------------|
| `--delivery-mode auto\|queue\|steer` | `auto` (default) steers an active turn when the target supports it, otherwise queues. `steer` requires an active turn; `queue` waits for the current turn. |
| `--wake` | Resume an inactive target first. Without it, inactive targets are refused (exit code 5). |

### `hapi inspect-peer <session>`

Reads another session's metadata and recent messages without changing it.
`--limit <n>` sets the number of messages. It does not resume inactive
sessions.

### `hapi spawn-peer`

Spawns a new session through a runner and delivers its first message, then
verifies the message arrived.

```bash
hapi spawn-peer --dir ~/project --name "Fix flaky test" --message-file -
```

| Flag | Description |
|------|-------------|
| `--dir <path>` | Working directory on the target machine (required). |
| `--name <title>` | Session name, 1–255 characters (required). |
| `--message-file <path\|->` | First message; or pass the text as a positional argument. |
| `--machine <id\|hostname>` | Target runner. Default: this machine. |
| `--agent <flavor>` | Agent. Default: the hub's peer spawn default, otherwise `claude`. |
| `--model <id>`, `--effort <level>` | Model and effort overrides. |
| `--session-type simple\|worktree` | `worktree` creates a new git worktree from `--dir`. Default `simple`. |
| `--permission-mode <mode>` | Default: the hub's peer spawn default (`yolo` unless changed). |
| `--wait <seconds>` | How long to wait for the session to become active. Default `60` or `HAPI_WAIT_ACTIVE_SECS`. |

When run inside a HAPI session, the first message is stamped with a link to
the parent session.

### `hapi peer-tool <name>`

Runs one of the peer MCP tools (`list_peers`, `inspect_peer`, `ping_peer`,
`spawn_peer`) with the same input schema and result as the in-session tool, so
scripts and non-Node hosts can call them without embedding the MCP server.
Arguments are a JSON object on stdin; the MCP tool result is printed as JSON on
stdout.

```bash
echo '{"includeInactive":true}' | hapi peer-tool list_peers
echo '{"sessionIdPrefix":"7d55ed21","message":"Build is green"}' | hapi peer-tool ping_peer
```

Exit code `0` on success, `1` when the result has `isError`, `2` on usage
errors (unknown tool, invalid JSON or arguments) or when
`HAPI_DISABLE_PEER_TOOLS` is set. `HAPI_SESSION_ID` identifies the calling
session (excluded from `list_peers`, Parent of `spawn_peer`, receiver of
`waitForReply` replies, which a detached background process forwards so the
command returns at once). Relative `spawn_peer` directories resolve against the
current directory, like `hapi spawn-peer`.

## Jobs

### `hapi job`

Attaches long-running work that outlives an agent turn to a session, so the
session list shows its progress while the agent is idle.

```bash
hapi job run <session> <key> --label <text> --progress unknown|fraction|until [...] -- <command>
hapi job set <session> <key> --label <text> --progress unknown|fraction|until [...]
hapi job update <session> <key> [--done N] [--total N] [--remaining N] [--status running|completed|failed]
hapi job clear <session> <key>
hapi job list <session>
```

`run` supervises the command, sends heartbeats and reports its exit status.
`--wake-on-terminal` resumes the owning session when the job completes or
fails. See [Session-attached jobs](./session-jobs.md) for when to attach a job,
which session id to use, and every flag.

## Setup and diagnostics

### `hapi auth`

| Subcommand | Description |
|------------|-------------|
| `login` | Prompt for the access token and save it to `settings.json`. Requires a terminal. |
| `status` | Show the hub URL, whether a token is set and where it comes from, the machine ID and host name. |
| `logout` | Remove the saved token and this machine's ID. |

See [Authentication](./authentication.md#cli-and-runner).

### `hapi doctor`

| Command | Description |
|---------|-------------|
| `hapi doctor` | Diagnostics report: versions, configuration, runner status, logs and relevant environment. |
| `hapi doctor clean` | Kill runaway HAPI processes. |
| `hapi doctor inline-media` | Check the image and media display bridge used by `display_image` / `display_media`. |

### `hapi mcp`

Starts a stdio MCP server that forwards HAPI tools (`change_title`,
`display_image`, `display_video`, `display_media`, the peer tools and
`session_job`) to a session's HTTP MCP endpoint.

| Flag | Description |
|------|-------------|
| `--url <url>` | Target HTTP MCP URL. Default: `HAPI_HTTP_MCP_URL`. |
| `--tools <a,b,...>` | Expose only these tools. |

HAPI configures this automatically for the agents it wraps; run it yourself
only to connect another MCP client.

## Internal and retired commands

| Command | Status |
|---------|--------|
| `hapi mcp-proxy`, `hapi hook-forwarder` | Used internally by wrapped agents. Not for direct use. |
| `hapi connect`, `hapi notify` | Retired; they print an error. Use the hub's [notifications](./notifications.md) instead of `notify`. |
| `hapi gemini` | Retired; prints a notice. |
