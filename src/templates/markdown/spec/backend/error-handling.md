# Error Handling

> How errors are handled in this project.

---

## Overview

HAPI Hub follows a pragmatic error handling approach:

- **HTTP API**: Return `{ error: string }` JSON with appropriate HTTP status codes
- **Socket.IO**: Silently ignore invalid events (no error propagation to client unless needed)
- **Database**: Use result types (`VersionedUpdateResult`) instead of throwing
- **Guards**: Return `Response | T` union type to check before using
- **Input validation**: Zod schemas with `.safeParse()` (never throw on validation failure)

**Key principle**: Fail gracefully. Don't crash the server for invalid input.

---

## HTTP API Error Responses

### Standard Format

All error responses use `{ error: string }` JSON:

```typescript
// 400 - Bad Request (invalid input)
return c.json({ error: 'Invalid body' }, 400)

// 401 - Unauthorized
return c.json({ error: 'Unauthorized' }, 401)

// 403 - Forbidden (exists but access denied)
return c.json({ error: 'Session access denied' }, 403)

// 404 - Not Found
return c.json({ error: 'Session not found' }, 404)

// 409 - Conflict
return c.json({ error: 'Session is inactive' }, 409)

// 503 - Service Unavailable (dependency not ready)
return c.json({ error: 'Not connected' }, 503)
```

**Status code guide**:
- `400` - Invalid request body/params
- `401` - Not authenticated
- `403` - Authenticated but access denied (namespace mismatch, etc.)
- `404` - Resource not found
- `409` - Conflict (wrong state)
- `413` - Payload too large
- `422` - Validation error (valid format but invalid semantics)
- `503` - Service dependency not available (sync engine, machine not online)

### Error Response in Route Handlers

```typescript
app.post('/sessions/:id/resume', async (c) => {
    // 1. Check dependencies with guard
    const engine = requireSyncEngine(c, getSyncEngine)
    if (engine instanceof Response) return engine  // Guard returned error

    // 2. Check resource access with guard
    const sessionResult = requireSessionFromParam(c, engine)
    if (sessionResult instanceof Response) return sessionResult

    // 3. Execute operation, check result
    const result = await engine.resumeSession(sessionResult.sessionId, namespace)
    if (result.type === 'error') {
        const status = result.code === 'no_machine_online' ? 503 : 500
        return c.json({ error: result.message }, status)
    }

    return c.json({ success: true })
})
```

---

## Guard Pattern

Guards return `T | Response` - check with `instanceof Response` before using:

```typescript
// web/routes/guards.ts

// Returns SyncEngine or 503 error response
export function requireSyncEngine(
    c: Context<WebAppEnv>,
    getSyncEngine: () => SyncEngine | null
): SyncEngine | Response {
    const engine = getSyncEngine()
    if (!engine) {
        return c.json({ error: 'Not connected' }, 503)
    }
    return engine
}

// Returns session or 404/403 error response
export function requireSession(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    sessionId: string,
    options?: { requireActive?: boolean }
): { sessionId: string; session: Session } | Response {
    const namespace = c.get('namespace')
    const access = engine.resolveSessionAccess(sessionId, namespace)
    if (!access.ok) {
        const status = access.reason === 'access-denied' ? 403 : 404
        const error = access.reason === 'access-denied' ? 'Session access denied' : 'Session not found'
        return c.json({ error }, status)
    }
    if (options?.requireActive && !access.session.active) {
        return c.json({ error: 'Session is inactive' }, 409)
    }
    return { sessionId: access.sessionId, session: access.session }
}
```

**Usage**:
```typescript
const engine = requireSyncEngine(c, getSyncEngine)
if (engine instanceof Response) return engine  // Short-circuit on error

const session = requireSession(c, engine, sessionId)
if (session instanceof Response) return session  // Short-circuit on error

// Both are valid here
console.log(engine, session)
```

---

## Input Validation with Zod

### Pattern

Always use Zod `.safeParse()` for validation (never `.parse()` that throws):

```typescript
import { z } from 'zod'

const renameSessionSchema = z.object({
    name: z.string().min(1).max(255)
})

app.post('/sessions/:id/rename', async (c) => {
    const json = await c.req.json().catch(() => null)  // Handle parse error

    const parsed = renameSessionSchema.safeParse(json)
    if (!parsed.success) {
        return c.json({ error: 'Invalid body' }, 400)
    }

    // parsed.data is typed here
    const { name } = parsed.data
    // ...
})
```

**Key points**:
- Use `.safeParse()` not `.parse()` (never throws)
- Handle JSON parse errors with `.catch(() => null)`
- Return 400 for validation failures
- Return detailed error message for user-facing validation (e.g., "Name must be 1-255 characters")

### Socket.IO Validation

Socket events silently ignore invalid input:

```typescript
socket.on('message', (data: unknown) => {
    const parsed = messageSchema.safeParse(data)
    if (!parsed.success) {
        return  // Silent ignore - don't throw, don't respond with error
    }

    // Process valid event
    const { sid, message } = parsed.data
})
```

**Why silent ignore**: Socket events are fire-and-forget; invalid events from CLI are bugs, not user errors.

---

## Result Types (Database Layer)

### VersionedUpdateResult

Database updates return result types instead of throwing:

```typescript
type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }
```

**Usage**:
```typescript
const result = store.sessions.updateSessionMetadata(id, metadata, expectedVersion, namespace)

switch (result.result) {
    case 'success':
        // Update succeeded, use result.version
        break
    case 'version-mismatch':
        // Conflict - result.value has current state, result.version has current version
        break
    case 'error':
        // Row not found or database error
        break
}
```

### Boolean Results

For simple CRUD operations, return boolean:

```typescript
deleteSession(id: string, namespace: string): boolean
// true = deleted successfully
// false = not found or access denied
```

**Usage**:
```typescript
const deleted = store.sessions.deleteSession(id, namespace)
if (!deleted) {
    return c.json({ error: 'Session not found' }, 404)
}
```

---

## Unknown Error Handling

### In Route Handlers

Catch-all for unexpected errors:

```typescript
app.post('/sessions/:id/operation', async (c) => {
    try {
        // ... operation
        return c.json({ success: true })
    } catch (error) {
        console.error('Session operation failed:', error)
        return c.json({ error: 'Internal server error' }, 500)
    }
})
```

### In Background Services

Log and continue (don't crash the server):

```typescript
async function processEvent(event: SyncEvent): Promise<void> {
    try {
        await notificationHub.notify(event)
    } catch (error) {
        console.error('Failed to send notification:', error)
        // Don't rethrow - background service should continue
    }
}
```

### Discriminated Union for Operation Results

For complex operations with multiple failure modes:

```typescript
type ResumeResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; code: 'no_machine_online' | 'internal'; message: string }

async function resumeSession(id: string, namespace: string): Promise<ResumeResult> {
    const machines = this.getMachinesForNamespace(namespace)
    if (machines.length === 0) {
        return { type: 'error', code: 'no_machine_online', message: 'No machine available' }
    }

    try {
        const result = await this.connectToMachine(machines[0], id)
        return { type: 'success', sessionId: result.sessionId }
    } catch (error) {
        return { type: 'error', code: 'internal', message: String(error) }
    }
}

// Caller maps error codes to HTTP status
if (result.type === 'error') {
    const status = result.code === 'no_machine_online' ? 503 : 500
    return c.json({ error: result.message }, status)
}
```

---

## Scenario: Machine spawn RPC error normalization (Hub ↔ CLI)

### 1. Scope / Trigger
- Trigger: Cross-layer request/response contract handling changed for machine session spawn (`hub -> cli-runner` RPC).
- Why spec-depth is required: Frontend `POST /api/machines/:id/spawn` depends on Hub returning a stable `{ type: 'success' | 'error' }` shape. Any RPC shape drift must be normalized at Hub boundary.

### 2. Signatures
- HTTP route: `POST /api/machines/:id/spawn` (`hub/src/web/routes/machines.ts`)
- Hub service: `SyncEngine.spawnSession(...)` (`hub/src/sync/syncEngine.ts`)
- Hub RPC gateway: `RpcGateway.spawnSession(...)` (`hub/src/sync/rpcGateway.ts`)
- CLI machine RPC handler: `'spawn-happy-session'` (`cli/src/api/apiMachine.ts`)

Expected Hub return type:
```ts
Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }>
```

### 3. Contracts
- Request (Hub -> CLI machine RPC):
  - `type: 'spawn-in-directory'`
  - `directory: string`
  - `agent?: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode'`
  - `model?: string`
  - `yolo?: boolean`
  - `sessionType?: 'simple' | 'worktree'`
  - `worktreeName?: string`
  - `resumeSessionId?: string`
- Response candidates from CLI side (observed/allowed):
  - `{ type: 'success'; sessionId: string }`
  - `{ type: 'error'; errorMessage: string }`
  - `{ error: string }` (serialized handler exception)
  - `{ type: 'requestToApproveDirectoryCreation'; directory: string }`
- Env keys impacting runtime path correctness:
  - `HAPI_HOME` (required for runner state/logs)
  - `HAPI_API_URL` (required for machine sync)
  - `CLI_API_TOKEN` (required auth)

### 4. Validation & Error Matrix
- CLI returns `{ type: 'success', sessionId }` -> Hub returns success.
- CLI returns `{ type: 'error', errorMessage }` -> Hub maps to `{ type: 'error', message: errorMessage }`.
- CLI returns `{ error: string }` -> Hub maps to `{ type: 'error', message: error }`.
- CLI returns `{ type: 'requestToApproveDirectoryCreation', directory }` -> Hub maps to explicit error message (`Directory does not exist: ...`) for Web flow.
- Any other shape -> Hub returns `{ type: 'error', message: 'Unexpected spawn result' }`.

### 5. Good/Base/Bad Cases
- Good: Spawn succeeds, returns `sessionId`, Web creates session normally.
- Base: Spawn fails with known runtime error (e.g. missing module), user sees real message instead of generic fallback.
- Bad: Hub only accepts one error shape and surfaces `Unexpected spawn result`, hiding root cause.

### 6. Tests Required (with assertion points)
- Unit (Hub `RpcGateway.spawnSession`):
  - given `{ error: 'x' }` -> assert returned `{ type: 'error', message: 'x' }`.
  - given `{ type: 'requestToApproveDirectoryCreation', directory: '/tmp/a' }` -> assert returned message contains directory.
  - given unknown object -> assert fallback `'Unexpected spawn result'`.
- Integration (Hub + CLI runner):
  - force spawn handler exception -> assert HTTP `/api/machines/:id/spawn` returns JSON with non-empty `message`, not generic fallback when parseable.
- Regression:
  - verify existing success path unchanged (`type === 'success'`, valid `sessionId`).

### 7. Wrong vs Correct
#### Wrong
```ts
if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
  return { type: 'error', message: obj.errorMessage }
}
return { type: 'error', message: 'Unexpected spawn result' }
```

#### Correct
```ts
if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
  return { type: 'error', message: obj.errorMessage }
}
if (typeof obj.error === 'string') {
  return { type: 'error', message: obj.error }
}
if (obj.type === 'requestToApproveDirectoryCreation' && typeof obj.directory === 'string') {
  return { type: 'error', message: `Directory does not exist: ${obj.directory}` }
}
return { type: 'error', message: 'Unexpected spawn result' }
```

---

## Logging Errors

### Console Logging

Simple console.error for unexpected errors:

```typescript
console.error('Failed to process event:', error)
console.warn('SSE client disconnected unexpectedly:', clientId)
```

**When to log**:
- Unexpected errors (database errors, network failures)
- Background task failures
- Configuration warnings

**When NOT to log**:
- Expected validation failures (user sent bad input)
- 404s (resource not found)
- Authentication failures (expected in normal operation)

---

## Common Mistakes

- ❌ Using Zod `.parse()` (throws on validation failure) - use `.safeParse()`
- ❌ Not checking guard return values (`if (engine instanceof Response)`)
- ❌ Throwing errors in Socket.IO event handlers (crashes the socket)
- ❌ Returning 500 for 404/403 situations (use correct status codes)
- ❌ Not catching JSON parse errors (`c.req.json()` can throw - use `.catch(() => null)`)
- ❌ Swallowing errors without logging in background services
- ❌ Not using discriminated unions for operations with multiple failure modes
- ❌ Exposing internal error details to clients (use generic messages for 500s)
- ❌ Crashing the server for background task errors
- ❌ Using `any` for caught errors (use `unknown`)

---

## Best Practices

- ✅ Return `{ error: string }` JSON for all HTTP errors
- ✅ Use appropriate HTTP status codes
- ✅ Use guard pattern (`T | Response`) for dependency checks
- ✅ Use Zod `.safeParse()` for all input validation
- ✅ Use result types for database operations
- ✅ Use discriminated unions for operations with multiple failure modes
- ✅ Log unexpected errors with `console.error`
- ✅ Don't crash background services - catch and continue
- ✅ Handle JSON parse errors explicitly with `.catch(() => null)`
- ✅ Use `unknown` type for caught errors, narrow before using
