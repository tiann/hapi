# Supported Agents

HAPI is a wrapper around AI coding agents. One CLI (`hapi <agent>`) starts any supported agent locally and exposes the same session for remote control from the web app, PWA, and Telegram — with permission prompts, message queueing, and seamless handoff between terminal and phone.

## Support matrix

| Agent | Command | Integration | Local | Remote | Permission modes | Resume |
|-------|---------|-------------|:-----:|:------:|------------------|:------:|
| Claude Code | `hapi` / `hapi claude` | Terminal wrapper (local) + Claude Agent SDK (remote) | ✓ | ✓ | `default` `acceptEdits` `auto` `bypassPermissions` `plan` | ✓ |
| Codex | `hapi codex` | TUI wrapper (local) + `codex app-server` JSON-RPC (remote) | ✓ | ✓ | `default` `read-only` `safe-yolo` `yolo` (+ `plan` collaboration mode) | ✓ |
| Cursor Agent | `hapi cursor` | ACP (`agent acp`); legacy stream-json resume | ✓ | ✓ | `default` `plan` `ask` `debug` `autoReview` `yolo` | ✓ |
| Grok Build | `hapi grok` | ACP (`grok agent stdio`) | ✓ | ✓ | `default` `auto` `plan` `bypassPermissions` | ✓ |
| GitHub Copilot | `hapi copilot` | ACP (`copilot --acp --stdio`) | ✓ | ✓ | `default` `read-only` `safe-yolo` `yolo` | ✓ |
| Kimi | `hapi kimi` | ACP (`kimi acp`) | ✓ | ✓ | `default` `read-only` `safe-yolo` `yolo` | ✓ |
| OpenCode | `hapi opencode` | ACP (`opencode acp`) | ✓ | ✓ | `default` `plan` `yolo` | ✓ |
| DeepSeek Harness | `hapi dsh` | ACP (`dsh-acp-demo` or configured server) | — | ✓ | Managed by DSH ACP composition | — |
| Antigravity (agy) | `hapi agy` | Headless print mode (per-turn `agy -p` + NDJSON) | — | ✓ | `request-review` `always-proceed` | ✓ |
| Pi | `hapi pi` | `pi --mode rpc` (JSON-line RPC over stdio) | — | ✓ | none (always auto-approve) | ✓ |
| Gemini CLI | — | **Removed** — Google sunset the consumer Gemini CLI (2026-06-18) | — | — | — | — |

Gemini is no longer launchable: `hapi gemini` is kept as a tombstone command that prints a clear error, and existing Gemini sessions remain viewable in the web UI but cannot be resumed.

## Common concepts

### ACP

Most remote integrations speak the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) over stdio through a shared HAPI backend. ACP gives remote sessions bidirectional permission approval, plan/todo updates, question UI, model catalogs, and session resume via `session/load`. Cursor, Grok, Copilot, Kimi, OpenCode, and DeepSeek Harness remote sessions all run over ACP. DSH's official ACP server is intentionally automation-only and currently supports fresh sessions, committed assistant output, cancellation, and one-shot permissions; it does not provide native resume, model switching, MCP injection, or live tool/reasoning telemetry.

### Permission modes

Permission modes are per-agent — each flavor exposes its own set (see the matrix above). Set the mode at launch with `--permission-mode <mode>` or a shortcut flag (`--yolo`, `--plan`, `--auto-review`, depending on the agent), and switch it mid-session from the web UI. Semantics vary per agent; see the per-agent sections below.

### Local and remote mode

Every session is either **local** (driven from the terminal) or **remote** (driven from web/phone). DSH is remote-only because its ACP server has no local terminal surface. Switching is seamless and keeps the same session state for flavors that support both:

- **Remote → local:** press double-space in the terminal.
- **Local → remote:** send a message from the web UI or phone; the session switches automatically.

See [Seamless Handoff](./how-it-works.md#seamless-handoff) for details.

### Resuming sessions

```bash
hapi resume                # Interactive picker of resumable sessions on this machine
hapi resume <session-id>   # Resume a specific HAPI session
```

`hapi resume` works for every resumable flavor except Gemini and fresh-session-only DSH. An active remote session is handed off to the local terminal first. Pi and Antigravity are the exceptions in the other direction: neither has a local input path, so their sessions always resume in remote mode.

## Cursor Agent

HAPI supports [Cursor Agent CLI](https://cursor.com/docs/cli/using) for running Cursor's AI coding agent with remote control via web and phone.

When Cursor resumes mid-idle (for example after a Shell `notify_on_output` wake) and emits ACP activity, HAPI bumps session thinking over the normal `session-alive` keepalive so the list does not stay stuck idle. See [FAQ](./faq.md#why-did-my-session-look-idle-when-the-agent-woke-itself).

### Prerequisites

Install Cursor Agent CLI:

- **macOS/Linux:** `curl https://cursor.com/install -fsS | bash`
- **Windows:** `irm 'https://cursor.com/install?win32=true' | iex`

Verify installation:

```bash
agent --version
```

### Usage

```bash
hapi cursor                    # Start Cursor Agent session
hapi cursor resume <chatId>    # Resume a specific chat
hapi cursor --continue         # Resume the most recent chat
hapi cursor --plan             # Start in Plan mode (shortcut)
hapi cursor --mode plan        # Start in Plan mode
hapi cursor --mode ask         # Start in Ask mode
hapi cursor --auto-review      # Start with Auto-review (Smart Auto)
hapi cursor --yolo             # Bypass approval prompts (--force)
hapi cursor --model <model>    # Specify model
hapi cursor --cursor-worktree              # Cursor-native worktree (auto-named)
hapi cursor --cursor-worktree feature-x    # Cursor-native worktree (named)
hapi cursor --cursor-add-dir ../shared     # Extra workspace root (repeatable)
```

### Permission modes

| Mode | Description |
|------|-------------|
| `default` | Standard agent behavior |
| `plan` | Plan mode - design approach before coding |
| `ask` | Ask mode - explore code without edits |
| `debug` | Debug mode - hypotheses + instrumentation |
| `autoReview` | Auto-review (Smart Auto) - allowlist/sandbox/classifier instead of full YOLO |
| `yolo` | Bypass approval prompts |

Set mode via `--plan` / `--mode` / `--permission-mode` / `--auto-review`, or change from the web UI during a session.

### Cursor-native worktree & multi-root

- New Session **Worktree** for Cursor uses Cursor's `--worktree` (`~/.cursor/worktrees/<repo>/<name>`), not HAPI's sibling-directory worktree.
- Exception: if the spawn `directory` is **already** a linked git worktree (HAPI feature worktree, `driver/`, etc.), the runner does **not** pass `--cursor-worktree` — nesting hangs ACP initialize ([#1085](https://github.com/tiann/hapi/issues/1085)). Use the directory as cwd instead.
- Mid-session: send `/worktree`, `/apply-worktree`, `/delete-worktree`, or `/add-dir <path>` (isolated pass-through).
- CLI: `hapi cursor --cursor-worktree feature-x --cursor-add-dir ../shared`
- ACP ignores Cursor's plain-text `Using worktree: …` stdout banner so remote `sessionType: worktree` can initialize (fixed in [#1085](https://github.com/tiann/hapi/issues/1085)). Other non-JSON ACP stdout remains a fatal protocol error.

### Slash pass-through (remote)

These commands are isolated in the queue and forwarded to the agent (ACP prompt or legacy `-p`):

`/compress` `/summarize` `/compact` `/model` `/multitask` `/best-of-n` `/worktree` `/apply-worktree` `/delete-worktree` `/add-dir` `/context` `/fork` `/auto-review`

Interactive TUI-only commands (`/config`, `/mcp`, `/sandbox`, `/btw`, `/rewind`, …) are not supported remotely.

### Modes

- **Local mode** - Run `hapi cursor` from terminal. Full interactive experience.
- **Remote mode** - Spawn from web/phone when no terminal. New Cursor sessions use `agent acp` with HAPI permission approval, plan/question UI, and richer tool updates. Legacy sessions created before the ACP migration may still resume via the old `agent -p` stream-json path temporarily.

### Limitations

- **Multitask UI** - `/multitask` is slash-driven; HAPI does not yet provide an Agents Window-style fleet pane. Subagent `cursor/task` notifications show as CursorTask cards when the agent emits them.
- **Legacy sessions** - Cursor sessions created before the ACP migration can still resume temporarily via stream-json. Start a new Cursor session to get ACP permissions, plans, todos, and question support.
- **Session resume** - ACP sessions resume through `session/load`. Old stream-json `session_id` values are not loadable via ACP; those sessions keep using the legacy path until you start fresh.

#### Legacy stream-json safety: AskQuestion behavior

New cursor remote sessions go through ACP, which handles `AskQuestion` via the bidirectional `cursor/ask_question` extension method and is immune to the issue below. The intercept described here exists only for legacy sessions that resume via the older `agent -p` stream-json launcher.

When running cursor-agent under `--print --output-format stream-json`, the cursor-agent CLI returns a synthetic `Questions skipped by the user, continue with the information you already have` response for the `AskQuestion` tool because there is no IDE surface to render the question. The agent's underlying model can interpret this as legitimate user consent and act on it.

HAPI's legacy event converter intercepts this synthetic response and rewrites it to an explicit `no_input_surface` error (`status: failed`), so downstream consumers (web UI, Telegram, log readers) surface the fabrication as an error instead of silently passing through fabricated consent. The intercept scans the raw `tool_call` payload for the literal marker text and is scoped to `AskQuestion`-shaped (and converter-fallback `name=unknown`) calls; legitimate read/write/function tools are not affected.

The intercept drains naturally with the legacy session population - resumed pre-ACP sessions are the only path that still hits this code.

Tracking issue: [tiann/hapi#784](https://github.com/tiann/hapi/issues/784).

## Grok Build

HAPI can run the official Grok Build CLI locally and control the same coding session remotely from the Web/PWA.

### Install

Install Grok Build using the official installer:

::: code-group

```bash [macOS / Linux / WSL]
curl -fsSL https://x.ai/cli/install.sh | bash
```

```powershell [Windows PowerShell]
irm https://x.ai/cli/install.ps1 | iex
```

:::

Verify the installation:

```bash
grok version
```

### Authenticate

HAPI reuses the Grok CLI's local authentication. On a headless runner machine, authenticate once with device-code login:

```bash
grok login --device-auth
```

Alternatively, configure an xAI API key in the runner environment:

```bash
export XAI_API_KEY="xai-..."
```

Do not place API keys in HAPI configuration files, logs, or a repository.

### Start a session

Start the native Grok Build TUI:

```bash
hapi grok
```

Start with explicit launch settings:

```bash
hapi grok --model grok-4.5 --effort low --permission-mode default
hapi grok --yolo    # Shortcut for --permission-mode bypassPermissions
```

Sessions created from a HAPI runner start in remote mode automatically. Terminal-created sessions start in the native Grok TUI and can switch to remote control without parsing terminal output.

### Permission modes

Grok exposes four permission modes:

- `default` — tool requests are shown in HAPI for approval or denial.
- `auto` — Grok's own Auto mode: HAPI forwards Grok's `/auto` command to the session. Auto depends on account and CLI-build availability — if Grok does not advertise the `/auto` command, HAPI falls back to `default` and posts a notice in the session.
- `plan` — HAPI asks Grok to plan only and rejects tool execution requests.
- `bypassPermissions` — tool requests are automatically approved for the session (`--yolo` shortcut).

Use `bypassPermissions` only in a trusted workspace.

### Resume and handoff

Remote mode uses Grok's ACP stdio agent (`grok agent stdio`). HAPI stores the native Grok session ID and uses it for:

- ACP `session/load` after a restart.
- `grok --resume <session-id>` when switching back to the native TUI.
- `hapi resume <hapi-session-id>` from a terminal.

For a new local session, HAPI supplies a UUID with `grok --session-id`, so the session can be resumed without scraping the fullscreen TUI.

### Fork and rewind

When the Grok CLI build advertises them, HAPI uses Grok's ACP extension methods to fork the conversation (current point or from an earlier message, via `_x.ai/session/fork`) and to rewind the conversation to an earlier prompt (via `_x.ai/rewind/*`). Capabilities are probed per session, so older builds simply hide these controls.

### Model and effort controls

The Create page discovers Grok's ACP model catalog and the reasoning-effort choices advertised for each model. Remote sessions can switch both model and effort between turns; HAPI applies them through ACP `session/set_model` and `session/set_mode`. From the terminal, pick them at launch with `--model <model>` and `--effort <level>`.

HAPI also exposes Grok's common slash commands, discovers skills from `.grok/skills`, `~/.grok/skills`, and shared `.agents/skills`, and asks Grok to set a concise HAPI session title after the first normal prompt.

### Current limitations

- OAuth/device-code login must be completed outside the HAPI Web UI.
- Grok subscription, credit, and model availability are controlled by xAI.

If a remote session reports authentication failure, run `grok login --device-auth` on the runner machine and retry.

## DeepSeek Harness

`hapi dsh` uses the shared ACP transport and keeps DSH's runtime outside HAPI. The
default executable is `dsh-acp-demo`; configure a different ACP server or a
source checkout with `HAPI_DSH_ACP_COMMAND`, `HAPI_DSH_ACP_CONFIG`, or the JSON
argument array `HAPI_DSH_ACP_ARGS_JSON`.

The official demo is published as `@deepseek-ai/dsh-acp-demo`; use an exact
version such as `0.1.0-rc.7` rather than npm's stale `latest` tag:

```bash
npm install -g @deepseek-ai/dsh-acp-demo@0.1.0-rc.7
```

A published package still needs a DSH Cordis composition/config. A source
checkout can be launched directly:

```bash
export HAPI_DSH_ACP_COMMAND=pnpm
export HAPI_DSH_ACP_ARGS_JSON='["--dir", "/path/to/deepseek-harness", "run", "demo:acp"]'
hapi dsh
```

DSH sessions are remote-only and fresh-session-only. HAPI does not inject MCP
servers or expose model/effort pickers because the official ACP contract leaves
those surfaces to the DSH composition. Pending one-shot permission requests
remain answerable in the standard HAPI UI, but the ACP composition owns the
overall permission policy.

## Other agents

- **Claude Code** (`hapi` / `hapi claude`) — the default and recommended flavor; local sessions wrap the native TUI, remote sessions drive the Claude Agent SDK. [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)
- **Codex** (`hapi codex`) — OpenAI's Codex CLI; remote sessions talk to `codex app-server` over JSON-RPC, with a dedicated `plan` collaboration mode. [openai/codex](https://github.com/openai/codex)
- **GitHub Copilot** (`hapi copilot`) — Copilot CLI over ACP (`copilot --acp --stdio`). [GitHub Copilot](https://github.com/features/copilot)
- **Kimi** (`hapi kimi`) — Moonshot AI's Kimi CLI over ACP (`kimi acp`). [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)
- **OpenCode** (`hapi opencode`) — the open-source OpenCode agent over ACP (`opencode acp`). [opencode.ai](https://opencode.ai)
- **Antigravity** (`hapi agy`) — Google's Antigravity CLI (`agy`), driven headlessly via print mode: every turn spawns `agy -p <msg> --conversation <uuid> --output-format stream-json`, and NDJSON events (init / step_update / result) are streamed into the chat. There is no PTY/TUI wrapper and no hook-based permission bridge: permission handling uses agy's own `settings.json` allow/deny rules (`request-review`) or `--dangerously-skip-permissions` (`always-proceed`). Tool calls that lack an allow-rule are auto-denied by agy and surfaced as a chat hint. MCP servers are configured the standard agy way — in the user's global `~/.gemini/config/mcp_config.json` or a workspace `.agents/mcp_config.json` — and are loaded natively by agy in headless mode (no HAPI injection). Remote-only — there is no local terminal input path. [Google Antigravity](https://antigravity.google)
- **Pi** (`hapi pi`) — the Pi coding agent running as `pi --mode rpc` (JSON-line RPC over piped stdio); remote-control only, no local TUI input path. [badlogic/pi-mono](https://github.com/badlogic/pi-mono)

  HAPI translates a subset of Pi's TUI slash commands to native Pi RPC calls, so they work from the web chat as well:

  - `/compact [instructions]` — manually compact context with optional custom summary instructions (runs Pi's `compact` RPC; the summary is rendered as a dedicated block in the chat with the token delta in its header).
  - `/session` — show session stats (messages, tokens, cost, context usage).
  - `/model [modelId]` — show the current model and available models, or switch with `/model <modelId>`.
  - `/help` — list the commands supported from HAPI.

  Pi's extension commands and prompt templates (discovered via `get_commands`) keep working from the `/` menu, and skills are available through `$skill-name` like other ACP flavors. Other Pi TUI builtins (e.g. `/tree`, `/export`, `/reload`) cannot run over RPC; typing them in web shows an explicit "terminal-only" notice instead of silently forwarding the text to the model.

## Related

- [How it Works](./how-it-works.md) - Architecture and data flow
- [Quick Start](./quick-start.md) - Install HAPI and start your first session
