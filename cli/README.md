# hapi CLI

Run Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, or DeepSeek Harness sessions from your terminal and control them remotely through the hapi hub.

## What it does

- Starts Claude Code sessions and registers them with hapi-hub.
- Starts Codex mode for OpenAI-based sessions.
- Starts Cursor Agent mode for Cursor CLI sessions.
- Starts Grok Build locally or via ACP for remote sessions.
- Starts OpenCode mode via ACP and its plugin hook system.
- Starts DeepSeek Harness through an external ACP stdio server.
- Provides an MCP stdio bridge for external tools.
- Manages a background runner for long-running sessions.
- Includes diagnostics and auth helpers.

## Typical flow

1. Start the hub and set env vars (see ../hub/README.md).
2. Set the same CLI_API_TOKEN on this machine or run `hapi auth login`.
3. Run `hapi` to start a session.
4. Use the web app or Telegram Mini App to monitor and control.

## Commands

### Session commands

- `hapi` - Start a Claude Code session (passes through Claude CLI flags). See `src/index.ts`.
- `hapi codex` - Start Codex mode. See `src/codex/runCodex.ts`.
- `hapi codex resume <sessionId>` - Resume existing Codex session.
- `hapi cursor` - Start Cursor Agent mode. See `src/cursor/runCursor.ts`.
  Supports `hapi cursor resume <chatId>`, `hapi cursor --continue`, `--mode plan|ask`, `--yolo`, `--model`.
  Local and remote modes supported; remote uses `agent -p` with stream-json.
- `hapi grok` - Start Grok Build mode. See `src/grok/runGrok.ts`.
- `hapi opencode` - Start OpenCode mode via ACP. See `src/opencode/runOpencode.ts`.
  Note: OpenCode supports local and remote modes; local mode streams via OpenCode plugins.
- `hapi dsh` - Start DeepSeek Harness through ACP. See `src/dsh/runDsh.ts`.
  DSH is remote-only and its ACP server must be configured separately.
- `hapi resume [sessionId]` - List resumable sessions for this machine or resume one locally.
- `hapi ping-peer <session-id-prefix> <message>` - Resume (if needed) and message another session. Prefer this or MCP `ping_peer` / `list_peers` over reinventing JWT+curl. Also `--message-file` / `--list`.
- `hapi inspect-peer <session-id-or-prefix>` - Read-only peer metadata + recent message text (no resume). Prefer this or MCP `inspect_peer` when a user cites `[title](/sessions/<id>)` or Copy-reference `See session "…" (/sessions/<id>) for context`. `/sessions/<id>` is a hub path, not a local file. Optional `--limit`.

### Resume a remote session locally

```bash
hapi resume
hapi resume <session-id>
```

`hapi resume` lists resumable sessions for the current machine. `hapi resume <session-id>` hands off an active remote session and opens the same HAPI session in the local terminal.

### Authentication

- `hapi auth status` - Show authentication configuration and token source.
- `hapi auth login` - Interactively enter and save CLI_API_TOKEN.
- `hapi auth logout` - Clear saved credentials.

See `src/commands/auth.ts`.

### Runner management

- `hapi runner start` - Start runner as detached process.
- `hapi runner stop` - Stop runner gracefully.
- `hapi runner status` - Show runner diagnostics.
- `hapi runner list` - List active sessions managed by runner.
- `hapi runner stop-session <sessionId>` - Terminate specific session.
- `hapi runner logs` - Print path to latest runner log file.

Both `start` and `start-sync` accept repeatable `--workspace-root <path>` (or `--workspace-root=<path>`). When set:

- The web `/browse` page surfaces scoped file trees rooted at those paths.
- The runner refuses `list-directory` and `spawn-session` requests for paths outside the configured roots.
- `~` and `~/foo` are expanded.

Omitting the flag keeps manual session spawning unrestricted and leaves the
web `/browse` feature disabled. Machine directory lookups used by session
autocomplete and native pickers are still available, but are limited to the
runner's home directory.

See `src/runner/run.ts`.

### Diagnostics

- `hapi doctor` - Show full diagnostics (version, runner status, logs, processes).
- `hapi doctor clean` - Kill runaway HAPI processes.

See `src/ui/doctor.ts`.

### Other

- `hapi mcp` - Start MCP stdio bridge. See `src/codex/happyMcpStdioBridge.ts`.
- `hapi hub` - Start the bundled hub (single binary workflow).
- `hapi server` - Alias for `hapi hub`.

## Configuration

See `src/configuration.ts` for all options.

DeepSeek Harness ACP uses `dsh-acp-demo` by default. Override the executable or
its arguments without shell parsing:

```bash
export HAPI_DSH_ACP_COMMAND=dsh-acp-demo
export HAPI_DSH_ACP_CONFIG=/path/to/deepseek-harness/examples/acp-agent/cordis.yml
hapi dsh
```

For a source checkout, use JSON arguments:

```bash
export HAPI_DSH_ACP_COMMAND=pnpm
export HAPI_DSH_ACP_ARGS_JSON='["--dir", "/path/to/deepseek-harness", "run", "demo:acp"]'
```

The official ACP demo is fresh-session-only and does not support native resume,
model switching, MCP injection, or live tool/reasoning telemetry. HAPI uses the
standard chat and pending one-shot permission surfaces; the ACP composition
owns the overall permission policy and HAPI does not advertise resume or model
controls for DSH.

### Required

- `CLI_API_TOKEN` - Shared secret; must match the hub. Can be set via env or `~/.hapi/settings.json` (env wins).
- `HAPI_API_URL` - Hub base URL (default: http://localhost:3006).

### Optional

- `HAPI_HOME` - Config/data directory (default: ~/.hapi).
- `HAPI_EXPERIMENTAL` - Enable experimental features (true/1/yes).
- `HAPI_EXTRA_HEADERS_JSON` - JSON object of extra headers to send on CLI → hub requests, e.g. `{"Cookie":"CF_Authorization=..."}`. Can also be set as the `extraHeaders` object in `~/.hapi/settings.json` (environment variable wins).
- `HAPI_CLAUDE_PATH` - Path to a specific `claude` executable.
- `HAPI_DSH_ACP_COMMAND` - ACP server executable for `hapi dsh` (default: `dsh-acp-demo`).
- `HAPI_DSH_ACP_CONFIG` - Optional `dsh-acp-demo --config` path.
- `HAPI_DSH_ACP_ARGS_JSON` - Optional JSON array of ACP server arguments.
- `HAPI_HTTP_MCP_URL` - Default MCP target for `hapi mcp`.

### Runner

- `HAPI_RUNNER_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 60000).
- `HAPI_RUNNER_HTTP_TIMEOUT` - HTTP timeout for runner control in ms (default: 10000).

### Worktree (set by runner)

- `HAPI_WORKTREE_BASE_PATH` - Base repository path.
- `HAPI_WORKTREE_BRANCH` - Current branch name.
- `HAPI_WORKTREE_NAME` - Worktree name.
- `HAPI_WORKTREE_PATH` - Full worktree path.
- `HAPI_WORKTREE_CREATED_AT` - Creation timestamp (ms).

### Set for the wrapped agent

- `HAPI_SESSION_ID` - The hub session id for the current run, exported into the wrapped agent/CLI child environment at spawn for every flavor (claude / codex / copilot / cursor / gemini / opencode / kimi / grok / pi), both runner-spawned and locally started sessions. Agents can read it to self-target "this chat" over the hub REST API or shell helpers without listing `/api/sessions`. Prefer the MCP `display_image` tool for inline media when it is available; use `HAPI_SESSION_ID` for hub REST / shell tooling where MCP is not. To **list** peers on the same hub/namespace, prefer MCP `list_peers` (works from runner-spawned sessions without sitting on the hub host; excludes the calling session). To **read** another session, prefer MCP `inspect_peer` or `hapi inspect-peer`. To **message** another session, prefer MCP `ping_peer` or `hapi ping-peer` — do not reinvent JWT+curl. User citations look like `[title](/sessions/<id>)` or Copy-reference `See session "…" (/sessions/<id>) for context`; pass that `<id>` as `sessionIdPrefix`. Do not Grep/Glob `/sessions/<id>` as a local filesystem path. On a remote runner, configure matching `HAPI_API_URL` + `CLI_API_TOKEN` (or `hapi auth login` / `~/.hapi/settings.json`) on the runner host so shell `hapi ping-peer --list` works; session CLI may export an explicit non-default hub URL into child env, but never mirrors `CLI_API_TOKEN` into wrapped agents.

  Lazy Codex (terminal) sessions export the id only after the hub row is materialized, which happens when the MCP bridge starts — before the agent process is spawned — so path-only self-targeting does not race a missing hub row.

  Example (shell fallback when MCP is unavailable) — path-only, self-targets the current session:

  ```bash
  bun scripts/tooling/hapi-display-image.mjs /absolute/path/to/image.png "optional title"
  ```

  Explicit other session (prefix or full uuid) still works; that path may list sessions.

## Storage

Data is stored in `~/.hapi/` (or `$HAPI_HOME`):

- `settings.json` - User settings (machineId, token, onboarding flag). See `src/persistence.ts`.
- `runner.state.json` - Runner state (pid, port, version, heartbeat).
- `logs/` - Log files.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH).
- Cursor Agent CLI installed (`agent` on PATH) for `hapi cursor`. Install: `curl https://cursor.com/install -fsS | bash` (macOS/Linux), `irm 'https://cursor.com/install?win32=true' | iex` (Windows).
- Grok Build CLI installed (`grok` on PATH) for `hapi grok`. Authenticate with `grok login --device-auth` on headless runner machines, or set `XAI_API_KEY`.
- OpenCode CLI installed (`opencode` on PATH).
- Bun 1.4.0 for building from source.

## Build from source

From the repo root:

```bash
bun install
bun run build:cli
bun run build:cli:exe
```

For an all-in-one binary that also embeds the web app:

```bash
bun run build:single-exe
```

## Source structure

- `src/api/` - Bot communication (Socket.IO + REST).
- `src/claude/` - Claude Code integration.
- `src/codex/` - Codex mode integration.
- `src/cursor/` - Cursor Agent integration.
- `src/grok/` - Grok Build native TUI + ACP integration.
- `src/agent/` - Shared support for ACP-compatible agents.
- `src/opencode/` - OpenCode ACP + hook integration.
- `src/runner/` - Background service.
- `src/commands/` - CLI command handlers.
- `src/ui/` - User interface and diagnostics.
- `src/modules/` - Tool implementations (ripgrep, difftastic, git).

## Related docs

- `../hub/README.md`
- `../web/README.md`
