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
- **Remote mode** - Spawn from web/phone when no terminal. Uses `agent -p` with `--output-format stream-json` and `--trust`. Each user message spawns one agent process; session continues via `--resume`.

## Limitations

- **Tool approval** - In remote mode, `--trust` is used; tools run without per-request approval. Use `--yolo` for full bypass.
- **Session resume** - Pass `--resume <chatId>` or `--continue` to resume. Use `agent ls` to list previous chats and get chat IDs.

### Headless safety: AskQuestion behavior

When running cursor-agent under `--print --output-format stream-json` (HAPI's current remote mode), the cursor-agent CLI returns a synthetic `Questions skipped by the user, continue with the information you already have` response for the `AskQuestion` tool because there is no IDE surface to render the question. The agent's underlying model can interpret this as legitimate user consent and act on it.

HAPI intercepts this synthetic response in the stream-json event converter and rewrites it to an explicit `no_input_surface` error (`is_error: true`), so agents do not act on fabricated user consent. Defense-in-depth: any `AskQuestion` (or `name=unknown`) tool completion that arrives within ~500 ms of its start event with a trivial payload is treated the same way, in case cursor-agent changes the synthetic-string text in a future release.

Agents running under HAPI's Cursor remote mode should fall back to plain-text prompting (markdown options + waiting for a regular user message) until the [ACP migration (tiann/hapi#781)](https://github.com/tiann/hapi/issues/781) lands and `cursor/ask_question` becomes available as a proper bidirectional ACP method. At that point this intercept becomes unnecessary and is removed.

Tracking issue: [tiann/hapi#784](https://github.com/tiann/hapi/issues/784).

## Integration

Once running, your Cursor session appears in the HAPI web app and Telegram Mini App. You can:

- Monitor session activity
- Approve permissions from your phone
- Send messages when in local mode (messages queue for when you switch)

## Related

- [Cursor CLI Documentation](https://cursor.com/docs/cli/using)
- [How it Works](./how-it-works.md) - Architecture and data flow
