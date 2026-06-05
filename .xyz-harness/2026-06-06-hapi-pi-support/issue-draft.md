# Issue 草案 — Pi Agent Support

> **状态**: 草稿，待审核后提交到 [tiann/hapi](https://github.com/tiann/hapi)
> **相关调研**: [research-summary.md](./research-summary.md)

---

### [Feature Request] Pi Coding Agent Integration — with RPC protocol analysis and implementation approach

**Related:**
- #335 — consider adding support for pi-mono?
- #620 — 是否可以支持 pi (dup of #335)
- #770 — Pi Agent Support
- #375 — feat(cli): add PI coding agent integration (abandoned)
- #653 — 引入轻量插件系统

---

### Who I am and why I want this

I've been using Pi as my primary coding agent for a few months now. What drew me to it is the same thing that probably resonates with many HAPI users: it's lightweight, it's open source (MIT), and it's extensible — I've written several custom extensions and UI tools for it myself.

Some things I've built or contributed:
- **[xyz-pi-extensions](https://github.com/zhushanwen321/xyz-pi-extensions)** — My personal extension pack for Pi, adding custom code review and prompt workflows
- Multiple custom Pi extensions that integrate with my daily workflow

I work on Pi-based projects daily, and the one thing I consistently miss is being able to **control my Pi sessions from my phone**. HAPI is the obvious solution — it already has a polished web UI, hub architecture, and agent backends for Claude Code, Codex, Gemini, OpenCode, etc. Adding Pi would complete the set for me.

So I'm not here to make a vague request. I want to do the implementation work and submit a PR. This issue lays out my research and approach for discussion.

---

### What Pi is and why it fits HAPI's architecture

Pi (`@earendil-works/pi-coding-agent`) is another local-first coding agent CLI, similar in spirit to Claude Code and OpenCode but with a more modular, plugin-friendly design. It runs as a standalone binary or npm global tool and has 3 output modes:

| Mode | Description |
|------|------------|
| `pi` (default) | Interactive TUI with Ink |
| `pi -p` (print) | Single-turn, non-interactive |
| `pi --mode rpc` | **JSONL over stdio** — the mode relevant to HAPI |

The RPC mode (`pi --mode rpc`) is specifically designed for embedding Pi in other applications. It uses the **same transport primitive as ACP** (JSONL over stdin/stdout), but with its own message format instead of JSON-RPC 2.0.

This means we can **reuse HAPI's existing stdio transport infrastructure** (`AcpStdioTransport` or similar) while implementing a custom protocol handler — the same pattern already used by Codex's JSON-RPC handler and the ACP backend.

---

### RPC Protocol Analysis

Pi's RPC mode is a JSONL protocol where each line on stdin is a command, and each line on stdout is either a response or an event. The format is deliberately simple — no framing, no errors unless the JSON itself is malformed.

#### Commands (stdin JSONL)

```typescript
// Core interaction
{ "type": "prompt", "message": "fix the typo", "images?" }
{ "type": "steer", "message": "..." }
{ "type": "follow_up", "message": "..." }
{ "type": "abort" }

// Session lifecycle
{ "type": "new_session", "parentSession?" }
{ "type": "switch_session", "sessionPath" }
{ "type": "clone" }
{ "type": "set_session_name", "name": "..." }

// State & model
{ "type": "get_state" }
{ "type": "get_available_models" }
{ "type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4" }
{ "type": "get_messages" }
{ "type": "get_session_stats" }

// Context management
{ "type": "compact", "customInstructions?" }
{ "type": "bash", "command": "..." }
{ "type": "fork", "entryId" }
```

#### Events (stdout JSONL) — streamed as they happen

```typescript
// Text generation in real time
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "text": "..." } }

// Thinking (reasoning) stream
{ "type": "message_update", "assistantMessageEvent": { "type": "thinking_delta", "text": "..." } }

// Tool execution lifecycle
{ "type": "tool_execution_start", "toolCallId": "...", "toolName": "edit", "args": {...} }
{ "type": "tool_execution_end", "toolCallId": "...", "result": {...}, "isError": false }

// Turn boundaries
{ "type": "turn_start" }
{ "type": "turn_end", "message": {...}, "toolResults": [...] }

// Agent lifecycle
{ "type": "agent_start" }
{ "type": "agent_end", "messages": [...] }
```

#### Responses (stdout JSONL) — for synchronous commands

```typescript
{ "type": "response", "command": "get_state", "success": true, "data": {...} }
{ "type": "response", "command": "set_model", "success": true, "data": {...} }
{ "type": "response", "command": "prompt", "success": false, "error": "..." }
```

#### ACP Compatibility Assessment

ACP (Agent Communication Protocol) is JSON-RPC 2.0 over stdio with methods like `initialize`, `session/new`, `session/prompt`, `session/cancel`. Pi's RPC uses a different framing and method namespace, so they are **not wire-compatible**.

However, the **architecture mapping is very direct**:

| ACP Method | HAPI's AcpSdkBackend path | Pi RPC equivalent | Directness |
|---|---|---|---|
| `initialize` | Handshake, protocol version negotiation | Implicit (pi starts in RPC mode) | **No handshake needed** — simpler |
| `session/new` | Creates a session | `{ type: "new_session" }` | Direct 1:1 |
| `session/prompt` | Sends prompt, receives stream | `{ type: "prompt" }` + event stream | Direct 1:1 |
| `session/cancel` | Aborts running prompt | `{ type: "abort" }` | Direct 1:1 |
| `session/set_model` | Switches model | `{ type: "set_model" }` | Direct 1:1 |
| `session/get_state` | Gets session state | `{ type: "get_state" }` | Direct 1:1 |
| `session/request_permission` | Permission dialog | **Not supported** — pi has no tool-level permission model | N/A |
| Usage/token data | From `session/prompt` response | From `turn_end` event metadata | Different extraction path |

**Bottom line:** Pi RPC can implement the same `AgentBackend` interface used by ACP, Gemini, and OpenCode. The event-to-message conversion is simpler than ACP because Pi's events use a more self-describing format (no ACP's multi-level tool call dedup or content normalization).

#### Missing Capability: Permission / Tool Approval

Pi does **not** have a tool-level permission/approval mechanism. It runs with whatever permission mode was set at startup (yolo/stealth/default, configured via environment). This is the same situation as Gemini and OpenCode in yolo mode — the ACP backend already supports this by simply not registering a `session/request_permission` handler.

For the initial integration, Pi would start in yolo mode with permission bypass. If tool-level approval is needed later, the bridge could intercept tool events before forwarding them to the web UI (client-side only, since pi doesn't support "hold and wait").

---

### Proposed Implementation

#### Approach: spawn + protocol adapter (zero dependencies)

```
┌──────────┐  stdin/JSONL   ┌──────────┐
│ HAPI CLI │ ──────────────→ │ pi --mode│
│ (Bridge) │ ←────────────── │ rpc      │
└──────────┘  stdout/JSONL   └──────────┘
```

This is the same approach used by Codex and the ACP agents — no shared libraries, no SDK embedding, just a subprocess and a protocol implementation.

#### Architecture Layers

```
hapi pi
  └── spawn('pi', ['--mode', 'rpc'])
      ├── Layer 1: Transport — stdio JSONL send/receive
      │   - Partially reusable from AcpStdioTransport (spawn, line parsing)
      │   - New: Pi's custom JSONL format (no JSON-RPC, just type+data)
      │
      ├── Layer 2: Protocol — command/response lifecycle
      │   - PiRpcClient: wraps send({type:"..."}) → receive(response|events)
      │   - Response correlation via {id} field (same pattern as ACP's request id)
      │
      ├── Layer 3: Event Conversion — Pi AgentEvent → HAPI AgentMessage
      │   - text_delta → { type: 'text' }
      │   - thinking_delta → { type: 'reasoning' }
      │   - tool_execution_* → { type: 'tool_call' } / { type: 'tool_result' }
      │   - turn_end → { type: 'usage' } + { type: 'turn_complete' }
      │
      └── Layer 4: Backend Adapter — implements AgentBackend interface
          - newSession / prompt / cancelPrompt / setModel / getState
          - Registers via AgentRegistry (same path as Gemini/OpenCode)
```

#### Extension Points Needed

The current `AgentBackend` interface (`cli/src/agent/types.ts`) already covers everything Pi RPC can do, with one gap:

- **`onPermissionRequest` / `respondToPermission`** — Pi doesn't support this, so the bridge would implement no-ops. This is already handled by the ACP backend's existing pattern for agents that don't support permissions.

No architecture changes are required. The main extension points are:
1. `shared/src/modes.ts` — add `'pi'` to `AGENT_FLAVORS` enum (~1 line)
2. `shared/src/flavors.ts` — add pi capability profile (~10 lines)
3. `cli/src/agent/AgentRegistry.ts` — no change needed (already generic)
4. `cli/src/agent/runners/runAgentSession.ts` — map `'pi'` → `PiBackend` (~2 lines)
5. `hub/src/web/routes/machines.ts` — accept `'pi'` in spawn schema (~2 lines)
6. `web/src/components/NewSession/` — add pi to agent picker (~10 lines)

New files (~500 lines total):
- `cli/src/agent/backends/pi/`: transport + protocol + event converter + backend adapter

---

### Why this approach is different from PR #375

PR #375 imported three npm packages (`pi-agent-core`, `pi-ai`, `pi-coding-agent`) as embedded dependencies, bringing ~70 transitive deps into HAPI's dependency tree. That's the wrong approach for three reasons:

1. **Version coupling** — HAPI would be locked to whatever pi version was bundled at PR time
2. **Failure isolation** — a crash in pi's agent loop would take down HAPI
3. **Maintenance burden** — every pi release needs a new HAPI PR

The spawn+RPC approach is the same pattern HAPI already uses for Claude Code and Codex: treat pi as an external tool, communicate over a stable protocol boundary. If pi's RPC protocol changes, it's a protocol format change, not a dependency update.

---

### What I'm proposing (and what I can do)

**Immediate (I can write this PR):**
- CLI integration only: `hapi pi` spawns `pi --mode rpc`, streams events, supports prompt/abort/session lifecycle
- ~500 new lines, zero new dependencies
- Local mode only (CLI), like how `hapi gemini` works

**Second PR (after CLI is stable):**
- Hub integration: add pi to spawn API, remote session management via web UI
- Requires the protocol bridge to handle hub's RPC routing

I'm willing to do both. Just want to confirm the direction before writing code.

---

### Questions for maintainers

1. Is the spawn+RPC approach acceptable, or do you prefer a different integration strategy?
2. Would you prefer the PR to be split further (e.g., first just the protocol adapter, then CLI command)?
3. Any concern about pi not supporting tool-level permission approval for remote/web use?

Happy to adjust the scope or approach based on feedback.
