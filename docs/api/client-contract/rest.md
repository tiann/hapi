# REST endpoints

Endpoint tables for native clients, grouped by feature. Request/response shapes reference the Zod schemas in `shared/src/schemas.ts` and `shared/src/apiTypes.ts` (package `@hapi/protocol`) — those schemas, not the prose here, are the field-level source of truth. Route behavior is grounded in `hub/src/web/routes/*.ts`; `web/src/api/client.ts` is the reference consumer.

## Conventions

- All paths below are relative to the hub base URL. Everything under `/api` requires `Authorization: Bearer <JWT>` ([Auth](./auth.md)).
- Path params (`:id`, `:messageId`, …) must be URL-encoded (the web client uses `encodeURIComponent` throughout).
- Request bodies are JSON (`content-type: application/json`) with **one exception**: `POST /api/voice/transcription` is `multipart/form-data`. Responses are JSON unless noted (generated images and scratchlist attachments return raw bytes).
- Bodies are validated with Zod; failures return `400` (see [Errors](./errors.md)).
- **gzip:** the hub gzips `/api/*` JSON responses when `Accept-Encoding` accepts gzip. Negotiation is q-value aware (`acceptsGzip` in `hub/src/web/sseCompression.ts`): `gzip;q=0` is honored as a refusal, `*` counts unless a `gzip` entry overrides it. Send a normal `Accept-Encoding: gzip` and decompress transparently. The SSE stream is gzip-compressed separately with per-event flush — see [SSE](./sse.md). Source: `hub/src/web/server.ts`.
- Several endpoints are **RPC-wrapped**: the hub forwards to the session's CLI process over Socket.IO and relays the result. These can fail with HTTP 200 + `{success: false, error}` or with 503 — see [Errors](./errors.md#rpc-wrapped-endpoints).

## Tier 1 — required for v1 clients

### Health

Source: `hub/src/web/server.ts`.

| Method & path | Request | Response |
|---|---|---|
| `GET /health` (no auth) | — | `{status: 'ok', protocolVersion: number, capabilities: {workGraph?, titleSuggestion?}}` — additive capabilities, ignore unknown keys |

### Sessions — list & detail

Source: `hub/src/web/routes/sessions.ts`; shapes `SessionSchema` (`shared/src/schemas.ts`), `SessionSummary` (`shared/src/sessionSummary.ts`).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/sessions` | Query: `limit?` (1–500), `order?=updatedAt` | `{sessions: (SessionSummary & {futureScheduledMessageCount, nextScheduledAt})[]}` |
| `GET /api/sessions/:id` | — | `{session: Session}` (full record incl. `metadata`, `agentState`, `todos`, versions) |

Default list order: globalPinned → pinned → active → pending-request count → `updatedAt` desc; `order=updatedAt` gives pure recency. List badges come from `SessionSummary.pendingRequestsCount` (authoritative total) and `pendingRequests` (capped at 5, oldest-first) — do not derive counts from `pendingRequests.length`.

### Sessions — lifecycle

Source: `hub/src/web/routes/sessions.ts`; request schemas in `shared/src/apiTypes.ts`.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/sessions/:id/resume` | `{permissionMode?}` (`ResumeSessionRequestSchema`) | `{type: 'success', sessionId}` |
| `POST /api/sessions/:id/reopen` | `{}` | `{ok: true, sessionId, resumed: boolean, cursorSessionProtocol?}` (`ReopenSessionResponseSchema`); `422 {error, missing[]}` if metadata is incomplete |
| `POST /api/sessions/:id/abort` | `{}` | `{ok: true}` (active sessions only) |
| `POST /api/sessions/:id/archive` | `{}` | `{ok: true}` or `{ok: true, alreadyArchived: true}`; 409 for a plain inactive session |
| `DELETE /api/sessions/:id` | — | `{ok: true}`; 409 while active (archive first) |
| `PATCH /api/sessions/:id` | `{name}` (1–255 chars) | `{ok: true}` (rename) |
| `PATCH /api/sessions/:id/summary` | `{text}` (1–255 chars) | `{ok: true}` |
| `PUT /api/sessions/:id/pin` | `{mode: 'none'\|'project'\|'global'}` | `{ok: true}` |
| `POST /api/sessions/:id/switch` | `{}` | `{ok: true}` — hands terminal-controlled session over to remote control |
| `POST /api/sessions/:id/title-suggestion` | — | `{title}`; errors pass through 422/429/502/503 |
| `GET /api/sessions/:id/slash-commands` | — | `SlashCommandsResponse` `{success, commands?, error?}` |
| `GET /api/sessions/:id/skills` | — | `SkillsResponse`-shaped `{success, ...}` |

::: warning resume / reopen may return a different sessionId
Both endpoints return the id of the session that now carries the conversation — which **may differ from the id you called them on** (fresh spawn under a new id; the old row is superseded). Clients must migrate composer drafts and replace navigation to the returned id. Reference: `web/src/routes/sessions/followSupersedingSession.ts`; the durable link also appears as `metadata.supersededBySessionId` on the old session.
:::

Optional for v1 (endpoints exist; the v1 native scope does not require them): `POST /api/sessions/:id/fork` `{messageLocalId?}` → `{sessionId}`, `POST /api/sessions/:id/rewind` `{messageLocalId}` → `{success: true}`, `GET /api/sessions/:id/export` (413 when too large).

### Messages

Source: `hub/src/web/routes/messages.ts`; schemas `MessagesQuerySchema`, `SendMessageRequestSchema`, `QueuedStateRequestSchema` (`shared/src/apiTypes.ts`), responses `CancelMessageResponseSchema`, `SteerQueuedMessageResponseSchema` (`shared/src/schemas.ts`). Unknown steer delivery is durable and user-resolvable; native clients must implement the same transitions.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/sessions/:id/messages` | Query: `limit?` (1–200, default 50), cursor pairs `beforeSeq+beforeAt` \| `afterSeq+afterAt` (+ optional `untilSeq+untilAt`, `epoch` with `after`) | `MessagesResponse` `{messages: DecryptedMessage[], page: {direction, limit, epoch, reset, nextBefore*/nextAfter*, snapshotHead*, hasMore}}` — full cursor semantics in [Pagination](./pagination.md) |
| `POST /api/sessions/:id/messages` | `{text, localId?, attachments?, scheduledAt?, deliveryMode?: 'queue'\|'steer'}` — text or attachments required; `scheduledAt` requires `localId`, must be ≤ 7 days out, excludes attachments and steer | `{ok: true}` — the message itself arrives via SSE (`message-received`), reconciled by `localId` |
| `DELETE /api/sessions/:id/messages/:messageId` | — | `{status: 'cancelled', localId}` \| `{status: 'invoked', message}` \| `{status: 'busy', localId}` (cancel; `busy` = steer still resolving) |
| `POST /api/sessions/:id/messages/:messageId/steer` | — | `{status: 'steered', localId}` \| `{status: 'invoked', message}` \| `{status: 'failed', error, localId}` |
| `POST /api/sessions/:id/messages/:messageId/retry` | — | `{status: 'retried', localId}` \| `{status: 'already-queued', localId}` \| `{status: 'retry-unavailable', localId}` \| `{status: 'invoked', message}` \| `{status: 'not-found'}` — explicit retry only; never automatic replay |
| `POST /api/sessions/:id/messages/queued-state` | `{localIds: string[]}` (≤ 1000, deduped) | `{queuedLocalIds: string[], invokedLocalMessages: [{localId, invokedAt}]}` — resync optimistic sends after reconnect |

The hub stamps `sentFrom: 'webapp'` on REST-sent messages server-side; the request body has no such field.

### Permissions

Source: `hub/src/web/routes/permissions.ts`. Pending requests are **not messages**: they live in `session.agentState.requests` (keyed by request id) and move to `agentState.completedRequests` when resolved — schemas `AgentStateRequestSchema` / `AgentStateCompletedRequestSchema` in `shared/src/schemas.ts`.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/sessions/:id/permissions/:requestId/approve` | `{mode?, allowTools?: string[], decision?, answers?}` | `{ok: true}` |
| `POST /api/sessions/:id/permissions/:requestId/deny` | `{decision?}` | `{ok: true}` |

- `decision`: `'approved' | 'approved_for_session' | 'denied' | 'abort'`.
- `mode`: optionally switch permission mode while approving; validated against the session flavor.
- `answers` has **two formats**, matching the requesting tool: flat `Record<string, string[]>` (AskUserQuestion) or nested `Record<string, {answers: string[]}>` (request_user_input). Both routes 404 with `Request not found` if the id is not currently pending, and 409 `session_inactive` when the session is inactive.

### Session config — mode / model / effort (per flavor)

Source: `hub/src/web/routes/sessions.ts`; flavor gates in `shared/src/modes.ts` (`getPermissionModesForFlavor`) and `shared/src/flavors.ts` (`supportsModelChange`, `supportsEffort`). Wrong-flavor calls return 400; several are additionally rejected with 409 when the session is terminal-controlled (`agentState.controlledByUser === true`).

| Method & path | Request | Applies to |
|---|---|---|
| `POST /api/sessions/:id/permission-mode` | `{mode: PermissionMode}` | All flavors except `pi` (per-flavor allowed sets in `modes.ts`) |
| `POST /api/sessions/:id/model` | `{model: string \| {provider, modelId} \| null}` | All flavors (`supportsModelChange` is true for every current flavor); remote-only for codex/cursor/grok |
| `POST /api/sessions/:id/effort` | `{effort: string \| null}` | claude, grok, pi (`supportsEffort`) |
| `POST /api/sessions/:id/model-reasoning-effort` | `{modelReasoningEffort: string \| null}` | codex, opencode (remote-only) |
| `POST /api/sessions/:id/service-tier` | `{serviceTier: 'fast' \| 'standard'}` | codex (remote-only) |
| `POST /api/sessions/:id/collaboration-mode` | `{mode: 'default' \| 'plan'}` | codex (remote-only) |
| `POST /api/sessions/:id/copilot-agent-mode` | `{mode}` | copilot (remote-only) |

All respond `{ok: true}`; apply-failures return 409 with a message. Model/effort **catalogs** (RPC-wrapped; all return `{success, ...} \| {success: false, error}`):

| Method & path | Notes |
|---|---|
| `GET /api/sessions/:id/codex-models`, `/opencode-models`, `/cursor-models`, `/grok-models`, `/copilot-models`, `/pi-models` | Active session of the matching flavor; 400 otherwise |
| `GET /api/sessions/:id/opencode-reasoning-effort-options`, `/grok-reasoning-effort-options` | Same pattern |
| `GET /api/machines/:id/agy-models`, `/pi-models`, `/codex-models`, `/cursor-models` | Machine-level (pre-spawn pickers) |
| `GET /api/machines/:id/opencode-models?cwd=`, `/grok-models?cwd=`, `/copilot-models?cwd=` | `cwd` query required (400 without) |

### Machines & spawning

Source: `hub/src/web/routes/machines.ts`; schemas `SpawnSessionRequestSchema`, `MachineListDirectoryRequestSchema`, `MachinePathsExistsRequestSchema`, `RenameMachineRequestSchema` (`shared/src/apiTypes.ts`), `MachineSchema` (`shared/src/schemas.ts`).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/machines` | — | `{machines: Machine[]}` (online machines in the caller's namespace) |
| `PATCH /api/machines/:id` | `{displayName}` (trimmed; ≤ 64 chars; empty clears back to hostname) | `{ok: true}` |
| `GET /api/machines/:id/agent-availability` | — | `{agents: {agent, available, reason?: 'not_found'\|'invalid_configuration'}[]}`; 409 `runner_upgrade_required` on old runners |
| `POST /api/machines/:id/spawn` | `{directory, agent?, model?, effort?, modelReasoningEffort?, yolo?, permissionMode?, sessionType?: 'simple'\|'worktree', worktreeName?, serviceTier?, collaborationMode?, copilotAgentMode?, startingMode?: 'remote'\|'pty'}` | `{type: 'success', sessionId}` \| `{type: 'error', message, code?, agent?}` (agy accepts only `remote`) |
| `POST /api/machines/:id/list-directory` | `{path, includeHidden?}` | `{success, entries?: (DirectoryEntry & {isGitRepo?})[], error?}` |
| `POST /api/machines/:id/paths/exists` | `{paths: string[]}` (≤ 1000) | `{exists: Record<string, boolean>, outsideWorkspaceRoots?: string[]}` |
| `POST /api/machines/:id/restart-runner` | `{}` | `{message}`; errors carry `code: 'machine_not_found' \| 'machine_offline'` |

Note the spawn response is discriminated on `type`, not HTTP status — a failed
spawn is still HTTP 200. Stable spawn failure codes are
`agent_unavailable`, `runner_upgrade_required`, and
`outside_workspace_roots`. Clients should fetch Agent availability when the
machine is selected and use that result to drive the form. The runner performs
the authoritative availability check as part of spawning, covering changes
after the form-level query without requiring a duplicate client RPC.
Availability checks executables and static runner configuration only; it does
not execute the Agent or verify account/login state.

### Git & files (RPC-wrapped)

Source: `hub/src/web/routes/git.ts`. Git endpoints return the **raw command output** — `GitCommandResponse` `{success, stdout?, stderr?, exitCode?, error?}` — and the client parses `stdout` itself (reference parsers: `web/src/lib/gitParsers.ts`).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/sessions/:id/git-status` | — | `GitCommandResponse` (raw `git status` stdout) |
| `GET /api/sessions/:id/git-diff-numstat` | Query: `staged=true\|false` | `GitCommandResponse` (raw `git diff --numstat` stdout) |
| `GET /api/sessions/:id/git-diff-file` | Query: `path` (required), `staged?` | `GitCommandResponse` (raw unified diff) |
| `GET /api/sessions/:id/file` | Query: `path` (required) | `{success, content?, size?, modified?, error?}` — `content` is **base64** (decode before display; web ref: `web/src/routes/sessions/file.tsx`) |
| `GET /api/sessions/:id/files` | Query: `query?`, `limit?` (1–500, default 200) | `{success, files: [{fileName, filePath, fullPath, fileType: 'file', size?, modified?}]}` (ripgrep-backed search) |
| `GET /api/sessions/:id/directory` | Query: `path?` (empty = session root) | `{success, entries?: [{name, type: 'file'\|'directory'\|'other', size?, modified?}], error?}` |

When the session has no `metadata.path` yet, these return HTTP 200 `{success: false, error: 'Session path not available'}`.

### Generated images

Source: `hub/src/web/routes/git.ts` (same file).

| Method & path | Response |
|---|---|
| `GET /api/sessions/:id/generated-images/:imageId` | **Raw bytes** with `Content-Type`, `Content-Disposition`, `ETag: "<imageId>"`, `Cache-Control: private, max-age=31536000, immutable`; `404` JSON when missing |

The image id is an immutable content fingerprint, so it doubles as the ETag: send `If-None-Match` and the hub answers `304` *without* the CLI round-trip. Cache aggressively (iOS: URLCache honors this automatically; Android: OkHttp cache).

### Uploads (message attachments)

Source: `hub/src/web/routes/sessions.ts` (`UploadFileRequestSchema`).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/sessions/:id/upload` | JSON `{filename, content, mimeType}` — `content` is **base64**; decoded size limit 50 MB → `413` | `{success, path?, error?}` — pass the resulting metadata in `attachments` of send-message |
| `POST /api/sessions/:id/upload/delete` | `{path}` | `{success, error?}` |

Uploads are JSON+base64, **not** multipart. Both require an active session.

### Scratchlist

Source: `hub/src/web/routes/sessions.ts` (scratchlist section); schemas `ScratchlistEntryCreateRequestSchema`, `ScratchlistEntryUpdateRequestSchema`, caps `SCRATCHLIST_MAX_ENTRIES = 200`, `SCRATCHLIST_MAX_TEXT_LENGTH = 10000` (`shared/src/apiTypes.ts`).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/sessions/:id/scratchlist` | — | `{entries: ScratchlistEntry[]}` (`{entryId, text, createdAt, updatedAt, attachments[]}`) |
| `POST /api/sessions/:id/scratchlist` | `{text, entryId?, createdAt?, attachments?}` (text ≤ 10 000; text or attachments required) | `201 {entry}`; `200 {entry}` when `entryId` already exists (idempotent retry); `409 code: 'scratchlist_at_cap'` at 200 entries |
| `PUT /api/sessions/:id/scratchlist/:entryId` | `{text?, attachments?}` (at least one) | `{entry}` |
| `DELETE /api/sessions/:id/scratchlist/:entryId` | — | `{ok: true}` |
| `GET /api/sessions/:id/scratchlist/limits` | — | `{limits}` (attachment size/count/byte budgets) |
| `POST /api/sessions/:id/scratchlist/upload` | JSON `{filename, content (base64), mimeType}` | `{success, attachment}`; `413 code: 'scratchlist_attachment_too_large'` |
| `GET /api/sessions/:id/scratchlist/attachments/:attachmentId` | — | **Raw bytes** (`Content-Type` from stored metadata) |
| `DELETE /api/sessions/:id/scratchlist/attachments/:attachmentId` | — | `{ok: true}`; `409 code: 'scratchlist_attachment_in_use'` while referenced by an entry |

Mutations bump `scratchlistUpdatedAt` in the session's SSE patch — use it as a refetch trigger, not as data.

### Voice dictation (the one multipart endpoint)

Source: `hub/src/web/routes/voice.ts`.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/voice/transcription/providers` | — | `{providers: [{id, label, modes}]}` — only providers whose keys are configured on the hub |
| `POST /api/voice/transcription` | `multipart/form-data`: `file` (audio, ≤ 25 MB, `audio/*` or webm/mp4), `provider` (`openai`\|`elevenlabs`\|`deepgram`\|`groq`\|`openai-compatible`), `mode` = `standard`, `language?` (BCP-47-ish, ≤ 35 chars) | `{text, language?}`; `413` body too large, `400` bad field |

The realtime-token, voice-assistant token, and WebSocket-proxy endpoints under `/api/voice/*` belong to the live voice assistant — out of scope for v1.

### Usage & storage (owner-only)

Source: `hub/src/web/routes/usage.ts`, `hub/src/web/routes/storage.ts`. Both `403` unless namespace is `default` ([Auth → Namespaces](./auth.md#namespaces)).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/usage/summary` | Query: `range=7d\|30d\|all` (default 7d), `timeZone` (IANA, validated) | `UsageSummaryResponse` `{range, totals, daily[], byAgent[], byModel[], updatedAt}` |
| `GET /api/storage/sqlite` | — | `{path, databaseBytes, walBytes, shmBytes, totalBytes}` |

### Devices (FCM push)

Source: `hub/src/web/routes/devices.ts`; full push contract in [`native-companion-contract.md`](../native-companion-contract.md).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/devices/register` | `{token, platform: 'phone'\|'wear', deviceId}` (deviceId: any stable 1–128-char install id) | `{ok: true}` (upsert) |
| `DELETE /api/devices/register` | `{token}` | `{ok: true}` |

### Visibility

Source: `hub/src/web/routes/events.ts` (`POST /visibility`).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/visibility` | `{subscriptionId, visibility: 'visible'\|'hidden'}` | `{ok: true}`; `404` when the SSE subscription is gone |

`subscriptionId` comes from the SSE `connection-changed` event ([SSE](./sse.md)). Report foreground/background transitions so the hub can suppress redundant push notifications while the app is visibly connected.

### Hub settings (read)

Source: `hub/src/web/routes/hubSettings.ts`.

| Method & path | Response |
|---|---|
| `GET /api/hub-settings` | `{sessionSummaryContract: boolean, sessionSummaryInChat: boolean}` — readable by any namespace |

### SSE

`GET /api/events` is the realtime channel — subscription params, resume handshake, and reconnect policy are specified in [SSE](./sse.md). Its gzip behavior differs from the JSON endpoints (streaming compression with per-event flush), also covered there.

## Tier 2 — out of scope for v1

These exist on the hub but v1 native clients must not implement or call them:

| Area | Paths | Why out of scope |
|------|-------|------------------|
| Codex Desktop import | `/api/codex/*` (`hub/src/web/routes/codexDesktop.ts`) | Desktop-import tooling |
| Pi session import | `/api/pi/*`, `/api/sessions/:id/pi-*` (`hub/src/web/routes/piSessions.ts`, `sessions.ts`) | Import tooling (the `pi-models` catalog above is the one exception) |
| Work graph | `/api/work-graph/*` (`hub/src/web/routes/workGraph.ts`) | Web-only feature |
| Web Push | `/api/push/*` (`hub/src/web/routes/push.ts`) | Browser Push API; natives use `/api/devices` (FCM) |
| Hub settings write | `PUT /api/hub-settings` | Owner-only hub administration |
| Telegram | `POST /api/bind` | Telegram Mini App binding only |
| Voice assistant | `/api/voice/token`, `/voices`, `/backend`, `/gemini-token`, `/qwen-token`, `/qwen-ws`, `/gemini-ws`, `/transcription/realtime-token`, `/telemetry`, credentials endpoints | Realtime assistant, not v1 dictation |
| Cursor maintenance | `/api/sessions/:id/migrate-to-acp`, `/cursor-chat-store` | Desktop store migration |
| Session export | `GET /api/sessions/:id/export` | Feeds the share/export feature, excluded from v1 |
| **CLI plane** | `/cli/*` (`hub/src/web/routes/cli.ts`) | **Forbidden for clients** — internal CLI↔hub surface; authenticates with the raw access token instead of a JWT and bypasses the client middleware. Never call it from a client, and never send the access token as a bearer anywhere except `POST /api/auth`'s JSON body |
