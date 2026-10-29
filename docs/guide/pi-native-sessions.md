# Pi native terminal sessions

With **Pi 1.4.0**, `hapi pi` in an interactive terminal starts Pi's native TUI
and connects HAPI to the same running agent through a bundled Pi extension.
The terminal and HAPI Web / phone can send messages concurrently, without a
local/remote control handoff. Older Pi versions are not supported by this native
bridge; the existing RPC integration remains available.

```bash
hapi pi                         # native TUI when stdin and stdout are terminals
hapi pi --session <id-or-file>   # open a saved Pi conversation
hapi pi --hapi-starting-mode remote  # existing headless RPC integration
```

Runner-created sessions and launches without both terminal streams keep using
`pi --mode rpc`. This feature does not install a daemon, change your `pi` command,
or discover other Pi processes. Start a conversation through HAPI to share it.

## Input and output

Plain-text and image prompts from HAPI enter the running Pi agent. HAPI queues
ordinary messages until Pi settles; **Steer** targets the current running turn.
Messages whose turn has already ended are rejected rather than steered into a
later turn. A successful submission means the extension submitted the input
for processing, not that the model completed the task. Pi input extensions can
still transform or handle the input.

Terminal input, assistant text and reasoning, tool execution, and model/thinking
changes are reflected in HAPI. HAPI does not parse terminal escape sequences.
Web messages already have a HAPI history row and are not echoed a second time.
Inputs injected by other Pi extensions are not separately mirrored as user rows.

The native terminal retains its full command interface. **Slash commands and
skills must be invoked in the Pi terminal** in native bridge mode. Custom
extension dialogs, including `select`, `confirm`, `input`, and custom TUI
components, also remain terminal-only. HAPI does not advertise remote question
controls for these dialogs. Use the existing RPC mode if you need its web-side
slash commands or supported extension question controls.

## Session identity and lifetime

- Native `/new`, `/resume`, and `/fork` create a new HAPI binding when they change
  the native conversation. The previous HAPI row is archived; its history remains
  readable. A row is never retargeted to another Pi conversation.
- Native `/tree` navigation creates a new HAPI binding for the selected branch,
  even though Pi may retain the same session ID. Requests from the previous
  branch are rejected.
- `/reload` reconnects the extension to the same HAPI row. Pending requests from
  the previous extension runtime are not automatically replayed.
- Closing the original Pi terminal ends the native process and its bridge.
  Closing a browser tab does not stop it. **Stop** requests an interrupt;
  **End session** terminates the native Pi process.
- `hapi resume <hapi-id>` can reopen an inactive conversation in a native TUI.
  Attaching another terminal to an already-running native bridge is unsupported.
  Do not independently open the same Pi session file in multiple Pi processes.

If an input's acknowledgement is lost, HAPI reports that its outcome is unknown
and retires that delivery so it cannot be automatically replayed. Inspect the
terminal or saved Pi history before retrying. A Hub reconnect does not restart
the Pi engine.

## Local transport

The wrapper listens only on loopback and authenticates the extension with a
per-launch random token passed through the child environment. Requests are
scoped to a native session and its runtime epoch. Terminal output stays on the
terminal; the bridge carries structured commands and events. Temporary extension
files are private to the launch and removed during cleanup.

## Development verification

The opt-in integration test uses an installed Pi, a real POSIX PTY, and a local
OpenAI-compatible SSE server. It uses temporary Pi configuration and no paid
model requests. Install Pi 1.4.0, Bun, and `uv`, then run from the repository root:

```bash
HAPI_PI_NATIVE_INTEGRATION=1 bun run --cwd cli test src/pi/native/realPi.integration.test.ts
```

The test covers local and remote input in one native session, a real `read` tool,
`/new`, `/reload`, and rejection of stale session/runtime requests. It does not
verify a remote model provider or terminal pixel layout.
