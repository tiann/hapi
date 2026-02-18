# HAPI Test Coverage Plan

Comprehensive test plan for 8 modules with zero test coverage.
Generated 2026-02-18 from beads audit (hapi-cu9, hapi-8fh, hapi-yrc, hapi-sqc, hapi-p91, hapi-7y6, hapi-s9p, hapi-dkw).

---

## P1: hapi-cu9 — Test shared/@hapi/protocol Zod schemas

**File:** `shared/src/schemas.ts` (193 LOC)
**Test file:** `shared/src/schemas.test.ts`
**Runner:** bun:test
**Mocking:** None — pure Zod validation

### Exports

- `PermissionModeSchema` — Zod enum for permission modes
- `ModelModeSchema` — Zod enum for model modes
- `WorktreeMetadataSchema` — Zod object for worktree metadata
- `MetadataSchema` — Zod object for session metadata
- `AgentStateRequestSchema` — Zod object for agent state requests
- `AgentStateCompletedRequestSchema` — Zod object for completed requests
- `AgentStateSchema` — Zod object for agent state
- `TodoItemSchema` — Zod object for todo items
- `TodosSchema` — Zod array of TodoItemSchema
- `AttachmentMetadataSchema` — Zod object for file attachments
- `DecryptedMessageSchema` — Zod object for decrypted messages
- `SessionSchema` — Zod object for sessions
- `SyncEventSchema` — Discriminated union for sync events

### Test Cases (~17 cases)

1. PermissionModeSchema accepts valid modes from PERMISSION_MODES
2. PermissionModeSchema rejects invalid strings
3. WorktreeMetadataSchema parses valid worktree with all fields
4. WorktreeMetadataSchema parses worktree with optional fields omitted
5. MetadataSchema parses complete metadata with all optional fields
6. MetadataSchema parses minimal metadata (only path, host required)
7. AgentStateCompletedRequestSchema parses flat answers (Record<string, string[]>)
8. AgentStateCompletedRequestSchema parses nested answers (Record<string, { answers: string[] }>)
9. TodoItemSchema validates status enum (pending/in_progress/completed)
10. TodoItemSchema validates priority enum (high/medium/low)
11. AttachmentMetadataSchema parses attachment with previewUrl
12. AttachmentMetadataSchema parses attachment without previewUrl
13. SessionSchema parses complete session with all fields
14. SyncEventSchema discriminates 'session-added' type
15. SyncEventSchema discriminates 'message-received' with DecryptedMessage
16. SyncEventSchema discriminates 'toast' with nested data object
17. SyncEventSchema rejects invalid discriminated union type

---

## P1: hapi-8fh — Test web/chat normalization pipeline

**Files:** `web/src/chat/normalize.ts` + `normalizeAgent.ts` + `normalizeUser.ts` (~560 LOC)
**Test file:** `web/src/chat/normalize.test.ts`
**Runner:** vitest
**Mocking:** `unwrapRoleWrappedRecordEnvelope`, `safeStringify` from @hapi/protocol; internal helpers

### Exports

- `normalizeDecryptedMessage(message): NormalizedMessage | null` — Main entry: routes by role
- `isSkippableAgentContent(content): boolean` — Checks isMeta or isCompactSummary
- `isCodexContent(content): boolean` — Checks content.type === 'codex'
- `normalizeAgentRecord(messageId, localId, createdAt, content, meta): NormalizedMessage | null` — Agent message normalizer
- `normalizeUserRecord(messageId, localId, createdAt, content, meta): NormalizedMessage | null` — User message normalizer

### Test Cases — normalize.ts (~10 cases)

1. Returns fallback normalized message when unwrapRoleWrappedRecordEnvelope returns null
2. Normalizes user role message with valid content
3. Returns fallback when normalizeUserRecord returns null for user role
4. Returns null for agent role with skippable content
5. Normalizes agent role message with valid content
6. Returns null for codex content when normalizeAgentRecord returns null
7. Preserves status and originalText fields from DecryptedMessage
8. Uses safeStringify for fallback content serialization
9. Passes through meta field from role-wrapped record
10. Handles undefined role (falls through to default agent format)

### Test Cases — normalizeAgent.ts (~19 cases)

11. isSkippableAgentContent returns true for isMeta=true
12. isSkippableAgentContent returns true for isCompactSummary=true
13. isCodexContent returns true for content.type === 'codex'
14. Normalizes output/assistant with text blocks
15. Normalizes output/assistant with thinking blocks (renamed to reasoning)
16. Normalizes output/assistant with tool_use blocks
17. Extracts usage tokens from message.usage
18. Normalizes output/user for sidechain messages
19. Normalizes output/user tool_result blocks with permissions
20. Normalizes system/api_error subtype
21. Normalizes system/turn_duration subtype
22. Normalizes system/microcompact_boundary subtype
23. Normalizes codex/message type
24. Normalizes codex/reasoning type
25. Normalizes codex/tool-call type
26. Normalizes codex/plan type (converts entries to TodoWrite format)
27. normalizeToolResultPermissions parses valid permission with all fields
28. normalizeToolResultPermissions handles missing date (returns undefined)
29. normalizeToolResultPermissions validates result enum (approved/denied only)

### Test Cases — normalizeUser.ts (~7 cases)

30. Normalizes string content
31. Normalizes object content with type='text'
32. Parses and attaches valid attachments array
33. Filters out invalid attachments
34. Includes previewUrl when present
35. Returns null for invalid content types
36. Returns undefined attachments when array is empty

---

## P1: hapi-yrc — Test web/lib/gitParsers

**File:** `web/src/lib/gitParsers.ts` (346 LOC)
**Test file:** `web/src/lib/gitParsers.test.ts`
**Runner:** vitest
**Mocking:** None — pure string parsing

### Exports

- `parseStatusSummaryV2(statusOutput): GitStatusSummaryV2` — Parses git status --porcelain=v2
- `parseNumStat(numStatOutput): DiffSummary` — Parses git diff --numstat
- `createDiffStatsMap(summary): Record<string, {...}>` — Lookup map for diff stats
- `getCurrentBranchV2(summary): string | null` — Extracts current branch name
- `buildGitStatusFiles(statusOutput, unstagedDiff, stagedDiff): GitStatusFiles` — Unified git status structure

### Test Cases (~18 cases)

1. parseStatusSummaryV2 parses branch.oid header
2. parseStatusSummaryV2 parses branch.head header
3. parseStatusSummaryV2 parses branch.upstream and branch.ab headers
4. parseStatusSummaryV2 parses ordinary file changes (1 prefix)
5. parseStatusSummaryV2 parses rename/copy changes (2 prefix) with from/path
6. parseStatusSummaryV2 parses unmerged files (u prefix)
7. parseStatusSummaryV2 parses untracked files (? prefix)
8. parseStatusSummaryV2 parses ignored files (! prefix)
9. parseNumStat parses text file changes with insertions/deletions
10. parseNumStat detects binary files (- for additions/deletions)
11. parseNumStat accumulates totals correctly
12. createDiffStatsMap normalizes rename paths (path => oldPath mapping)
13. getCurrentBranchV2 returns null for detached head
14. getCurrentBranchV2 returns null for initial branch
15. buildGitStatusFiles merges staged and unstaged changes
16. buildGitStatusFiles applies diff stats to file entries
17. buildGitStatusFiles handles untracked directories (ending with /)
18. parseStatusSummaryV2 handles empty input

---

## P2: hapi-sqc — Test web/chat reconciliation

**File:** `web/src/chat/reconcile.ts` (226 LOC)
**Test file:** `web/src/chat/reconcile.test.ts`
**Runner:** vitest
**Mocking:** None — pure functions

### Exports

- `reconcileChatBlocks(nextBlocks, prevById): { blocks, byId }` — Reconciles chat blocks for React referential equality

### Test Cases (~13 cases)

1. Returns same block reference when content is identical (referential equality)
2. Returns new block reference when content differs
3. Builds byId index map for all blocks
4. Recursively indexes tool-call children
5. areUserTextBlocksEqual compares text, status, originalText, localId, createdAt, meta
6. areAgentTextBlocksEqual compares text, localId, createdAt, meta
7. arePermissionsEqual compares all fields including allowedTools array
8. areAnswersEqual handles flat answers format (Record<string, string[]>)
9. areAnswersEqual handles nested answers format (Record<string, { answers: string[] }>)
10. areAnswersEqual normalizes both formats for comparison
11. areToolCallsEqual compares tool state, input, result, and recursive children
12. Preserves tool-call when children are identical
13. Creates new tool-call when children change

---

## P2: hapi-p91 — Test hub/store layer

**Files:** `hub/src/store/sessions.ts` + `machines.ts` + `messages.ts` (~470 LOC)
**Test file:** `hub/src/store/store.test.ts`
**Runner:** bun:test
**Mocking:** In-memory SQLite via `new Database(':memory:')`

### Exports — sessions.ts

- `getOrCreateSession(db, tag, metadata, agentState, namespace)` — Get or create by tag
- `updateSessionMetadata(db, id, metadata, expectedVersion, namespace, options)` — Optimistic concurrency update
- `updateSessionAgentState(db, id, agentState, expectedVersion, namespace)` — Update agent state
- `setSessionTodos(db, id, todos, todosUpdatedAt, namespace)` — Timestamp-guarded todo update
- `getSession(db, id)`, `getSessionByNamespace(db, id, namespace)` — Lookups
- `getSessions(db)`, `getSessionsByNamespace(db, namespace)` — List
- `deleteSession(db, id, namespace)` — Delete

### Exports — machines.ts

- `getOrCreateMachine(db, id, metadata, runnerState, namespace)` — Get or create machine
- `updateMachineMetadata(db, id, metadata, expectedVersion, namespace)` — Update metadata
- `updateMachineRunnerState(db, id, runnerState, expectedVersion, namespace)` — Update runner state + set active
- `getMachine(db, id)`, `getMachineByNamespace(db, id, namespace)` — Lookups
- `getMachines(db)`, `getMachinesByNamespace(db, namespace)` — List

### Exports — messages.ts

- `addMessage(db, sessionId, content, localId?)` — Add with dedup on localId
- `getMessages(db, sessionId, limit, beforeSeq?)` — Paginated fetch
- `getMessagesAfter(db, sessionId, afterSeq, limit)` — Fetch after seq
- `getMaxSeq(db, sessionId)` — Max sequence number
- `mergeSessionMessages(db, fromSessionId, toSessionId)` — Merge messages between sessions

### Test Cases — sessions (~13 cases)

1. getOrCreateSession returns existing session if tag + namespace match
2. getOrCreateSession creates new session with UUID and timestamp
3. getOrCreateSession initializes metadata_version and agent_state_version to 1
4. updateSessionMetadata increments version on success
5. updateSessionMetadata returns conflict when expectedVersion mismatches
6. updateSessionMetadata touches updated_at when touchUpdatedAt is true
7. updateSessionMetadata does not touch updated_at when touchUpdatedAt is false
8. updateSessionAgentState handles null agentState
9. updateSessionAgentState always increments seq
10. setSessionTodos updates only if todosUpdatedAt is newer
11. setSessionTodos does not update if existing timestamp is newer (race protection)
12. getSessionByNamespace returns null when namespace doesn't match
13. deleteSession returns true when deleted, false when not found

### Test Cases — machines (~10 cases)

14. getOrCreateMachine returns existing machine if ID exists
15. getOrCreateMachine throws if namespace mismatches existing machine
16. getOrCreateMachine creates new machine with version 1
17. updateMachineMetadata increments version on success
18. updateMachineMetadata returns conflict on version mismatch
19. updateMachineRunnerState sets active=1 and active_at=now
20. updateMachineRunnerState handles null runnerState
21. getMachineByNamespace returns null for namespace mismatch
22. getMachines orders by updated_at DESC
23. getMachinesByNamespace filters by namespace

### Test Cases — messages (~13 cases)

24. addMessage returns existing message if localId already exists (dedup)
25. addMessage auto-increments seq starting from 1
26. addMessage creates unique ID with randomUUID
27. getMessages returns in ascending seq order
28. getMessages limits to max 200 messages
29. getMessages paginates with beforeSeq
30. getMessagesAfter returns messages with seq > afterSeq
31. getMaxSeq returns 0 for empty session
32. mergeSessionMessages offsets seq when merging into non-empty session
33. mergeSessionMessages detects and clears localId collisions
34. mergeSessionMessages uses transaction (rollback on error)
35. mergeSessionMessages returns moved count and old/new maxSeq
36. mergeSessionMessages no-ops if fromSessionId === toSessionId

---

## P2: hapi-7y6 — Test cli/BasePermissionHandler auto-approval logic

**File:** `cli/src/modules/common/permission/BasePermissionHandler.ts` (213 LOC)
**Test file:** `cli/src/modules/common/permission/BasePermissionHandler.test.ts`
**Runner:** bun:test
**Mocking:** `PermissionHandlerClient` (rpcHandlerManager, updateAgentState)

### Exports

- `BasePermissionHandler<TResponse, TResult>` — Abstract base class
- `resolveAutoApprovalDecision(mode, toolName, toolCallId, ruleOverrides?)` — Core auto-approval logic

### Test Cases (~13 cases)

1. Returns 'approved' for 'change_title' tool in safe-yolo mode
2. Returns 'approved_for_session' for 'change_title' tool in yolo mode
3. Returns 'approved' for 'happy__change_title' MCP tool
4. Returns 'approved_for_session' in yolo mode for any tool
5. Returns 'approved' in safe-yolo mode for any tool
6. Returns 'approved' in read-only mode for non-write tools
7. Returns null in read-only mode for write tools (Write, Edit, create, delete, patch)
8. Checks tool ID hints (lowercased matching)
9. Accepts custom ruleOverrides for alwaysToolNameHints
10. Accepts custom ruleOverrides for writeToolNameHints
11. addPendingRequest adds to pendingRequests map and updates agentState.requests
12. finalizeRequest moves request to completedRequests with completion data
13. cancelPendingRequests clears all pending and marks as canceled in agentState

---

## P2: hapi-s9p + P3: hapi-dkw — Hub integration tests (SyncEngine + API routes)

> **Revised per reviewer feedback.** Instead of deep-mocking SyncEngine internals for unit tests
> and separately mocking SyncEngine again for route tests, these two beads are merged into a single
> integration test suite. Uses a real SyncEngine backed by in-memory SQLite, exercised through
> Hono's test client. Fewer mocks, higher confidence, tests the actual request→engine→store path.

**Files under test:**
- `hub/src/sync/syncEngine.ts` (470 LOC) — Central orchestrator
- `hub/src/web/routes/sessions.ts` + `machines.ts` + `git.ts` + `auth.ts` (~1200 LOC) — HTTP layer

**Test file:** `hub/src/web/integration.test.ts`
**Runner:** bun:test
**Test harness style:** Real SyncEngine + in-memory SQLite + Hono `app.request()`, with a contract-driven Socket.IO test double (RPC + broadcast paths).

### Test Harness Contract (required)

1. **Web app bootstrap parity with production**
   - Build a Hono app with the same auth order as `createWebApp`: mount `/api/auth` first, then apply `createAuthMiddleware(jwtSecret)`, then mount protected routes.
   - Minimum protected route mounts for this suite: sessions, machines, git.
   - If `createWebApp` is exported later, prefer it directly; otherwise keep a test-only builder mirroring the same route/middleware order.

2. **Core dependencies**
   - `db = new Database(':memory:')`; `initSchema(db)`
   - `store = new Store(db)`
   - `syncEngine = new SyncEngine(store, ioStub, rpcRegistryStub, sseManager)`
   - `jwtSecret = crypto.getRandomValues(new Uint8Array(32))` (or deterministic fixed key for stable token assertions)

3. **Socket.IO stub contract (must support both paths)**
   - `ioStub.of('/cli')` returns namespace object with:
     - `sockets: Map<string, SocketLike>`
     - `to(room).emit(event, payload)` (broadcast path used by message fanout)
   - `SocketLike` must support `timeout(ms).emitWithAck('rpc-request', payload)` (RPC path used by `rpcGateway`).

4. **RPC registry stub contract**
   - `getSocketIdForMethod(method)` returns a socket id registered by test setup.
   - Method keys follow current engine format: `${sessionId}:${method}` and `${machineId}:${method}`.

5. **Auth fixture policy**
   - Protected routes: use signed JWT (`HS256`) with payload `{ uid, ns }` and send `Authorization: Bearer <token>`.
   - `/auth` access-token lane is required.
   - `/auth` Telegram lane is optional unless the suite explicitly wires config + Telegram init-data validation fixtures.

### Resume-flow fixture recipe (required for Phase 2)

- Seed session with metadata containing `path`, `flavor`, resume token field (`claudeSessionId` / `codexSessionId` / etc.), and machine/host hints where relevant.
- Seed machine in same namespace and mark online (`handleMachineAlive`) before resume call.
- Register spawn RPC handler mapping for `${machineId}:spawn-happy-session`.
- Ensure resumed session becomes active:
  - preferred: emit `handleSessionAlive({ sid: resumedSessionId, ... })` in test flow,
  - fallback: control `waitForSessionActive` via targeted stub.
- Merge scenario: make spawn return a different `sessionId`; assert merge side effects (messages/session continuity) after activation.

### Phase 1: Access control & session lifecycle (~12 cases)

1. GET /sessions returns 503 when sync engine is null
2. GET /sessions returns empty array for new namespace
3. Create session via SyncEngine, GET /sessions returns it
4. GET /sessions/:id returns 404 for non-existent session
5. GET /sessions/:id returns 403 when namespace doesn't match
6. GET /sessions/:id returns session with correct metadata shape
7. PATCH /sessions/:id renames session, verify GET reflects new name
8. DELETE /sessions/:id returns 409 if session is active
9. DELETE /sessions/:id succeeds for inactive session, verify GET returns 404
10. GET /sessions sorts active sessions before inactive
11. GET /sessions sorts by pending request count within active group
12. GET /sessions filters by namespace from auth context

### Phase 2: Session resume flow (~8 cases)

13. POST /sessions/:id/resume returns 404 for non-existent session
14. POST /sessions/:id/resume returns 403 for wrong namespace
15. POST /sessions/:id/resume returns 503 (no_machine_online) when no machines registered
16. POST /sessions/:id/resume returns success when session is already active
17. POST /sessions/:id/resume returns 500 (resume_unavailable) when metadata.path is missing
18. resumeSession prefers machine by exact ID match over host match
19. resumeSession detects flavor from metadata (codex/gemini/opencode/claude)
20. resumeSession merges sessions when spawn returns different sessionId

### Phase 3: Upload & permission mode validation (~8 cases)

21. POST /sessions/:id/upload returns 400 for invalid schema
22. POST /sessions/:id/upload returns 413 when file exceeds 50MB
23. POST /sessions/:id/upload estimates base64 bytes correctly (padding)
24. POST /sessions/:id/upload requires active session
25. POST /sessions/:id/permission-mode validates mode against session flavor
26. POST /sessions/:id/permission-mode returns 400 for unsupported flavor
27. POST /sessions/:id/model validates model mode for Claude sessions only
28. POST /sessions/:id/model returns 400 for non-Claude session

### Phase 4: Machine routes (~8 cases)

29. GET /machines returns 503 when sync engine is null
30. GET /machines filters to online machines only
31. GET /machines filters by namespace
32. POST /machines/:id/spawn validates directory is non-empty
33. POST /machines/:id/spawn validates agent enum (claude/codex/gemini/opencode)
34. POST /machines/:id/paths/exists deduplicates and trims paths
35. POST /machines/:id/paths/exists enforces max 1000 paths
36. POST /machines/:id/git/branches enforces max 500 limit

### Phase 5: Git & file routes (~8 cases)

37. GET /sessions/:id/git-status returns error when metadata.path missing
38. GET /sessions/:id/git-diff-numstat parses 'staged' query param as boolean
39. GET /sessions/:id/git-diff-file requires path query param
40. GET /sessions/:id/file requires path query param
41. GET /sessions/:id/files builds ripgrep args with --files and --iglob
42. GET /sessions/:id/files limits results (default 200)
43. GET /sessions/:id/directory passes path (default empty string)
44. runRpc catches and wraps errors as {success: false, error: string}

### Phase 6A: Auth route — access-token lane (required, ~5 cases)

45. POST /auth returns 400 for invalid body schema
46. POST /auth returns 401 for invalid access token
47. POST /auth validates token with constantTimeEquals
48. POST /auth parses namespace from access token
49. POST /auth generates JWT with uid/ns claims, 15m expiry, and firstName='Web User'

### Phase 6B: Auth route — Telegram lane (optional, ~3 cases)

50. POST /auth returns 503 when Telegram is disabled
51. POST /auth returns 401 when Telegram user is not bound (error code: 'not_bound')
52. POST /auth returns JWT + Telegram profile fields when initData is valid and user is bound

---

## Summary

| Bead | Priority | Package | LOC | Test Cases | Style | Mocking |
|---|---|---|---|---|---|---|
| hapi-cu9 | P1 | shared | 193 | ~17 | Unit | None (pure Zod) |
| hapi-yrc | P1 | web | 346 | ~18 | Unit | None (pure parsing) |
| hapi-8fh | P1 | web | 560 | ~36 | Unit | Protocol helpers |
| hapi-sqc | P2 | web | 226 | ~13 | Unit | None (pure functions) |
| hapi-p91 | P2 | hub | 470 | ~36 | Unit | In-memory SQLite |
| hapi-7y6 | P2 | cli | 213 | ~13 | Unit | PermissionHandlerClient |
| hapi-s9p + hapi-dkw | P2/P3 | hub | 1670 | ~49 required (+3 optional) | **Integration** | In-memory SQLite + Hono test client |
| **Total** | | | **3678** | **~182 required (~185 w/ optional)** | | |

### Execution phases with exit criteria

**Phase A — Pure-function unit tests (low risk, high velocity)**
Goal: Regression protection for foundational data transforms. Exit: all suites green, no mocks.

1. **hapi-cu9** — Shared Zod schemas
2. **hapi-yrc** — Git parsers
3. **hapi-8fh** — Chat normalization pipeline
4. **hapi-sqc** — Chat reconciliation

**Phase B — Stateful unit tests (medium risk)**
Goal: Store and permission logic verified against real (in-memory) backends. Exit: version conflicts, dedup, and access control paths covered.

5. **hapi-p91** — Hub store layer (in-memory SQLite)
6. **hapi-7y6** — Permission handler auto-approval logic

**Phase C — Hub integration tests (highest value)**
Goal: End-to-end request→engine→store validation. Replaces deep-mock unit approach for SyncEngine and routes. Exit: session lifecycle, resume flow, required auth lane, and namespace isolation exercised through HTTP (Telegram auth lane optional).

7. **hapi-s9p + hapi-dkw** — SyncEngine + API routes (single integration suite)

---

## CI guardrails (new bead needed)

To prevent test coverage from drifting after this effort:

1. **Required test jobs in CI pipeline**
   - `bun test` (hub, cli, shared) and `vitest run` (web) as blocking steps
   - Fail the build on any test failure

2. **Coverage thresholds** (start conservative, ratchet up)
   - shared: 80% line coverage (small package, pure logic)
   - web/src/lib + web/src/chat: 60% line coverage (parser/normalizer core)
   - hub/src/store: 70% line coverage
   - hub/src/web + hub/src/sync: 40% line coverage (integration tests cover less surface by line but more by path)
   - cli: 30% line coverage (hardest to test, start low)

3. **Coverage ratchet rule**
   - New PRs must not decrease coverage in any package
   - Enforced via CI diff check (e.g., `vitest --coverage` + threshold comparison)

---

## Next-tranche backlog (omitted high-risk areas)

These surfaces are not covered by the current plan and should be the next batch after this one:

| Area | Package | Risk | Why |
|---|---|---|---|
| CLI command handlers | cli | High | User-facing commands (init, run, connect). Complex args, side effects, process spawning. |
| Runner daemon lifecycle | cli | High | Process management, heartbeat, child tracking, signal handling. The hapi-4c6 temp cleanup touches this. |
| Web route interactions | web | Medium | TanStack Router loaders, auth guards, SSE subscription setup. Currently 0 route-level tests. |
| Hub↔CLI session lifecycle | hub+cli | High | Full WebSocket flow: connect → register → sync → RPC → disconnect. Needs test harness for Socket.IO. |
| Encryption/decryption pipeline | shared+cli | Medium | E2E message encryption. Currently tested implicitly but no dedicated suite. |
| SSE event delivery | hub | Medium | EventPublisher → SSEManager → client. Race conditions, reconnect behavior. |

Suggested priority for next tranche: Runner daemon > CLI commands > Hub↔CLI lifecycle > Web routes > SSE > Encryption.

---

## Revision history

- **v1** (2026-02-18): Initial plan — 204 cases across 8 unit test suites.
- **v2** (2026-02-18): Incorporated reviewer feedback. Merged hapi-s9p + hapi-dkw into integration suite. Added CI guardrails section and next-tranche backlog. Reduced total from ~204 to ~185 cases (fewer mock-heavy unit tests, replaced with higher-value integration tests). Added phased execution with exit criteria.
- **v3** (2026-02-18): Second-pass reviewer notes. Added harness-clarity requirements (createWebApp bootstrap, Socket.IO stub contract, auth setup scope, resume-flow seeding guidance) as execution preconditions.
- **v4** (2026-02-18): Finalized in-place. Integrated harness contract, explicit Socket.IO/RPC stub interfaces, required vs optional auth lanes, and resume-flow seeding recipe into main execution plan.
