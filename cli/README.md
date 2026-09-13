# hapi CLI

Choose a supported coding agent from your terminal and control its sessions remotely through the hapi hub. See the [supported agents](../docs/guide/agents.md).

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
3. Run `hapi` to choose an agent, or `hapi <agent>` to start one directly.
4. Use the web app or Telegram Mini App to monitor and control.

## Commands

### Session commands

- `hapi` - Choose an agent interactively. Unavailable agents are shown with a reason and cannot be selected.
- `hapi claude` - Start a Claude Code session (passes through Claude CLI flags).
- `hapi codex` - Start Codex mode. See `src/codex/runCodex.ts`.
- `hapi codex resume <native-thread-id>` - Resume a Codex conversation by its native thread ID. For a HAPI session ID, use `hapi resume <id>`.
- `hapi cursor` - Start Cursor Agent mode. See `src/cursor/runCursor.ts`.
  Supports `hapi cursor resume <chatId>`, `hapi cursor --continue`, `--mode plan|ask`, `--yolo`, `--model`.
  Local and remote modes supported; new remote sessions use `agent acp`. Pre-ACP sessions retain the legacy `agent -p` stream-json resume path.
- `hapi grok` - Start Grok Build mode. See `src/grok/runGrok.ts`.
- `hapi copilot` - Start GitHub Copilot mode.
- `hapi kimi` - Start Kimi mode.
- `hapi agy` - Start Antigravity mode (remote-only).
- `hapi pi` - Start Pi mode (remote-only).
- `hapi opencode` - Start OpenCode mode via ACP. See `src/opencode/runOpencode.ts`.
  Note: OpenCode supports local and remote modes; local mode streams via OpenCode plugins.
- `hapi dsh` - Start DeepSeek Harness through ACP. See `src/dsh/runDsh.ts`.
  DSH is remote-only and its ACP server must be configured separately.
- `hapi resume [sessionId]` - List resumable sessions for this machine or resume one locally.
- `hapi ping-peer <session-id-prefix> <message>` - Resume (if needed) and message another session. Prefer this or MCP `ping_peer` / `list_peers` over reinventing JWT+curl. Also `--message-file` / `--list`.
- `hapi inspect-peer <session-id-or-prefix>` - Read-only peer metadata + recent message text (no resume). Prefer this or MCP `inspect_peer` when a user cites `[title](/sessions/<id>)` or Copy-reference `See session "…" (/sessions/<id>) for context`. `/sessions/<id>` is a hub path, not a local file. Optional `--limit`.
- `hapi job set|update|clear|list|run` - Attach long-running outliving work to a session so the list UI shows progress while the agent is idle (`tiann/hapi#1404`). Prefer `"$HAPI_SESSION_ID"`. Heartbeat via `update` (or `run`); honest `--remaining` or `--done`/`--total` (omit counts if unknown — never invent a percent). Late-attach clock fix: `set --started-at <epoch-ms>` or clear+set. See `docs/guide/session-jobs.md` and `hapi job --help`.

The picker lists agents alphabetically by command name. Use Up/Down and Enter
to choose; Esc or Ctrl-C cancels. It appears on every bare invocation, even
when only one agent is available. No default agent or selection is saved.

Scripts and non-interactive shells must specify an agent. Old implicit-Claude
commands such as `hapi --yolo`, `hapi --resume`, and `hapi "prompt"` now report
an error; use `hapi claude --yolo`, `hapi claude --resume`, or
`hapi claude "prompt"` instead.

`hapi --help`, `hapi -h`, and `hapi help` show only HAPI's help, without starting
a session or requiring an installed agent. `hapi --version` / `hapi -v` show
HAPI's version. Flags after an agent name are handled by that agent's existing
integration; supported flags vary by agent. HAPI does not translate or append
agent help text.

### Resume a remote session locally

```bash
hapi resume
hapi resume <session-id>
```

`hapi resume` lists resumable sessions for the current machine. `hapi resume <session-id>` hands off an active remote session and opens the same HAPI session in the local terminal.

For Codex, the terminal and Web stay usable at the same time. Closing the
original terminal stops a terminal-started run, but its history remains
resumable. Sessions started from the Web run under the Runner; closing a
terminal attached later does not stop them. **End session** archives the
selected conversation. See [Codex usage and limits](../docs/guide/codex-shared-sessions.md)
for details.

### Answer local Claude prompts from HAPI

In a local Claude session started by `hapi claude`, main-session `AskUserQuestion`
questions and tool permission prompts can also be answered from the web app.
The terminal dialog stays usable; answering does not restart Claude or switch
the session to remote mode. Claude arbitrates terminal/web races, and HAPI
records the native result rather than assuming the web response won.

The bridge uses Claude's `PermissionRequest` hook, not a blocking
`PreToolUse` approval gate. An unanswered remote request expires after one
hour; expiration, disconnection, or bridge failure leaves the native prompt
available. Local answers/cancellation, session changes, and mode switches
withdraw stale web controls. Cancellation detection may wait for the next
transcript scan.

Verified with Claude Code **2.1.221**. Background subagents, `ExitPlanMode`,
and requests that cannot be unambiguously matched to a native tool call remain
terminal-only. Earlier Claude versions have not been verified.

### Authentication

- `hapi auth status` - Show authentication configuration and token source.
- `hapi auth login` - Interactively enter and save CLI_API_TOKEN.
- `hapi auth logout` - Clear saved credentials.

See `src/commands/auth.ts`.

### Runner management

- `hapi runner start` - Replace any existing runner and start a detached process with the supplied flags/environment.
- `hapi runner stop` - Stop runner gracefully; agent sessions stay alive.
- `hapi runner start-sync` - Run in the foreground (for a process supervisor).
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

### Codex MCP servers

Codex sessions keep the MCP servers configured in the user's Codex
`config.toml`. HAPI adds its own `hapi` bridge without replacing other user
servers. When a runner spawn supplies a Codex auth token, it copies only
`config.toml` into a temporary `CODEX_HOME` and writes the supplied `auth.json`,
preserving MCP settings without copying unrelated authentication state.
Without a supplied token, Codex uses the runner's normal Codex home/auth.
The `hapi` server name is reserved by HAPI.

On Windows, known package-manager shims (`uvx`, `npx`, `npm`, `pnpm`, `yarn`,
`bunx`, and `.cmd`/`.bat` commands) use a short-lived HAPI stdio compatibility
proxy before reaching the configured MCP server. The proxy keeps the original
command and arguments in a session-temporary file and forwards MCP JSON-RPC
bytes without putting environment-variable values into arguments or that file.
Secret and network variables still need to be listed in the MCP entry's
`env_vars` (or supplied through `env`); HAPI does not forward the whole host
environment automatically.

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

### Optional

- `HAPI_API_URL` - Hub base URL (default: http://localhost:3006; also configurable as `apiUrl` in settings).
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
- `HAPI_RUNNER_WEBHOOK_TIMEOUT_MS` - Session-start webhook timeout in ms (default: 15000); raise for slow agent startup/resume.
- `HAPI_DISABLE_VERSION_HANDOFF` - Set to `1` to disable automatic runner replacement on CLI binary changes.
- `HAPI_RUNNER_SUPERVISED` - Set to `1` only when a supervisor restarts the runner after exit; enables the web Restart control's supervised path.

### Worktree (set by runner)

- `HAPI_WORKTREE_BASE_PATH` - Base repository path.
- `HAPI_WORKTREE_BRANCH` - Current branch name.
- `HAPI_WORKTREE_NAME` - Worktree name.
- `HAPI_WORKTREE_PATH` - Full worktree path.
- `HAPI_WORKTREE_CREATED_AT` - Creation timestamp (ms).

### Set for the wrapped agent

- `HAPI_SESSION_ID` - The current HAPI session ID, available inside agent shells. Use it in scripts that target the current conversation without listing sessions.
- An explicitly configured `HAPI_API_URL` is also made available to agent shells. HAPI does not copy settings-backed `CLI_API_TOKEN` secrets into the agent environment; credentials already present in the parent environment may still be inherited. Web terminal PTYs strip hub secrets.

For peer discovery and messaging, use the session's MCP `list_peers`,
`inspect_peer`, and `ping_peer` tools, or the corresponding CLI commands.
On a remote runner host, configure the matching hub URL and token so shell
commands reach the same hub (`hapi auth login` saves the token).

For example, this source-checkout helper displays an image in the current
session when MCP is unavailable:

```bash
bun scripts/tooling/hapi-display-image.mjs /absolute/path/to/image.png "optional title"
```

## Session lifecycle invariants

When changing agent bootstrap, handoff, or shared-session plumbing:

- Handoff-capable integrations use `local` (terminal) and `remote` (web-controlled) ownership modes. Codex instead supports concurrent clients without ownership switching; see [Codex shared sessions](../docs/guide/codex-shared-sessions.md).
- Ordinary wrappers export `HAPI_SESSION_ID` after bootstrap. Shared Codex uses a per-root MCP bridge and `shell_environment_policy.set.HAPI_SESSION_ID`; never put one root's ID into the shared app-server environment. Implementation: `src/codex/shared/root.ts`, `src/codex/shared/runtime.ts`.
- Gemini remains a historical wire flavor, not a launchable integration. Use the [supported-agent guide](../docs/guide/agents.md) for the launchable set.

## Storage

Data is stored in `~/.hapi/` (or `$HAPI_HOME`):

- `settings.json` - User settings (machineId, token, onboarding flag). See `src/persistence.ts`.
- `runner.state.json` - Runner state (pid, port, version, heartbeat).
- `logs/` - Log files.

## Requirements

- Install and authenticate the agent you want to use. Claude CLI (`claude` on PATH) is required only for `hapi claude`.
- Cursor Agent CLI installed (`agent` on PATH) for `hapi cursor`. Install: `curl https://cursor.com/install -fsS | bash` (macOS/Linux), `irm 'https://cursor.com/install?win32=true' | iex` (Windows).
- Grok Build CLI installed (`grok` on PATH) for `hapi grok`. Authenticate with `grok login --device-auth` on headless runner machines, or set `XAI_API_KEY`.
- OpenCode CLI installed (`opencode` on PATH).
- Bun 1.4.0 for building from source.

## Build from source

From the repo root:

```bash
bun install
bun run build:cli                 # Type-check the CLI; no executable output
bun run --cwd cli build:exe       # Host-platform executable in cli/dist-exe/<target>/
```

For an all-in-one binary that also embeds the web app:

```bash
bun run build:single-exe
```

## Source structure

- `src/api/` - Hub communication (Socket.IO + REST).
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
