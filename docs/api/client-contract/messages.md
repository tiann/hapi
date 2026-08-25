# Message decode tree

**Audience:** Implementers of native HAPI clients (iOS / Android). This page specifies how to decode `DecryptedMessage.content` into renderable chat structure. This is the largest porting surface — the reference pipeline is `web/src/chat/` (~4600 lines); this page is its wire-level contract. Companion pages: [pagination](./pagination.md) (how messages arrive), [sse](./sse.md) (live delivery).

Source of truth: `shared/src/schemas.ts` (`DecryptedMessageSchema`), `shared/src/messages.ts` (envelope helpers), `web/src/chat/normalize.ts`, `web/src/chat/normalizeUser.ts`, `web/src/chat/normalizeAgent.ts`, `web/src/chat/types.ts`, `hub/src/store/contentCodec.ts`.

---

## Wire shape

```ts
type DecryptedMessage = {
  id: string                  // server uuid (optimistic rows: == localId until echoed)
  seq: number | null          // per-session insert counter
  localId: string | null      // client-generated id for optimistic reconciliation
  content: unknown            // the role-wrapped envelope — everything below
  createdAt: number           // hub receive time (epoch ms)
  invokedAt?: number | null   // when the agent consumed it (null = still queued)
  scheduledAt?: number | null // future-scheduled sends
  deliveryState?: 'indeterminate' // steer dispatched, outcome unproven; explicit retry/cancel required
}
```

`content` is deliberately `unknown` on the wire. **Decoding must be total**: malformed content degrades to a stringified fallback — a client must never drop or crash on a message it does not recognize (with the two precise exceptions listed in [Fallback rules](#fallback-rules)).

---

## Envelope

`content` is a role-wrapped envelope:

```ts
{ role: 'user' | 'agent', content: <payload>, meta?: unknown }
```

Unwrap algorithm (`unwrapRoleWrappedRecordEnvelope`, `shared/src/messages.ts`) — a record qualifies when it has a string `role` and a `content` key; if `content` itself is not one, also probe, in order:

1. `content.message`
2. `content.data.message`
3. `content.payload.message`

No envelope found ⇒ render the **whole** `content` as stringified agent text. `role` other than `user`/`agent` ⇒ stringify `record.content` as agent text.

### `meta`

Opaque record; carry it through. Known keys:

| Key | Values | Meaning |
|---|---|---|
| `sentFrom` | `'webapp'`, `'telegram-bot'`, `'cli'`, … | Origin of a user message. **`'cli'` marks CLI-echo traffic**: user/assistant text containing `<command-name>`, `<command-args>`, `<command-message>`, or `<local-command-stdout>` tags renders as a monospace *cli-output* block instead of a chat bubble, and a `<command-name>` block merges with its `<local-command-stdout>` follow-up (`web/src/chat/reducerCliOutput.ts`). |
| `deliveryMode` | `'queue'` \| `'steer'` | Durable delivery intent of a user send (see [pagination](./pagination.md#send-constraints)). Absent = `queue`. |

---

## Decode tree

```
DecryptedMessage.content
└─ unwrap envelope → { role, content: payload, meta? }
   ├─ role: 'user'
   │   ├─ payload is string                → user text
   │   ├─ payload {type:'text', text, attachments?} → user text (+ attachments)
   │   └─ anything else                    → user text (stringified payload)
   └─ role: 'agent' — dispatch on payload.type
       ├─ 'codex'   → generic agent family        (payload.data.type dispatch)
       ├─ 'output'  → Claude SDK passthrough + agy (payload.data.type dispatch)
       ├─ 'event'   → AgentEvent union             (payload.data)
       └─ unknown   → agent text (stringified payload)
```

---

## `role: 'user'` payloads

Reference: `web/src/chat/normalizeUser.ts`.

| Payload | Result |
|---|---|
| bare `string` | user text |
| `{type:'text', text: string, attachments?: AttachmentMetadata[]}` | user text with attachments. Each attachment is accepted only when `id`, `filename`, `mimeType` (strings), `size` (number), `path` (string) are all present; optional `previewUrl`. Invalid entries are skipped, an empty result means "no attachments". |
| anything else | user text = stringified payload (**never drop**) |

---

## `role: 'agent'` — family `'codex'`

`payload.type === 'codex'` (`AGENT_MESSAGE_PAYLOAD_TYPE`, `shared/src/modes.ts:8`) is the **generic agent envelope** used by the non-Claude-SDK flavors (codex, gemini, cursor, copilot, grok, opencode, pi, kimi; agy uses the `'output'` family below). Dispatch on `payload.data.type` (`web/src/chat/normalizeAgent.ts`):

| `data.type` | Payload fields | Renders as |
|---|---|---|
| `message` | `message: string`, `id?` (stream id), `streamSnapshot?` | Agent text. If the text is a bare JSON object with review markers (`findings` / `overall_correctness` / `overall_explanation`), parse it as a **codex review** block instead — unless it is a Pi stream snapshot (`streamSnapshot: true` or `id` matching `/^pi-.+-turn-\d+-message-\d+-text-\d+$/`), which is always plain text. |
| `reasoning` | `message: string`, `id?` | Reasoning (thinking) block. |
| `error` | `message: string` | Error event row. |
| `tool-call` | `callId`, `name?`, `input?`, `description?`, `nativeTitle?/title?`, `nativeKind?/kind?`, `progress?` | Open a tool card keyed by `callId`. |
| `tool-call-result` | `callId`, `output`, `is_error?` | Complete the tool card with the same `callId`. |
| `generated-image` | `imageId`/`image_id`, `fileName`/`file_name`, `mimeType`/`mime_type`, `id?`, `source?` | Inline generated image (fetch via the images REST endpoint). Missing `imageId` ⇒ drop. |
| `context_compacted` | `trigger?`, `preTokens`/`pre_tokens` | `compact` event row. |
| `compact-summary` | `summary`, `tokensBefore?`, `estimatedTokensAfter?` | `compact-summary` event row. |
| `token_count` | `info: {last \| total \| …}`, `thread_id?`, `scope?` | Usage sample (event). Prefer `info.last*` over `info.total*`; `context_tokens` falls back to `input_tokens`; `modelContextWindow` → `context_window`. Unparseable usage ⇒ drop. |
| `thread_goal_updated` | `goal {threadId, objective, status, tokenBudget?, tokensUsed?, timeUsedSeconds?, createdAt?, updatedAt?}`, `threadId?`, `turnId?` | `thread-goal-updated` event. `status` ∈ `active\|paused\|budgetLimited\|usageLimited\|blocked\|complete`; invalid goal ⇒ drop. |
| `thread_goal_cleared` | `threadId?` | `thread-goal-cleared` event. |
| `plan` | `entries`/`items`/`steps`: list of steps | Synthetic completed `update_plan` tool pair (cursor flavor). Steps accept `step\|content\|text\|title\|description` + `status\|state` (normalized to `pending\|in_progress\|completed`). Empty plan ⇒ drop. |
| `plan_update` | `plan`/`update`/`items`/`steps` | Same, codex flavor. |
| `agent-run-start` / `agent-run-update` / `agent-run-trace` | run payload | Background agent-run event rows (windowed separately, see [pagination](./pagination.md#client-windowing-normative-recommendation)). |
| *anything else* | — | **Drop silently** (`normalize.ts`: unknown codex content returns `null`, not a stringified bubble). |

Snake_case/camelCase field pairs above are both accepted — always probe both.

---

## `role: 'agent'` — family `'output'` (Claude SDK passthrough)

`payload.data` is a Claude Code SDK log entry, forwarded verbatim. Envelope-level fields on `data`: `uuid`, `parentUuid`, `isSidechain?`, `parentToolUseId?`, `timestamp?` (ISO-8601 execution-machine clock — parse to epoch ms, fall back to `createdAt`), and the flags below.

**Skip filters — evaluate first** (`isSkippableAgentContent` / `isClaudeChatVisibleMessage`):

- `data.isMeta` or `data.isCompactSummary` truthy ⇒ hidden.
- `data.type === 'rate_limit_event'` or `'tool_progress'` ⇒ hidden.
- `data.type === 'system'` with `subtype` **not** in `{api_error, turn_duration, microcompact_boundary, compact_boundary, away_summary}` ⇒ hidden.
- Empty `away_summary` / empty `agy_message` ⇒ hidden.

Then dispatch on `data.type`:

### `assistant`

`data.message` = `{model?, content, usage?}`. `content` is a string (⇒ one text block) or an array of blocks:

| Block | Fields | Renders as |
|---|---|---|
| `text` | `text` | agent text |
| `thinking` | `thinking` | reasoning |
| `tool_use` | `id`, `name`, `input` | tool card open (`description` convention: `input.description` when present) |

Other block types are ignored. `message.usage` carries `input_tokens`, `output_tokens`, `cache_creation_input_tokens?`, `cache_read_input_tokens?`, `service_tier?`, `context_window?`.

### `user`

Despite the name, these arrive through the agent path (tool results and system-injected turns). `data.message.content` cases:

| Case | Renders as |
|---|---|
| array with `tool_result` blocks `{tool_use_id, content, is_error?, permissions?}` | tool card completion. Prefer entry-level `data.toolUseResult` over the block's `content` when present. `permissions` = `{date, result:'approved'\|'denied', mode?, allowedTools?, decision?}` — merge into the tool card's permission state. |
| string content (any), or sidechain array-of-text | **sidechain marker** `{prompt}` — subagent prompts and system-injected turns; group under the parent Task tool card via `parentToolUseId` (fallback: exact prompt match). |
| non-sidechain array that is *entirely* `text` blocks | a real user message the CLI wrapped as output ⇒ render in the **user** lane. |
| `text` blocks mixed with tool results | agent text blocks. |

### `system` subtypes → event rows

| `subtype` | Fields | Event |
|---|---|---|
| `api_error` | `retryAttempt`, `maxRetries`, `error` | `api-error` |
| `turn_duration` | `durationMs`, `messageId?` | `turn-duration {durationMs, targetMessageId?}` |
| `microcompact_boundary` | `microcompactMetadata {trigger, preTokens, tokensSaved}` | `microcompact` |
| `compact_boundary` | `compactMetadata {trigger, preTokens}` | `compact` |
| `away_summary` | `content: string` | `recap {text}` |

### `summary`

`data.summary: string` ⇒ conversation-summary content block.

### agy (Antigravity) — also in the `'output'` family

| `data.type` | Renders as |
|---|---|
| `agy_message` | Agent text (`data.content`, per-turn `data.model?`). Empty ⇒ skip. Text starting `Inside the task-NNN log` ⇒ compact `AgyTaskLog` chip (synthetic completed tool pair). Echoed raw task results (`[Message] timestamp=…` trailer) are stripped from the prose. |
| `agy_tool_action` | Synthetic **completed** tool pair (tool-call + tool-result, same id — prefer `data.toolUseId`, falling back to the message id). `name === 'SYSTEM_MESSAGE'` ⇒ `AgyAsyncTask` background-task card; `name === 'ERROR_MESSAGE'` ⇒ `AgyError` card (`is_error: true`); otherwise map agy tool names to canonical ones (`run_command`→Bash, `view_file`→Read, `write_to_file`→Write, `replace_file_content`→Edit, `grep_search`→Grep, `list_dir`→LS) and translate arg keys (`CommandLine`→`command`, `TargetFile`→`file_path`, …), stripping agy's result preambles/trailers. See `normalizeAgent.ts` for the exact strip rules. |

### Unknown `'output'` types

A visible `data.type` not matched above ⇒ stringified agent text fallback (unlike the codex family, which drops).

---

## `role: 'agent'` — family `'event'`

`payload.data` is one `AgentEvent` (`web/src/chat/types.ts` lines 17–36). The union is **open-ended** — the last member is `{type: string} & Record<string, unknown>`; tolerate unknown types (render generically or ignore, never crash).

| `type` | Fields |
|---|---|
| `switch` | `mode: 'local' \| 'remote'` |
| `message` | `message: string` |
| `error` | `message: string` |
| `title-changed` | `title: string` |
| `limit-reached` | `endsAt: number`, `limitType: string` |
| `limit-warning` | `utilization: number` (0–1), `endsAt`, `limitType` |
| `ready` | — |
| `api-error` | `retryAttempt`, `maxRetries`, `error: unknown` |
| `turn-duration` | `durationMs`, `targetMessageId?` |
| `microcompact` | `trigger`, `preTokens`, `tokensSaved` |
| `compact` | `trigger`, `preTokens` |
| `compact-summary` | `summary`, `tokensBefore?`, `estimatedTokensAfter?` |
| `recap` | `text` |
| `thread-goal-updated` | `goal: ThreadGoal`, `threadId?`, `turnId?` |
| `thread-goal-cleared` | `threadId?` |
| `abort-restore` | `text` |
| *(catch-all)* | `{type: string, …}` |

Several event rows are also synthesized by the other two families (system subtypes, `context_compacted`, `token-count`, `agent-run-*`) — the renderer should treat them uniformly. Note: `event`-family `message` rows whose text is a `Goal …` status line are filtered by the **hub** at ingest and from REST pages (`isRedundantGoalStatusEventContent`, `shared/src/messages.ts`); clients need no special handling.

---

## Fallback rules

| Situation | Behavior |
|---|---|
| No unwrappable envelope | stringify whole `content` as agent text |
| `role` not `user`/`agent` | stringify `record.content` as agent text |
| user payload unrecognized | stringify as user text |
| `'codex'` family, unknown `data.type` | **drop** (return nothing) |
| `'output'` family, hidden by skip filters | **drop** |
| `'output'` family, visible but unknown `data.type` | stringify as agent text |
| `'event'` family, `data` lacks a string `type` | stringify as agent text |

"Stringify" = a stable JSON serialization (web: `safeStringify`) rendered as plain text. These are the only two legitimate drop paths; everything else must render something.

---

## Truncation marker

At ingest the hub head+tail-truncates any **string longer than 64 KiB found anywhere inside agent-role content** (`hub/src/store/contentCodec.ts`): the stored value becomes first 48 KiB + `\n…[hapi: truncated N chars]…\n` + last 12 KiB. User-role content is never truncated (it is delivered verbatim to the CLI). The operation is idempotent and applied deep (arrays/objects).

Clients must render truncated strings as-is (recognizing the `…[hapi: truncated N chars]…` marker is optional polish), must not assume tool results are complete, and must never choke on the marker.

---

## Permission requests are NOT messages

Pending tool approvals never appear in the message stream. They live on the session object (`shared/src/schemas.ts:167-203`):

```ts
session.agentState = {
  requests?:          Record<requestId, { tool: string, arguments: unknown, createdAt?: number | null }>
  completedRequests?: Record<requestId, {
    tool, arguments, createdAt?, completedAt?,
    status: 'canceled' | 'denied' | 'approved',
    reason?, mode?, allowTools?: string[],
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    answers?: Record<string, string[]>                     // flat    (AskUserQuestion)
            | Record<string, { answers: string[] }>        // nested  (request_user_input)
  }>
}
```

`agentState` updates arrive as a versioned SSE patch — apply it under the version gate described in [sse.md](./sse.md#versioned-patch-algorithm). Render pending `requests` as approval cards interleaved with the chat (the web reducer keys them to the matching `tool_use` when one exists); on resolution the entry moves to `completedRequests`, whose `status`/`answers` back-fill the tool card's permission state. Decide via `POST /api/sessions/:id/permissions/:requestId/approve` (`{mode?, allowTools?, decision?, answers?}`) or `…/deny` (`{decision?}`) — see [rest.md](./rest.md). Session-list badges come precomputed on `SessionSummary.pendingRequestsCount` / `pendingRequests` (≤ 5 entries).

---

## Golden fixtures

The golden fixtures in `shared/fixtures/chat/` are the executable form of this section: input `DecryptedMessage` samples paired with the canonical decoded projection, generated from the web pipeline. A native decode implementation is correct when it reproduces them exactly — when the fixtures and this page disagree, the fixtures win.
