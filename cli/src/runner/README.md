# HAPI CLI Runner: Control Flow and Lifecycle

The runner is a persistent background process that manages HAPI sessions, enables remote control from the mobile app, and handles auto-updates when the CLI version changes.

## 1. Runner Lifecycle

### Starting the Runner

Command: `hapi runner start`

Control Flow:
1. `src/index.ts` receives `runner start` command
2. Spawns detached process via `spawnHappyCLI(['runner', 'start-sync'], { detached: true })`
3. New process calls `startRunner()` from `src/runner/run.ts`
4. `startRunner()` performs startup:
   - Sets up shutdown promise and handlers (SIGINT, SIGTERM, uncaughtException, unhandledRejection)
   - Version check: `isRunnerRunningCurrentlyInstalledHappyVersion()` compares CLI binary mtime
   - If version mismatch: calls `stopRunner()` to kill old runner before proceeding
   - If same version running: exits with "Runner already running"
   - Lock acquisition: `acquireRunnerLock()` creates exclusive lock file to prevent multiple runners
   - Direct-connect setup: `authAndSetupMachineIfNeeded()` ensures `CLI_API_TOKEN` is set and `machineId` exists
   - State persistence: writes PID, version, HTTP port, mtime to runner.state.json
   - HTTP server: starts Fastify on random port for local CLI control (list, stop, spawn)
   - WebSocket: establishes persistent connection to backend via `ApiMachineClient`
   - RPC registration: exposes `spawn-happy-session`, `stop-session`, `stop-runner` handlers
   - Heartbeat loop: every 60s (or `HAPI_RUNNER_HEARTBEAT_INTERVAL`) checks for version updates, prunes dead sessions, verifies PID ownership
5. Awaits shutdown promise which resolves when:
   - OS signal received (SIGINT/SIGTERM) - source: `os-signal`
   - HTTP `/stop` endpoint called - source: `hapi-cli`
   - RPC `stop-runner` invoked - source: `hapi-app`
   - Uncaught exception occurs - source: `exception`
6. On shutdown, `cleanupAndShutdown()` performs:
   - Clears heartbeat interval
   - Updates runner state to "shutting-down" on backend with shutdown source
   - Disconnects WebSocket
   - Stops HTTP server
   - Deletes runner.state.json
   - Releases lock file
   - Exits process

### Version Detection & Auto-Update

The runner detects when CLI binary changes (e.g., after `npm upgrade hapi`):
1. At startup, records `startedWithCliMtimeMs` (file modification time of CLI binary)
2. Heartbeat compares current CLI mtime with recorded mtime via `getInstalledCliMtimeMs()`
3. If mtime changed:
   - Clears heartbeat interval
   - Spawns new runner via `spawnHappyCLI(['runner', 'start'])`
   - Waits 10 seconds to be killed by new runner
4. New runner starts, sees old runner running with different mtime
5. New runner calls `stopRunner()` which tries HTTP `/stop`, falls back to SIGKILL
6. New runner takes over

### Heartbeat System

Every 60 seconds (configurable via `HAPI_RUNNER_HEARTBEAT_INTERVAL`):
1. **Guard**: Skips if previous heartbeat still running (prevents concurrent heartbeats)
2. **Session Pruning**: Checks each tracked PID with `isProcessAlive(pid)`, removes dead sessions
3. **Version Check**: Compares CLI binary mtime, triggers self-restart if changed
4. **PID Ownership**: Verifies runner still owns state file, self-terminates if another runner took over
5. **State Update**: Writes `lastHeartbeat` timestamp to runner.state.json

### Stopping the Runner

Command: `hapi runner stop`

Control Flow:
1. `stopRunner()` in `controlClient.ts` reads runner.state.json
2. Attempts graceful shutdown via HTTP POST to `/stop`
3. Runner receives request, triggers shutdown with source `hapi-cli`
4. `cleanupAndShutdown()` executes:
   - Updates backend status to "shutting-down"
   - Closes WebSocket connection
   - Stops HTTP server
   - Deletes runner.state.json
   - Releases lock file
5. If HTTP fails, falls back to `killProcess(pid, true)` (uses `taskkill /T /F` on Windows)

## 2. Multi-Agent Support

The runner supports spawning sessions with different AI agents:

| Agent | Command | Token Environment |
|-------|---------|-------------------|
| `claude` (default) | `hapi claude` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex` | `hapi codex` | `CODEX_HOME` (temp directory with `auth.json`) |
| `gemini` | `hapi gemini` | - |
| `grok` | `hapi grok` | Grok CLI login or `XAI_API_KEY` |
| `opencode` | `hapi opencode` | OpenCode config (no token injection) |

### Token Authentication

When spawning a session with a token:
- **Claude**: Sets `CLAUDE_CODE_OAUTH_TOKEN` environment variable
- **Codex**: Creates temp directory at `os.tmpdir()/hapi-codex-*`, writes token to `auth.json`, sets `CODEX_HOME`
- **Grok Build**: No token injection; relies on Grok CLI login or `XAI_API_KEY` in the runner environment
- **OpenCode**: No token injection; relies on OpenCode's own configuration

## 3. Session Management

### Runner-Spawned Sessions (Remote)

Initiated by mobile app via backend RPC:
1. Backend forwards RPC `spawn-happy-session` to runner via WebSocket
2. `ApiMachineClient` invokes `spawnSession()` handler
3. `spawnSession()`:
   - Validates/creates directory (with approval flow)
   - Configures agent-specific token environment
   - Spawns detached HAPI process with `--hapi-starting-mode remote --started-by runner`
   - Adds to `pidToTrackedSession` map
   - Sets up 15-second awaiter for session webhook
4. New HAPI process:
   - Creates session with backend, receives `happySessionId`
   - Calls `notifyRunnerSessionStarted()` to POST to runner's `/session-started`
5. Runner updates tracking with `happySessionId`, resolves awaiter
6. RPC returns session info to mobile app

### Terminal-Spawned Sessions

User runs `hapi` directly:
1. CLI auto-starts runner if configured
2. HAPI process calls `notifyRunnerSessionStarted()`
3. Runner receives webhook, creates `TrackedSession` with `startedBy: 'hapi directly - likely by user from terminal'`
4. Session tracked for health monitoring

### Directory Creation Approval

When spawning a session, directory handling:
1. Check if directory exists with `fs.access()`
2. If missing and `approvedNewDirectoryCreation = false`: returns `requestToApproveDirectoryCreation` (HTTP 409)
3. If missing and approved: creates directory with `fs.mkdir({ recursive: true })`
4. Error handling for directory creation:
   - `EACCES`: Permission denied
   - `ENOTDIR`: File exists at path
   - `ENOSPC`: Disk full
   - `EROFS`: Read-only filesystem

### Session Termination

Via RPC `stop-session` or HTTP `/stop-session`:
1. `stopSession()` finds session by `happySessionId` or `PID-{pid}` format
2. Sends termination request via `killProcessByChildProcess()` or `killProcess()` (Windows uses `taskkill /T`)
3. `on('exit')` handler removes from tracking map

## 4. HTTP Control Server (Fastify)

Local HTTP server using Fastify with `fastify-type-provider-zod` for type-safe request/response validation.

**Host:** 127.0.0.1 (localhost only)
**Port:** Dynamic (system-assigned)

### Endpoints

#### POST `/session-started`
Session webhook - reports itself after creation.

**Request:**
```json
{ "sessionId": "string", "metadata": { ... } }
```
**Response (200):**
```json
{ "status": "ok" }
```

#### POST `/list`
Returns all tracked sessions.

**Response (200):**
```json
{
  "children": [
    { "startedBy": "runner", "happySessionId": "uuid", "pid": 12345 }
  ]
}
```

#### POST `/stop-session`
Terminates a specific session.

**Request:**
```json
{ "sessionId": "string" }
```
**Response (200):**
```json
{ "success": true }
```

#### POST `/spawn-session`
Creates a new session.

**Request:**
```json
{ "directory": "/path/to/dir", "sessionId": "optional-uuid" }
```
**Response (200) - Success:**
```json
{
  "success": true,
  "sessionId": "uuid",
  "approvedNewDirectoryCreation": true
}
```
**Response (409) - Requires Approval:**
```json
{
  "success": false,
  "requiresUserApproval": true,
  "actionRequired": "CREATE_DIRECTORY",
  "directory": "/path/to/dir"
}
```
**Response (500) - Error:**
```json
{ "success": false, "error": "Error message" }
```

#### POST `/stop`
Graceful runner shutdown.

**Response (200):**
```json
{ "status": "stopping" }
```

## 5. State Persistence

### runner.state.json
```json
{
  "pid": 12345,
  "httpPort": 50097,
  "startTime": "8/24/2025, 6:46:22 PM",
  "startedWithCliVersion": "0.9.0-6",
  "startedWithCliMtimeMs": 1724531182000,
  "lastHeartbeat": "8/24/2025, 6:47:22 PM",
  "runnerLogPath": "/path/to/runner.log"
}
```

### Lock File
- Created with O_EXCL flag for atomic acquisition
- Contains PID for debugging
- Prevents multiple runner instances
- Cleaned up on graceful shutdown

## 6. WebSocket Communication

`ApiMachineClient` handles bidirectional communication:

**Runner to Server:**
- `machine-alive` - 20-second heartbeat
- `machine-update-metadata` - static machine info changes
- `machine-update-state` - runner status changes

**Server to Runner:**
- `rpc-request` with methods:
  - `spawn-happy-session` - spawn new session
  - `stop-session` - stop session by ID
  - `stop-runner` - request shutdown

All data is plain JSON over TLS; authentication is `CLI_API_TOKEN` (no end-to-end encryption).

## 7. Process Discovery and Cleanup

### Doctor Command

`hapi doctor` uses `ps aux | grep` to find all HAPI processes:
- Production: matches `hapi` binary, `happy-coder`
- Development: matches `src/index.ts` (run via `bun`)
- Categorizes by command args: runner, runner-spawned, user-session, doctor

### Clean Runaway Processes

`hapi doctor clean`:
1. `findRunawayHappyProcesses()` filters for likely orphans
2. `killRunawayHappyProcesses()`:
   - Sends SIGTERM
   - Waits 1 second
   - Sends SIGKILL if still alive

## 8. Integration Testing

### Test Environment
- Requires `.env.integration-test`
- Uses local hapi-hub (http://localhost:3006)
- Separate `~/.hapi-dev-test` home directory

### Key Test Scenarios
- Session listing, spawning, stopping
- External session webhook tracking
- Graceful SIGTERM/SIGKILL shutdown
- Multiple runner prevention
- Version mismatch detection
- Directory creation approval flow
- Concurrent session stress tests

---

# Machine Sync Architecture - Separated Metadata & Runner State

> Direct-connect note: the "hub" is `hapi-hub`, payloads are plain JSON (no base64/encryption),
> and authentication uses `CLI_API_TOKEN` (REST `Authorization: Bearer ...` + Socket.IO `handshake.auth.token`).

## Data Structure (Similar to Session's metadata + agentState)

```typescript
// Static machine information (rarely changes)
interface MachineMetadata {
  host: string;              // hostname
  platform: string;          // darwin, linux, win32
  happyCliVersion: string;
  homeDir: string;
  happyHomeDir: string;
  happyLibDir: string;       // runtime path
}

// Dynamic runner state (frequently updated)
interface RunnerState {
  status: 'running' | 'shutting-down' | 'offline';
  pid?: number;
  httpPort?: number;
  startedAt?: number;
  shutdownRequestedAt?: number;
  shutdownSource?: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception';
}
```

## 1. CLI Startup Phase

Checks if machine ID exists in settings:
- If not: creates ID locally only (so sessions can reference it)
- Does NOT create machine on hub - that's runner's job
- CLI doesn't manage machine details - all API & schema live in runner subpackage

## 2. Runner Startup - Initial Registration

### REST Request: `POST /cli/machines`
```json
{
  "id": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "happyCliVersion": "1.0.0",
    "homeDir": "/Users/john",
    "happyHomeDir": "/Users/john/.hapi",
    "happyLibDir": "/usr/local/lib/node_modules/hapi"
  },
  "runnerState": {
    "status": "running",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567
  }
}
```

### Server Response:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "happyCliVersion": "..." },
    "metadataVersion": 1,
    "runnerState": { "status": "running", "pid": 12345 },
    "runnerStateVersion": 1,
    "active": true,
    "activeAt": 1703001234567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001234567
  }
}
```

## 3. WebSocket Connection & Real-time Updates

### Connection Handshake:
```javascript
io(`${botUrl}/cli`, {
  auth: {
    token: "CLI_API_TOKEN",
    clientType: "machine-scoped",
    machineId: "machine-uuid-123"
  },
  path: "/socket.io/",
  transports: ["websocket"]
})
```

### Heartbeat (every 20s):
```json
// Client -> Server
socket.emit('machine-alive', {
  "machineId": "machine-uuid-123",
  "time": 1703001234567
})
```

## 4. Runner State Updates (via WebSocket)

### When runner status changes:
```json
// Client -> Server
socket.emit('machine-update-state', {
  "machineId": "machine-uuid-123",
  "runnerState": {
    "status": "shutting-down",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567,
    "shutdownRequestedAt": 1703001244567,
    "shutdownSource": "hapi-app"
  },
  "expectedVersion": 1
}, callback)

// Server -> Client (callback)
// Success:
{
  "result": "success",
  "version": 2,
  "runnerState": { "status": "shutting-down" }
}

// Version mismatch:
{
  "result": "version-mismatch",
  "version": 3,
  "runnerState": { "status": "running" }
}
```

### Machine metadata update (rare):
```json
// Client -> Server
socket.emit('machine-update-metadata', {
  "machineId": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "happyCliVersion": "1.0.1",
    "homeDir": "/Users/john",
    "happyHomeDir": "/Users/john/.hapi"
  },
  "expectedVersion": 1
}, callback)
```

## 5. Mini App RPC Calls (via hapi-hub)

The Telegram Mini App calls REST endpoints on `hapi-hub` (for example `POST /api/machines/:id/spawn`).
`hapi-hub` then relays those requests to the runner via Socket.IO `rpc-request` on the `/cli` namespace.

RPC method naming (machine-scoped) uses a `${machineId}:` prefix, for example:
- `${machineId}:spawn-happy-session`

## 6. Server Broadcasts to Clients

### When runner state changes:
```json
// Server -> Mobile/Web clients
socket.emit('update', {
  "id": "update-id-xyz",
  "seq": 456,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "runnerState": {
      "value": { "status": "shutting-down" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

### When metadata changes:
```json
socket.emit('update', {
  "id": "update-id-abc",
  "seq": 457,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "metadata": {
      "value": { "host": "MacBook-Pro.local" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

## 7. GET Machine Status (REST)

### Request: `GET /cli/machines/machine-uuid-123`
```http
Authorization: Bearer <CLI_API_TOKEN>
```

### Response:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "happyCliVersion": "..." },
    "metadataVersion": 2,
    "runnerState": { "status": "running", "pid": 12345 },
    "runnerStateVersion": 3,
    "active": true,
    "activeAt": 1703001244567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001244567
  }
}
```

## Key Design Decisions

1. **Separation of Concerns**:
   - `metadata`: Static machine info (host, platform, versions)
   - `runnerState`: Dynamic runtime state (status, pid, ports)

2. **Independent Versioning**:
   - `metadataVersion`: For machine metadata updates
   - `runnerStateVersion`: For runner state updates
   - Allows concurrent updates without conflicts

3. **Security**: No end-to-end encryption (TLS only); CLI auth is a shared secret `CLI_API_TOKEN`

4. **Update Events**: Server broadcasts use same pattern as sessions:
   - `t: 'update-machine'` with optional metadata and/or runnerState fields
   - Clients only receive updates for fields that changed

5. **RPC Pattern**: Machine-scoped RPC methods prefixed with machineId (like sessions)

---

# Improvements

- runner.state.json file is getting hard removed when runner exits or is stopped. We should keep it around and have 'state' field and 'stateReason' field that will explain why the runner is in that state
- If the file is not found - we assume the runner was never started or was cleaned out by the user or doctor
- If the file is found and corrupted - we should try to upgrade it to the latest version? or simply remove it if we have write access

- posts helpers for runner do not return typed results
- I don't like that runnerPost returns either response from runner or { error: ... }. We should have consistent envelope type

- we loose track of children processes when runner exits / restarts - we should write them to the same state file? At least the pids should be there for doctor & cleanup

- the runner control server binds to `127.0.0.1` on a random port; if we ever expose it beyond localhost, require an explicit auth token/header
