# Supported Agents

HAPI is a wrapper around AI coding agents. One CLI (`hapi <agent>`) starts any supported agent locally and exposes the same session for remote control from the web app, PWA, and Telegram — with permission prompts, message queueing, and seamless handoff between terminal and phone.

Run `hapi` without arguments to choose an agent interactively. The picker shows
all supported agents alphabetically by command name; missing or misconfigured
agents are disabled with a reason. Scripts must use `hapi <agent> [options]`.
`hapi --help` shows HAPI's own help. Options after an agent name belong to that
agent's integration; their supported syntax varies by agent.

## Support matrix

| Agent | Command | Integration | Local | Remote | Permission modes | Resume |
|-------|---------|-------------|:-----:|:------:|------------------|:------:|
| Claude Code | `hapi claude` | Terminal wrapper (local) + Claude Agent SDK (remote) | ✓ | ✓ | `default` `acceptEdits` `auto` `bypassPermissions` `plan` | ✓ |
| Codex | `hapi codex` | Native terminal + `codex app-server` (Codex 0.154.0+) | ✓ | ✓ | `default` `read-only` `autoReview` `yolo` (+ `plan` collaboration mode) | ✓ |
| Cursor Agent | `hapi cursor` | ACP (`agent acp`); legacy stream-json resume | ✓ | ✓ | `default` `plan` `ask` `debug` `autoReview` `yolo` | ✓ |
| Grok Build | `hapi grok` | ACP (`grok agent stdio`) | ✓ | ✓ | `default` `auto` `plan` `bypassPermissions` | ✓ |
| GitHub Copilot | `hapi copilot` | ACP (`copilot --acp --stdio`) | ✓ | ✓ | `default` `read-only` `safe-yolo` `yolo` | ✓ |
| Kimi | `hapi kimi` | ACP (`kimi acp`) | ✓ | ✓ | `default` `read-only` `safe-yolo` `yolo` | ✓ |
| OpenCode | `hapi opencode` | ACP (`opencode acp`) | ✓ | ✓ | `default` `plan` `yolo` | ✓ |
| DeepSeek Harness | `hapi dsh` | ACP (`dsh --profile acp` or configured server) | — | ✓ | Managed by DSH ACP composition | ✓* |
| Antigravity (agy) | `hapi agy` | ACP (`agy acp`, agy 1.5.0+); persistent stream-json for older agy | — | ✓ | `request-review` `acceptEdits` `plan` `always-proceed` | ✓ |
| Pi | `hapi pi` | `pi --mode rpc` (JSON-line RPC over stdio) | — | ✓ | none (always auto-approve) | ✓ |
| Gemini CLI | — | **Removed** — Google sunset the consumer Gemini CLI (2026-06-18) | — | — | — | — |

Gemini is no longer launchable: `hapi gemini` is kept as a tombstone command that prints a clear error, and existing Gemini sessions remain viewable in the web UI but cannot be resumed.

## Common concepts

### ACP

Most remote integrations speak the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) over stdio through a shared HAPI backend. ACP gives remote sessions bidirectional permission approval, plan/todo updates, question UI, model catalogs, and session resume via `session/load`. Cursor, Grok, Copilot, Kimi, OpenCode, Antigravity, and DeepSeek Harness remote sessions all run over ACP. DSH's official ACP server is automation-focused and currently supports committed assistant output, cancellation, one-shot permissions, native session resume via `session/resume`, and per-turn model switching through `session/set_config_option`; it does not provide MCP injection or live tool/reasoning telemetry. Legacy or incompatible DSH ACP servers fall back to a fresh session when native resume is unavailable.

### Permission modes

Permission modes are per-agent — each flavor exposes its own set (see the matrix above). Set the mode at launch with `--permission-mode <mode>` or a shortcut flag (`--yolo`, `--plan`, `--auto-review`, depending on the agent), and switch it mid-session from the web UI. Semantics vary per agent; see the per-agent sections below.

### Local and remote mode

Work **locally** in the terminal or **remotely** from web/phone, keeping the same conversation when you hand off. The support matrix shows which interfaces each agent offers; DSH, Pi, and Antigravity accept input only through HAPI's remote interface.

- **Remote → local:** continue in the terminal. If it shows the remote-control screen, press double-space to return to local input.
- **Local → remote:** send a message from the web UI or phone; HAPI handles the handoff.

See [Seamless Handoff](./how-it-works.md#seamless-handoff) for details.

### Resuming sessions

```bash
hapi resume                # Interactive picker of resumable sessions on this machine
hapi resume <session-id>   # Resume a specific HAPI session
```

`hapi resume` reopens the conversation on this machine, including active sessions you were using from your phone. Gemini cannot be resumed. DSH resume depends on the configured ACP server: current DSH ACP profiles restore the native session, while a fresh-session-only server starts a new session with a status message. Pi and Antigravity resume with input still controlled from HAPI rather than the terminal.

### Displaying images

HAPI supports two image delivery methods: Markdown images embedded in conversation text and the `display_image` tool.

#### Client support

| Client | Local workspace Markdown images | HTTP(S) Markdown images |
|--------|---------------------------------|-------------------------|
| Web/PWA | Loaded through the authenticated session file API | Loaded directly by the browser |
| Native iOS | Placeholder rows or alternative text; no image loading | Placeholder rows or alternative text, with links where applicable; no inline image loading |
| Native Android | Alternative text or links; no image loading | Alternative text or links; no inline image loading |

The native clients can display images delivered through `display_image`. Those generated-image messages use a separate rendering path from Markdown images.

#### Local Markdown images in Web/PWA

Use standard Markdown image syntax:

```markdown
![Screenshot](screenshots/result.png)
```

For paths containing spaces, enclose the path in angle brackets:

```markdown
![Screenshot](<screenshots/my result.png>)
```

Local Markdown images must meet these requirements:

- The file exists within the current session's configured working directory. Relative paths resolve from that directory, not from the browser URL or a shell command's temporary working directory.
- The file is no larger than 10 MiB (10,485,760 bytes).
- The file has a supported image extension and can be decoded by the browser.
- The normalized path remains within the session workspace. Out-of-workspace paths and `file:`, `data:`, or `blob:` URLs are not supported.

Recognized extensions are APNG, AVIF, BMP, GIF, ICO, JPEG, JPG, PNG, SVG, TIF, TIFF, and WebP. Recognizing an extension does not guarantee browser decoding; for example, Chromium does not normally display TIFF images. PNG, JPEG, GIF, and WebP are recommended for broad browser compatibility.

Local images are read through the authenticated session file API. The referenced file and the session file-reading connection must remain available. A Markdown reference does not create a permanent attachment.

Reachable HTTP(S) images load directly in the browser. The 10 MiB session-file limit applies to local images, not remote image URLs.

#### Using display_image

Use the available HAPI `display_image` tool with an absolute filesystem path when:

- The image needs to be viewable in both Web/PWA and native clients.
- The image is outside the session workspace.
- Markdown image delivery is unsuitable, or the user prefers a separate image card.

The MCP tool accepts supported image content up to 25 MiB. Its supported formats differ from Markdown/browser rendering, so a file unsupported by one method is not necessarily supported by the other.

The MCP `display_image` tool presents the image to the user; it does not provide image input to the model for inspection or analysis. Pi's separate `hapi_display_image` extension tool also returns image bytes to the model context.

Neither Markdown references nor the current generated-image delivery path guarantee permanent image storage.

#### Choosing a delivery method

Follow an explicit user or workspace preference when supported and permitted. Without a stated preference, use the available `display_image` tool.

For a Web/PWA-only workflow, users can record a preference in their agent's workspace instruction file, such as `AGENTS.md`:

> I use HAPI Web/PWA only. Prefer Markdown for local images that meet HAPI's workspace, size, and format requirements. Otherwise, use the available `display_image` tool when the file meets that tool's requirements.

Normally show each image once. Do not deliver the same image through both Markdown and a display tool, or redisplay a user-provided image, unless requested.

Check each method's own requirements before using it. Do not switch delivery methods to bypass denied file access or tool approval.


### Mathematical formulas in HAPI Markdown

HAPI renders LaTeX-style mathematics through KaTeX. When generating or revising Markdown intended for display in HAPI, follow these rules exactly:

- Use `\( ... \)` for inline mathematics.
- Use `\[ ... \]` for standalone display mathematics.
- Do not use single-dollar delimiters such as `$x^2$`. Single-dollar math is disabled to prevent currency values such as `$200` from being misinterpreted as formulas.
- `$$ ... $$` remains supported for compatibility, but `\[ ... \]` is preferred for display mathematics.
- Do not put formulas inside inline code, fenced code blocks, or other code content.
- Use only LaTeX commands supported by KaTeX. TikZ is not supported.
- Do not use bare `[ ... ]` as math delimiters.

Before sending a response, check every mathematical expression for the correct delimiters. Rewrite any mathematical `$...$` expression as `\(...\)` or `\[...\]`; preserve ordinary currency text such as `$200` as plain text.

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
hapi cursor --auto-review      # Start with Auto (Smart Auto)
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
| `autoReview` | Auto (Smart Auto) - allowlist/sandbox/classifier instead of full YOLO |
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
default entrypoint is the official `dsh` CLI with `--profile acp` (the ACP profile
ships with `@deepseek-ai/dsh` since 0.2.0). Configure a different ACP server or a
source checkout with `HAPI_DSH_ACP_COMMAND`, `HAPI_DSH_ACP_CONFIG`, or the JSON
argument array `HAPI_DSH_ACP_ARGS_JSON`. `HAPI_DSH_ACP_CONFIG` passes a `--config`
path to the server named by `HAPI_DSH_ACP_COMMAND`; on the default official CLI
(which has no `--config` flag) it is applied as a `--patch` overlay on top of
`--profile acp`.

```bash
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
hapi dsh
```

The standalone legacy demo is still published as `@deepseek-ai/dsh-acp-demo`; use
it through an explicit override and an exact version such as `0.1.0-rc.7` rather
than npm's stale `latest` tag:

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

DSH sessions are remote-only. With a persistent DSH ACP profile, HAPI stores the
native DSH session id and restores model context with `session/resume` after a
restart or archive. The resume call does not replay the transcript; HAPI's Hub
message history remains the source for the chat UI. HAPI does not inject MCP
servers. Model selection is available: the DSH composition's model catalog is
exposed through the session RPC `ListDshModels` and applied per turn with ACP
`session/set_config_option`. Effort pickers are not exposed because the
official ACP contract leaves that surface to the DSH composition. Pending
one-shot permission requests remain answerable in the standard HAPI UI, but
the ACP composition owns the overall permission policy. A legacy or
fresh-session-only server falls back to a new session and surfaces that outcome
in the chat.

`*` Resume requires a DSH ACP server that implements `session/resume`.

HAPI's `$` skill menu for DSH sessions reads the same skill roots DSH's own
skill filesystem uses: `$DSH_HOME/skills` (`~/.dsh/skills` by default), the
project's `.dsh/skills`, and the shared `~/.agents/skills` / `.agents/skills`
directories. Since the ACP composition accepts no client-supplied MCP servers,
HAPI's `skill_lookup` bridge is not available to DSH sessions; a skill named in
the prompt is loaded by DSH through its own `skill` tool and catalog.

## Other agents

- **Claude Code** (`hapi claude`) — local sessions wrap the native TUI, remote sessions drive the Claude Agent SDK. [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)
- **Codex** (`hapi codex`) — OpenAI's Codex CLI, with terminal/Web control and a dedicated `plan` mode. See [Codex usage and limits](./codex-shared-sessions.md) for resume, terminal-exit behavior, and launch options. [openai/codex](https://github.com/openai/codex)
- **GitHub Copilot** (`hapi copilot`) — Copilot CLI over ACP (`copilot --acp --stdio`). Remote sessions can pick a reasoning effort in the composer when the active model offers one; HAPI applies it before the next turn through ACP `session/set_config_option`. [GitHub Copilot](https://github.com/features/copilot)
- **Kimi** (`hapi kimi`) — Moonshot AI's Kimi CLI over ACP (`kimi acp`). Remote sessions can pick a thinking level in the composer when the active model offers one; HAPI applies it before the next turn through ACP `session/set_config_option`. [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)
- **OpenCode** (`hapi opencode`) — the open-source OpenCode agent over ACP (`opencode acp`). [opencode.ai](https://opencode.ai)
- **Antigravity** (`hapi agy`) — Google's Antigravity CLI (`agy`) over ACP
  (`agy acp`, added in agy 1.5.0). HAPI checks `agy --version` when the
  session starts; older agy releases, an agy whose version cannot be read,
  and an `agy acp` that fails to start keep the previous persistent
  stream-json integration (no approval prompts in
  HAPI: tools without an allow-rule in agy's `settings.json` are auto-denied).

  **Experimental:** HAPI makes agy usable, but Antigravity/agy itself has
  protocol and runtime limitations that can affect reliability and usability.
  These limitations are in agy, not HAPI; we do not recommend agy for routine
  work when a more reliable agent is available.

  On ACP, one `agy acp` process serves the whole session. The agy conversation
  id is the ACP session id, so a session continues the same conversation
  through `session/resume` without replaying history, whichever integration
  started it. If the agy process dies, the next message restarts it and
  resumes the conversation; a prompt agy never started is restored to the
  composer. Stop sends `session/cancel`, which also ends open tool calls; a
  prompt stopped before agy answered anything also goes back to the composer.

  On ACP, **Steer** a queued message to add it to the running turn instead of
  waiting for the turn to end. HAPI sends it as another `session/prompt`; agy
  finishes any tool call already running, then continues the same turn with
  the new message. The turn's usage includes the steered part.

  Permission modes map to agy's session modes. `request-review` is agy's
  `default` mode, which asks only as agy's own `toolPermission` setting
  (`~/.gemini/antigravity-cli/settings.json`) says; on ACP its approval
  requests show in HAPI. With `toolPermission: always-proceed`, agy runs
  commands and edits without asking, so HAPI shows no approval prompts; set
  it to `request-review` in agy to approve each command and edit from HAPI.
  HAPI cannot override this per session. `acceptEdits` is agy's
  `accept-edits` mode, which also runs edits without asking, and `plan` is
  agy's `plan` mode, which writes a plan instead of running commands or
  edits. `always-proceed` approves every request automatically, including
  one a PreToolUse hook marks `force_ask` (agy does not tell HAPI a request
  came from a hook). On ACP, mode changes apply to the next message without
  restarting agy. Conversation titles come from agy when available; otherwise
  HAPI uses a cleaned first-prompt preview. On ACP each response's
  details show the turn's token usage.

  Remote-only — there is no local terminal input path or PTY/TUI wrapper. MCP
  servers are loaded natively from `~/.gemini/config/mcp_config.json` or
  workspace `.agents/mcp_config.json`; HAPI does not inject its own MCP server.
  [Google Antigravity](https://antigravity.google)

  On ACP, agy's questions (`ask_question`) appear as the question card; the
  choice goes back as agy's answer, and no permission mode answers a question
  for you.

  In the web model picker, models with multiple effort variants appear once,
  with a separate effort selector showing the levels in the machine's catalog.
  For example, choose **Gemini 4 Argon** and **High**, or launch with
  `hapi agy --model gemini-4-argon --effort high`. Models with only one listed
  variant keep their original name and have no effort selector. Model and effort
  changes apply to subsequently sent messages; queued messages keep their settings.

- **Pi** (`hapi pi`) — the Pi coding agent running as `pi --mode rpc` (JSON-line RPC over piped stdio); remote-control only, no local TUI input path. [earendil-works/pi](https://github.com/earendil-works/pi)

  HAPI translates a subset of Pi's TUI slash commands to native Pi RPC calls, so they work from the web chat as well:

  - `/compact [instructions]` — manually compact context with optional custom summary instructions (runs Pi's `compact` RPC; the summary is rendered as a dedicated block in the chat with the token delta in its header).
  - `/session` — show session stats (messages, tokens, cost, context usage).
  - `/model [modelId]` — show the current model and available models, or switch with `/model <modelId>`.
  - `/help` — list the commands supported from HAPI.

  Pi's extension commands and prompt templates (discovered via `get_commands`) keep working from the `/` menu, and skills are available through `$skill-name` like other ACP flavors. Other Pi TUI builtins (e.g. `/tree`, `/export`, `/reload`) cannot run over RPC; typing them in web shows an explicit "terminal-only" notice instead of silently forwarding the text to the model.

  Pi sessions include a `hapi_display_image` tool for showing local PNG, JPEG, GIF, or WebP images up to 25 MiB in the chat. Images returned by Pi tools render inline even when the selected model has no vision support. The display tool also returns image bytes to Pi's model context.

  On Pi versions with built-in MCP support (0.99+), HAPI also exposes its peer-session tools through Pi: `list_peers`, `inspect_peer`, `ping_peer`, and `spawn_peer`. Calls that read another session, send to it, or spawn a session require confirmation in the HAPI UI. `HAPI_DISABLE_PEER_TOOLS=1` hides the tools and keeps the disabled citation guidance in the system prompt.

## Related

- [How it Works](./how-it-works.md) - Architecture and data flow
- [Quick Start](./quick-start.md) - Install HAPI and start your first session
