# Cursor Agent

HAPI supports [Cursor Agent CLI](https://cursor.com/docs/cli/using) for running Cursor's AI coding agent with remote control via web and phone.

## Prerequisites

Install Cursor Agent CLI:

- **macOS/Linux:** `curl https://cursor.com/install -fsS | bash`
- **Windows:** `irm 'https://cursor.com/install?win32=true' | iex`

Verify installation:

```bash
agent --version
```

## Usage

```bash
hapi cursor                    # Start Cursor Agent session
hapi cursor resume <chatId>    # Resume a specific chat
hapi cursor --continue         # Resume the most recent chat
hapi cursor --mode plan        # Start in Plan mode
hapi cursor --mode ask         # Start in Ask mode
hapi cursor --yolo             # Bypass approval prompts (--force)
hapi cursor --model <model>    # Specify model
```

## Permission Modes

| Mode | Description |
|------|-------------|
| `default` | Standard agent behavior |
| `plan` | Plan mode - design approach before coding |
| `ask` | Ask mode - explore code without edits |
| `yolo` | Bypass approval prompts |

Set mode via `--mode` flag or change from the web UI during a session.

## Modes

- **Local mode** - Run `hapi cursor` from terminal. Full interactive experience.
- **Remote mode** - Spawn from web/phone when no terminal. New Cursor sessions use `agent acp` with HAPI permission approval, plan/question UI, and richer tool updates. Legacy sessions created before the ACP migration may still resume via the old `agent -p` stream-json path temporarily.

## Limitations

- **Legacy sessions** - Cursor sessions created before the ACP migration can still resume temporarily via stream-json. Start a new Cursor session to get ACP permissions, plans, todos, and question support.
- **Session resume** - ACP sessions resume through `session/load`. Old stream-json `session_id` values are not loadable via ACP; those sessions keep using the legacy path until you start fresh.

### Legacy stream-json safety: AskQuestion behavior

New cursor remote sessions go through ACP, which handles `AskQuestion` via the bidirectional `cursor/ask_question` extension method and is immune to the issue below. The intercept described here exists only for legacy sessions that resume via the older `agent -p` stream-json launcher.

When running cursor-agent under `--print --output-format stream-json`, the cursor-agent CLI returns a synthetic `Questions skipped by the user, continue with the information you already have` response for the `AskQuestion` tool because there is no IDE surface to render the question. The agent's underlying model can interpret this as legitimate user consent and act on it.

HAPI's legacy event converter intercepts this synthetic response and rewrites it to an explicit `no_input_surface` error (`status: failed`), so downstream consumers (web UI, Telegram, log readers) surface the fabrication as an error instead of silently passing through fabricated consent. The intercept scans the raw `tool_call` payload for the literal marker text and is scoped to `AskQuestion`-shaped (and converter-fallback `name=unknown`) calls; legitimate read/write/function tools are not affected.

The intercept drains naturally with the legacy session population - resumed pre-ACP sessions are the only path that still hits this code.

Tracking issue: [tiann/hapi#784](https://github.com/tiann/hapi/issues/784).

## Integration

Once running, your Cursor session appears in the HAPI web app and Telegram Mini App. You can:

- Monitor session activity
- Approve permissions from your phone
- Send messages when in local mode (messages queue for when you switch)

## Related

- [Cursor CLI Documentation](https://cursor.com/docs/cli/using)
- [How it Works](./how-it-works.md) - Architecture and data flow
