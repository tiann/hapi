# hapi CLI

Run Claude Code, Codex, Cursor Agent, Gemini, or OpenCode sessions from your terminal and control them remotely through the hapi hub.

## What it does

- Starts Claude Code sessions and registers them with hapi-hub.
- Starts Codex mode for OpenAI-based sessions.
- Starts Cursor Agent mode for Cursor CLI sessions.
- Starts Gemini mode via ACP (Anthropic Code Plugins).
- Starts OpenCode mode via ACP and its plugin hook system.
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
- `hapi gemini` - Start Gemini mode via ACP. See `src/agent/runners/runAgentSession.ts`.
  Note: Gemini runs in remote mode only; it waits for messages from the hub UI/Telegram.
- `hapi opencode` - Start OpenCode mode via ACP. See `src/opencode/runOpencode.ts`.
  Note: OpenCode supports local and remote modes; local mode streams via OpenCode plugins.

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

Both `start` and `start-sync` accept `--workspace-root <path>` (or `--workspace-root=<path>`). When set:

- The web `/browse` page surfaces a scoped file tree rooted at that path.
- The runner refuses `list-directory` and `spawn-session` requests for paths outside the root.
- `~` and `~/foo` are expanded.

Omitting the flag keeps the legacy behavior: no scoping, no `/browse` feature.

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

### Required

- `CLI_API_TOKEN` - Shared secret; must match the hub. Can be set via env or `~/.hapi/settings.json` (env wins).
- `HAPI_API_URL` - Hub base URL (default: http://localhost:3006).

### Optional

- `HAPI_HOME` - Config/data directory (default: ~/.hapi).
- `HAPI_EXPERIMENTAL` - Enable experimental features (true/1/yes).
- `HAPI_EXTRA_HEADERS_JSON` - JSON object of extra headers to send on CLI → hub requests, e.g. `{"Cookie":"CF_Authorization=..."}`.
- `HAPI_CLAUDE_PATH` - Path to a specific `claude` executable.
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

## Storage

Data is stored in `~/.hapi/` (or `$HAPI_HOME`):

- `settings.json` - User settings (machineId, token, onboarding flag). See `src/persistence.ts`.
- `runner.state.json` - Runner state (pid, port, version, heartbeat).
- `logs/` - Log files.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH).
- Cursor Agent CLI installed (`agent` on PATH) for `hapi cursor`. Install: `curl https://cursor.com/install -fsS | bash` (macOS/Linux), `irm 'https://cursor.com/install?win32=true' | iex` (Windows).
- OpenCode CLI installed (`opencode` on PATH).
- Bun for building from source.

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
- `src/agent/` - Multi-agent support (Gemini via ACP).
- `src/opencode/` - OpenCode ACP + hook integration.
- `src/runner/` - Background service.
- `src/commands/` - CLI command handlers.
- `src/ui/` - User interface and diagnostics.
- `src/modules/` - Tool implementations (ripgrep, difftastic, git).

## Related docs

- `../hub/README.md`
- `../web/README.md`
