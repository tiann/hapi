# Architecture Deep Dive

This page is the engineering map of HAPI. It explains where code runs, how state moves, which package owns each boundary, and where the current design is intentionally simple versus where it is carrying debt.

If you only want the product-level version, read [How it Works](./how-it-works.md). This page is for maintainers changing CLI, Hub, Web, runner, or shared protocol code.

## One-sentence model

HAPI is a local-first remote-control system for AI coding agents: the CLI runs the real agent on the user's machine, the Hub stores and routes session state, and the Web/PWA controls sessions through REST, SSE, and terminal sockets.

```text
Web / PWA / Telegram
        │
        │ REST /api, SSE /api/events, Socket.IO /terminal
        ▼
Hub
        │
        │ Socket.IO /cli, RPC requests, session/machine events
        ▼
CLI session / runner / machine
        │
        │ child process, app server, shell, file system, git, terminal
        ▼
Claude Code / Codex / Cursor Agent / OpenCode / Kimi / Pi
```

The important boundary: **Hub does not execute agent code or local file operations directly**. Local actions happen inside the CLI or runner process that is connected to the Hub.

## Package map

| Package | Runtime | Main responsibility | Key files |
|---------|---------|---------------------|-----------|
| `cli/` | User machine | Agent wrappers, runner daemon, local RPC handlers, terminal bridge | `cli/src/commands/runCli.ts`, `cli/src/api/apiSession.ts`, `cli/src/api/apiMachine.ts`, `cli/src/runner/run.ts` |
| `hub/` | Hub host | HTTP API, Socket.IO, SSE, SQLite persistence, notifications, RPC routing | `hub/src/startHub.ts`, `hub/src/web/server.ts`, `hub/src/socket/server.ts`, `hub/src/sync/syncEngine.ts`, `hub/src/sync/rpcGateway.ts`, `hub/src/store/index.ts` |
| `web/` | Browser / PWA / Telegram Mini App | Session UI, new-session flow, model controls, terminal UI, live cache updates | `web/src/main.tsx`, `web/src/router.tsx`, `web/src/api/client.ts`, `web/src/hooks/useSSE.ts`, `web/src/components/SessionChat.tsx`, `web/src/components/NewSession/index.tsx` |
| `shared/` | All packages | Zod schemas, socket event contracts, API request/response types, agent mode constants | `shared/src/apiTypes.ts`, `shared/src/schemas.ts`, `shared/src/socket.ts`, `shared/src/rpcMethods.ts`, `shared/src/modes.ts` |
| `docs/` | Static docs | VitePress docs site | `docs/.vitepress/config.ts`, `docs/guide/*` |
| `website/` | Static site | Marketing site | `website/*` |

## Runtime topology

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Browser / PWA / Telegram Mini App                                     │
│                                                                       │
│  React 19 + TanStack Router + TanStack Query                          │
│  REST actions through web/src/api/client.ts                           │
│  SSE cache patches through web/src/hooks/useSSE.ts                    │
│  xterm terminal through Socket.IO /terminal                           │
└───────────────────────┬───────────────────────────────────────────────┘
                        │ JWT auth
                        │
                        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Hub                                                                   │
│                                                                       │
│  Hono HTTP API                                                        │
│  Socket.IO /cli for CLI session and machine clients                   │
│  Socket.IO /terminal for browser terminal clients                     │
│  SyncEngine coordinator                                               │
│  SQLite store, WAL mode                                               │
│  SSEManager broadcast fanout                                          │
│  NotificationHub, Telegram, push                                      │
└───────────────────────┬───────────────────────────────────────────────┘
                        │ CLI_API_TOKEN[:namespace]
                        │
                        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ User machine                                                          │
│                                                                       │
│  hapi runner start                                                    │
│    ApiMachineClient                                                   │
│    machine-scoped RPC handlers                                        │
│    local control server                                               │
│    child hapi process spawn                                           │
│                                                                       │
│  hapi / hapi codex / hapi cursor / hapi opencode / ...                │
│    ApiSessionClient                                                   │
│    session-scoped RPC handlers                                        │
│    TerminalManager                                                    │
│    agent wrapper                                                      │
└───────────────────────────────────────────────────────────────────────┘
```

## Ownership boundaries

### Web owns user intent

The web app renders sessions and turns user actions into HTTP or terminal socket calls.

Examples:

- Send message
- Approve permission
- Change model or effort
- Spawn a new session
- Open a terminal
- Browse scoped files

It should not know how to spawn Codex, parse Claude events, or run git. That work belongs to the CLI side.

### Hub owns state and routing

The Hub is the server-side state machine.

It owns:

- Auth for Web and CLI clients
- Session and machine persistence
- Message ordering and pagination
- SSE event broadcasting
- RPC routing from Web requests to CLI sockets
- Notification fanout
- Namespace isolation

It does not own:

- Agent process lifecycle details
- Local file system operations
- Terminal PTY execution
- Model catalog discovery mechanics

### CLI owns local execution

The CLI side is where local trust is concentrated.

It owns:

- Spawning and controlling agent processes
- Reading and writing local workspace state through registered RPC handlers
- Terminal PTY sessions
- Model list discovery for local agent auth context
- Permission callbacks into the real agent
- Runner-spawned session lifecycle

## Shared protocol layer

`shared/` is the contract package used by CLI, Hub, and Web.

Important files:

- `shared/src/apiTypes.ts`, HTTP request/response schemas.
- `shared/src/schemas.ts`, session, machine, message, attachment, SSE schemas.
- `shared/src/socket.ts`, Socket.IO payload schemas and event interfaces.
- `shared/src/rpcMethods.ts`, canonical RPC method names.
- `shared/src/modes.ts`, agent flavors and permission modes.

Two important details:

1. `AGENT_MESSAGE_PAYLOAD_TYPE` is still the literal string `'codex'` for generic agent messages. It is a legacy wire value. Changing it is a protocol migration, not a cleanup.
2. Gemini remains in the stored-session schema so old sessions validate, but creatable agent flavors exclude it. New session UI and schema code should use `CREATABLE_AGENT_FLAVORS` when offering launch choices.

## Hub internals

### Startup

`hub/src/startHub.ts` wires the server:

```text
load config
  -> create Store
  -> prepare JWT and VAPID keys
  -> create SSEManager
  -> create Socket.IO server
  -> create SyncEngine
  -> create NotificationHub
  -> start Hono web server
  -> optional tunnel / Telegram integration
```

### HTTP routes

`hub/src/web/server.ts` mounts route groups:

| Route group | Auth | Purpose |
|-------------|------|---------|
| `/cli/*` | CLI token | CLI bootstrap and machine/session registration |
| `/api/auth`, `/api/bind` | unauthenticated or bind token | Web login and device binding |
| `/api/events` | JWT | SSE stream |
| `/api/sessions/*` | JWT | Session list, detail, config, lifecycle, export |
| `/api/messages/*` | JWT | User message send/cancel/pagination |
| `/api/permissions/*` | JWT | Permission approve/deny |
| `/api/machines/*` | JWT | Machine list, directory browsing, session spawn, model list |
| `/api/git/*` | JWT | Git status/diff through CLI RPC |
| `/api/push/*`, `/api/voice/*` | JWT | Push notifications and voice support |

### Socket namespaces

`hub/src/socket/server.ts` creates two Socket.IO namespaces.

```text
/cli
  Auth: CLI_API_TOKEN[:namespace]
  Clients: session-scoped CLI, machine-scoped runner
  Events: messages, metadata/state updates, heartbeats, RPC registration, terminal forwarding

/terminal
  Auth: Web JWT
  Clients: browser terminal tabs
  Events: terminal:create/write/resize/close and terminal output/error/exit
```

Namespace isolation is enforced by token suffix and by checking session or machine namespace before joining rooms or forwarding terminal data.

### SyncEngine

`hub/src/sync/syncEngine.ts` is the central coordinator. It currently owns a lot:

- Session list/detail/archive/delete/rename/reopen/resume
- Session heartbeat and active state
- Machine heartbeat and runner state
- Message storage and delivery
- Permission routing
- Spawn and handoff flows
- File, git, slash command, skill, and model discovery delegations

Its collaborators:

| Class | File | Responsibility |
|-------|------|----------------|
| `SessionCache` | `hub/src/sync/sessionCache.ts` | In-memory session view, metadata/state versions, session changed events |
| `MachineCache` | `hub/src/sync/machineCache.ts` | In-memory machine view, runner state, health, machine changed events |
| `MessageService` | `hub/src/sync/messageService.ts` | Message persistence, pagination, queued message delivery, export filtering |
| `RpcGateway` | `hub/src/sync/rpcGateway.ts` | Hub-side RPC calls to session or machine sockets |
| `EventPublisher` | `hub/src/sync/eventPublisher.ts` | Internal listener fanout plus SSE broadcast |
| `Store` | `hub/src/store/index.ts` | SQLite schema and migrations |
| `SSEManager` | `hub/src/sse/sseManager.ts` | Browser event streams and namespace/scope filtering |

### Store

`hub/src/store/index.ts` uses SQLite with:

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`
- schema version currently `10`

Primary tables:

- `sessions`
- `machines`
- `messages`
- `users`
- `push_subscriptions`

This is a single-node design. The in-memory caches and Socket.IO rooms assume one Hub process owns live routing.

## CLI internals

### Command entry

```text
cli/src/commands/runCli.ts
  -> cli/src/commands/registry.ts
  -> agent-specific command module
  -> runClaude / runCodex / runCursor / runOpencode / runKimi / runPi
```

The agent command creates or resumes a Hub session, starts the agent wrapper, and connects an `ApiSessionClient`.

### ApiSessionClient

`cli/src/api/apiSession.ts` is the session-scoped Hub client.

It does five jobs:

1. Connect to Hub `/cli` with `clientType: 'session-scoped'`.
2. Register session-scoped RPC handlers.
3. Send `session-alive`, metadata updates, agent state updates, and output messages.
4. Receive queued user messages and deliver them to the agent loop.
5. Bridge browser terminal events to `TerminalManager`.

### ApiMachineClient

`cli/src/api/apiMachine.ts` is the machine-scoped Hub client used by runner.

It does four jobs:

1. Connect to Hub `/cli` with `clientType: 'machine-scoped'`.
2. Register machine-scoped RPC handlers.
3. Guard workspace-root access for directory browsing and remote spawn.
4. Emit machine heartbeat and health.

### Common RPC handlers

`cli/src/modules/common/registerCommonHandlers.ts` registers local capabilities used by both session and machine clients.

Examples:

- file read/write and upload helpers
- directory listing
- ripgrep
- difftastic
- bash
- git status/diff
- slash commands and skills
- Codex/Cursor/OpenCode/Pi model lists

The Hub only routes these calls. The local process executes them.

## Runner internals

`hapi runner start` starts a long-lived machine daemon.

Key files:

- `cli/src/commands/runner.ts`
- `cli/src/runner/run.ts`
- `cli/src/runner/controlServer.ts`
- `cli/src/runner/validateWorkspaceDirectory.ts`
- `cli/src/runner/worktree.ts`

Runner responsibilities:

- Register a machine record with the Hub.
- Keep machine heartbeat alive.
- Expose machine RPC handlers.
- Spawn new HAPI child sessions from Web requests.
- Enforce `--workspace-root` scoping.
- Maintain a local control server for list/stop/spawn operations.
- Persist runner state so newer runner processes can take over cleanly.

The runner is intentionally boring. It does not parse agent output. It starts child CLI processes and lets each child connect back to Hub as its own session.

## Web internals

### Bootstrap

`web/src/main.tsx` detects runtime mode, then mounts:

- Telegram SDK only inside Telegram Mini App
- browser history for normal web
- memory history for Telegram mode
- TanStack Query
- i18n
- TanStack Router

### API client

`web/src/api/client.ts` wraps fetch:

- attaches auth token
- refreshes on unauthorized through callback
- normalizes REST calls into typed methods
- exposes session, message, machine, git, permission, voice, model, and spawn APIs

### Realtime updates

`web/src/hooks/useSSE.ts` creates an EventSource connection to `/api/events`.

It:

- builds scoped SSE URLs
- decodes session and machine patches with shared schemas
- updates TanStack Query caches
- reconnects on failure
- keeps message/session/machine state current without polling

### Main UI surfaces

| Surface | File | Responsibility |
|---------|------|----------------|
| Router and pages | `web/src/router.tsx` | route tree, session/new/files/terminal/settings/share pages |
| Session chat | `web/src/components/SessionChat.tsx` | chat transcript, composer, mode/model controls, permission actions, terminal entry |
| New session | `web/src/components/NewSession/index.tsx` | machine selection, directory selection, model discovery, spawn request |
| API hooks | `web/src/hooks/queries/*`, `web/src/hooks/mutations/*` | TanStack Query bindings |
| Terminal UI | `web/src/routes/terminal*`, terminal components | xterm integration through `/terminal` socket |

`SessionChat.tsx` and `router.tsx` are now large enough that they are architecture pressure points. See the refactor plan below.

## Sequence diagrams

### 1. Remote session spawn

```text
User/Web        Hub API        SyncEngine      RpcGateway      Runner/Machine       Child CLI       Agent
   │              │               │               │                │                 │             │
   │ POST /api/machines/:id/spawn │               │                │                 │             │
   ├─────────────►│               │               │                │                 │             │
   │              │ validate JWT, machine namespace                │                 │             │
   │              ├──────────────►│               │                │                 │             │
   │              │               │ spawnSession  │                │                 │             │
   │              │               ├──────────────►│                │                 │             │
   │              │               │               │ machine RPC spawn-happy-session  │             │
   │              │               │               ├───────────────►│                 │             │
   │              │               │               │                │ validate workspace root          │
   │              │               │               │                │ spawn hapi <agent> child          │
   │              │               │               │                ├────────────────►│             │
   │              │               │               │                │                 │ bootstrap session via /cli routes
   │              │               │               │                │                 ├────────────►│
   │              │               │               │                │                 │ connect /cli session-scoped
   │              │               │◄──────────────┤◄───────────────┤                 │             │
   │◄─────────────┤ success sessionId             │                │                 │             │
   │              │               │               │                │                 │ session-ready/alive
   │◄═════════════╪═══════════════╪═══════════════╪════════════════╪═════════════════╪             │
        SSE session-created / session-updated
```

Primary files:

- Web: `web/src/components/NewSession/index.tsx`
- Hub route: `hub/src/web/routes/machines.ts`
- Coordinator: `hub/src/sync/syncEngine.ts`
- RPC: `hub/src/sync/rpcGateway.ts`
- Runner: `cli/src/runner/run.ts`
- Machine client: `cli/src/api/apiMachine.ts`
- Session bootstrap: `cli/src/agent/sessionFactory.ts`

### 2. User message to agent and streamed response

```text
User/Web      Hub API       MessageService       CLI Session      Agent Wrapper      Store/SSE
   │            │                │                  │                │                │
   │ POST /api/messages          │                  │                │                │
   ├───────────►│                │                  │                │                │
   │            │ validate JWT/session namespace    │                │                │
   │            ├───────────────►│ persist queued user message       │                │
   │            │                ├─────────────────►│ socket update/new-message      │
   │◄───────────┤ accepted       │                  │                │                │
   │            │                │                  │ deliver to agent loop           │
   │            │                │                  ├───────────────►│                │
   │            │                │                  │                │ stream events   │
   │            │                │                  │◄───────────────┤                │
   │            │                │                  │ emit message/update             │
   │            │◄═══════════════╪══════════════════╪════════════════╪═══════════════ │
   │◄═══════════╪════════════════╪══════════════════╪════════════════╪═══════════════ │
        SSE message-created / session-updated, TanStack Query cache patched
```

Primary files:

- Web API client: `web/src/api/client.ts`
- Hub route: `hub/src/web/routes/messages.ts`
- Message service: `hub/src/sync/messageService.ts`
- CLI session: `cli/src/api/apiSession.ts`
- Agent loops: `cli/src/*/loop.ts`

### 3. Permission request and approval

```text
Agent        CLI Session        Hub Socket        SyncEngine/SSE       Web/PWA       RpcGateway
  │              │                  │                  │                │             │
  │ request tool permission         │                  │                │             │
  ├─────────────►│ update agentState with request       │                │             │
  │              ├─────────────────►│                  │                │             │
  │              │                  ├─────────────────►│ store/cache, notify          │
  │              │                  │                  ├═══════════════►│             │
  │              │                  │                       SSE + push/Telegram       │
  │              │                  │                  │                │ approve     │
  │              │                  │                  │                ├────────────►│
  │              │                  │                  │                │             │ session RPC permission
  │              │◄═════════════════╪══════════════════╪════════════════╪═════════════┤
  │ receive decision                │                  │                │             │
  │◄─────────────┤                  │                  │                │             │
```

Primary files:

- Agent adapters: `cli/src/agent/permissionAdapter.ts`, agent-specific sessions
- CLI session: `cli/src/api/apiSession.ts`
- Hub session handlers: `hub/src/socket/handlers/cli/sessionHandlers.ts`
- Hub permission route: `hub/src/web/routes/permissions.ts`
- RPC gateway: `hub/src/sync/rpcGateway.ts`
- Web chat: `web/src/components/SessionChat.tsx`

### 4. Codex model list discovery

```text
Web NewSession / Chat      Hub API          SyncEngine       RpcGateway       Runner or Session CLI      Codex app-server
        │                    │                 │                │                    │                         │
        │ GET /api/machines/:id/codex-models   │                │                    │                         │
        ├───────────────────►│                 │                │                    │                         │
        │                    │ require machine namespace        │                    │                         │
        │                    ├────────────────►│ listCodexModelsForMachine           │                         │
        │                    │                 ├───────────────►│ machine RPC listCodexModels      │
        │                    │                 │                ├───────────────────►│                         │
        │                    │                 │                │                    │ resolve codex executable │
        │                    │                 │                │                    │ spawn app-server         │
        │                    │                 │                │                    ├────────────────────────►│
        │                    │                 │                │                    │ initialize + listModels  │
        │                    │                 │                │                    │◄────────────────────────┤
        │◄───────────────────┤◄────────────────┤◄───────────────┤◄───────────────────┤                         │
```

Primary files:

- Web API: `web/src/api/client.ts`
- Hub routes: `hub/src/web/routes/machines.ts`, `hub/src/web/routes/sessions.ts`
- Hub coordinator: `hub/src/sync/syncEngine.ts`
- Common handler: `cli/src/modules/common/codexModels.ts`
- Codex app-server client: `cli/src/codex/codexAppServerClient.ts`

Operational note: this flow depends on the runner or session process being able to resolve the Codex executable. Detached runner environments often have a smaller `PATH` than an interactive shell, so executable resolution must not assume the user's login shell state.

### 5. Browser terminal

```text
Web Terminal      Hub /terminal       TerminalRegistry       Hub /cli room       CLI TerminalManager       Local PTY
     │                 │                    │                    │                    │                  │
     │ terminal:create │                    │                    │                    │                  │
     ├────────────────►│ validate JWT, active session, namespace │                    │                  │
     │                 ├───────────────────►│ register terminalId │                    │                  │
     │                 │                    │ pick CLI socket from session room         │                  │
     │                 ├══════════════════════════════════════════►│ terminal:open      │                  │
     │                 │                    │                    │                    ├─────────────────►│
     │ terminal:write  │                    │                    │                    │ write stdin      │
     ├────────────────►│─────────────────────────────────────────►│───────────────────►│─────────────────►│
     │                 │                    │                    │                    │ output           │
     │◄════════════════╪════════════════════╪════════════════════╪════════════════════╪◄────────────────┤
     │ terminal:close  │                    │                    │                    │ close PTY        │
     ├────────────────►│ remove registry    │                    ├───────────────────►│─────────────────►│
```

Primary files:

- Hub terminal namespace: `hub/src/socket/handlers/terminal.ts`
- Hub CLI terminal forwarding: `hub/src/socket/handlers/cli/terminalHandlers.ts`
- Registry: `hub/src/socket/terminalRegistry.ts`
- CLI terminal manager: `cli/src/terminal/TerminalManager.ts`
- Web terminal route/components: `web/src/router.tsx`, terminal UI files

### 6. Local and remote handoff

```text
Local Terminal      CLI Session       Hub        Web/PWA        Agent
      │                 │              │            │             │
      │ starts local mode              │            │             │
      │                 │ session-alive mode=local  │             │
      │                 ├─────────────►│═══════════►│             │
      │                 │              │            │ send msg     │
      │                 │◄═════════════╪════════════┤             │
      │ switch to remote mode          │            │             │
      │ shows remote waiting UI        │            │             │
      │                 ├────────────────────────────────────────►│
      │ double-space or local handoff  │            │             │
      │                 │ session-alive mode=local  │             │
      │                 ├─────────────►│═══════════►│             │
```

Primary files:

- CLI local handoff helpers: `cli/src/agent/localHandoff.ts`, `cli/src/agent/localLaunchPolicy.ts`
- Agent sessions: `cli/src/*/session.ts`
- Hub handoff methods: `hub/src/sync/syncEngine.ts`, `hub/src/sync/rpcGateway.ts`
- Web session controls: `web/src/components/SessionChat.tsx`

## Data model

### Session

A session is a persistent row plus live cache state.

Important fields:

| Field | Meaning |
|-------|---------|
| `id` | Stable session id |
| `namespace` | Tenant/user isolation boundary |
| `metadata` | Agent flavor, path, model, effort, capabilities, worktree info, summaries |
| `metadataVersion` | Monotonic guard for metadata updates |
| `agentState` | Current tool use, permission request, thinking state, background tasks |
| `agentStateVersion` | Monotonic guard for agent state updates |
| `active` | Whether Hub considers the session live |
| `mode` | Local or remote control mode |
| `todos`, `teamState`, `goal` | Agent-visible structured state surfaced in Web |

The flexible `metadata` field is useful, but it is also a debt area. It has become the shared state bus for many agent-specific details.

### Machine

A machine is a runner or local process registered with the Hub.

Important fields:

| Field | Meaning |
|-------|---------|
| `id` | Stable machine id |
| `namespace` | Tenant/user isolation boundary |
| `metadata` | Hostname, platform, cwd, workspace roots, version |
| `runnerState` | Runner lifecycle, started time, pid, control URL |
| `health` | Heartbeat and resource health |
| `active` | Whether machine heartbeat is fresh |

### Message

Messages are persisted with ordering metadata:

| Field | Meaning |
|-------|---------|
| `seq` | Session-local monotonic sequence |
| `localId` | Client-generated id for optimistic / queued messages |
| `content` | Shared JSON message payload |
| `createdAt` | Persist time |
| `scheduledAt` | Optional future delivery time |
| `invokedAt` | When the CLI consumed the user message |

`MessageService` filters internal/meta messages for web display and exports.

## Auth and isolation

### CLI auth

CLI clients use `CLI_API_TOKEN` or `CLI_API_TOKEN:<namespace>`.

- Base token authenticates the client.
- Suffix selects namespace.
- Hub checks session/machine namespace before joining socket rooms or serving data.

### Web auth

Web clients use JWTs issued by Hub auth/bind routes.

JWT payload includes:

- user id
- namespace

### Terminal auth

Browser terminal sockets use JWT. Hub then maps terminal events to a connected CLI socket in the matching session room and namespace.

## Agent flavors

Current shared flavors:

```text
claude, codex, cursor, gemini, kimi, opencode, pi
```

Creation should use `CREATABLE_AGENT_FLAVORS`, not the raw list. Gemini is retained for old stored sessions but excluded from new creation in shared mode definitions.

Each flavor has different runtime behavior:

| Flavor | Integration style | Notes |
|--------|-------------------|-------|
| Claude | Native Claude Code wrapper | local/remote handoff, permission modes, MCP/tool events |
| Codex | Codex app-server client and launcher | model catalog via app-server, plan/default collaboration mode |
| Cursor | Cursor Agent integration | ACP and legacy paths exist |
| OpenCode | OpenCode launcher/session | model and reasoning option discovery |
| Kimi | Kimi launcher/session | Codex-like permission modes |
| Pi | RPC/transport style integration | no runtime permission switching |
| Gemini | Legacy validation only for stored sessions | not offered for new sessions through creatable flavors |

## Extension patterns

### Add a new API endpoint

1. Add request/response schema in `shared/src/apiTypes.ts` if the shape crosses package boundaries.
2. Add route in `hub/src/web/routes/*`.
3. Register route group in `hub/src/web/server.ts` if new file.
4. Add ApiClient method in `web/src/api/client.ts`.
5. Add TanStack query/mutation hook if used by UI.
6. Add route tests under `hub/src/web/routes/*.test.ts`.

### Add a new RPC method

1. Add method name in `shared/src/rpcMethods.ts`.
2. Add request/response schemas or types in `shared/src/apiTypes.ts`.
3. Register CLI handler in `cli/src/modules/common/registerCommonHandlers.ts` or a specific session/machine client.
4. Add a typed wrapper in `hub/src/sync/rpcGateway.ts`.
5. Expose through `SyncEngine` only if route/UI needs it.
6. Add tests for handler, gateway behavior, and route behavior.

### Add a new agent flavor

1. Add flavor and permission modes in `shared/src/modes.ts`.
2. Add CLI command in `cli/src/commands/*` and registry entry.
3. Add launcher/session/loop files under `cli/src/<agent>/`.
4. Use `bootstrapSession` / `bootstrapExistingSession` from `cli/src/agent/sessionFactory.ts`.
5. Register session RPC handlers for permission, abort, switch, and config if supported.
6. Add Web new-session controls and model discovery only if the agent exposes them.
7. Add tests at CLI session, command, and Web selector boundaries.

## Current pressure points

### 1. SyncEngine is too large

`hub/src/sync/syncEngine.ts` is about 1,600 lines and owns multiple domains. It is the right place to start when debugging, but the wrong place to keep adding unrelated responsibilities.

User impact: unrelated changes become risky. A model-list fix can accidentally touch session lifecycle or message delivery paths.

### 2. Web session UI is too concentrated

`web/src/components/SessionChat.tsx` is about 1,350 lines. `web/src/router.tsx` is about 1,280 lines. These files now mix routing, session actions, model controls, terminal entry, permissions, and agent-specific differences.

User impact: small UI changes are harder to test and easy to regress.

### 3. Metadata is a flexible but overloaded bus

`metadata` is useful for shipping fast. It is also where agent-specific shape drift hides.

User impact: stale or ambiguous metadata can make the web show the wrong controls, model, effort, or state after reconnect.

### 4. RPC lacks per-method runtime validation at the gateway

RPC method names are centralized, but many request/response bodies are still typed by convention. Some callers validate manually, some cast.

User impact: disconnected or version-skewed clients fail later and with weaker error messages.

### 5. Single-node Hub assumption

SQLite plus in-memory caches plus Socket.IO rooms is a good local-first fit. It is not a horizontal-scaling design.

User impact: a single Hub process is simple and reliable. Multi-instance cloud deployment would need explicit work, likely Redis or another pub/sub layer.

## Refactor plan

This plan is intentionally incremental. No rewrite. Preserve behavior, add seams, move one responsibility at a time.

### Phase 0, lock behavior before moving code

Goal: make refactors safe.

Work:

1. Add or verify route tests for these flows:
   - remote spawn
   - send message
   - approve/deny permission
   - model list for machine and active session
   - terminal create/write/close
2. Add a small regression test for metadata version rejection and stale agentState rejection.
3. Add a smoke test for namespace denial across session, machine, and terminal paths.

Commands:

```bash
bun typecheck
bun run test
```

Exit criteria:

- Tests cover the five diagrams above.
- No production code moved yet.

### Phase 1, split SyncEngine facade from services

Goal: keep the public `SyncEngine` API stable while moving domains behind it.

Suggested extraction order:

1. `PermissionService`
   - From: approve/deny permission flow and permission-related RPC calls.
   - Why first: narrow surface, easy tests.
2. `ModelDiscoveryService`
   - From: Codex/Cursor/OpenCode/Pi model list methods.
   - Why second: isolates recent bug class and long RPC timeout behavior.
3. `SessionLifecycleService`
   - From: archive/delete/rename/reopen/resume/handoff/end.
   - Why third: larger, but still separable from message delivery.
4. `MachineService`
   - From: machine heartbeat, list, runner state, workspace directory helpers.

Keep `SyncEngine` as facade:

```ts
class SyncEngine {
    constructor(private services: SyncEngineServices) {}
    async listCodexModelsForMachine(machineId: string) {
        return this.services.modelDiscovery.listCodexModelsForMachine(machineId)
    }
}
```

Exit criteria:

- `SyncEngine` shrinks materially.
- Route files do not need to know about the new services yet.
- Existing tests keep passing.

### Phase 2, type RPC calls per method

Goal: fail at the Hub boundary, not deep inside CLI or Web.

Work:

1. Add a shared registry shape near `shared/src/rpcMethods.ts`:

```ts
const RpcSchemas = {
    listCodexModels: {
        request: ListCodexModelsRequestSchema,
        response: CodexModelsResponseSchema
    }
}
```

2. Teach `RpcGateway` to validate responses for newly covered methods.
3. Start with model-list and terminal-adjacent RPCs, because they are user-visible and recently touched.
4. Migrate method groups gradually.

Exit criteria:

- New RPC methods require schemas.
- Old methods can be migrated opportunistically without freezing feature work.

### Phase 3, split Web session surface

Goal: make UI changes local.

Suggested extraction order from `SessionChat.tsx`:

1. `SessionModelControls`
   - model, effort, reasoning effort, service tier, collaboration mode.
2. `SessionPermissionPanel`
   - current permission request, approve/deny UI.
3. `SessionActionBar`
   - abort, switch local/remote, terminal, archive/reopen.
4. `AgentStatusBar`
   - thinking, active state, mode, runner info.
5. `ComposerContainer`
   - composer wiring, attachment state, submit/cancel.

Suggested extraction order from `router.tsx`:

1. Route definitions stay in router.
2. Page bodies move into `web/src/routes/*Page.tsx`.
3. New-session directory handlers move near `NewSession` or a dedicated hook.

Exit criteria:

- `SessionChat.tsx` becomes orchestration plus layout.
- `router.tsx` mostly declares routes.
- Model controls can be tested without rendering the full chat page.

### Phase 4, tame metadata

Goal: keep flexibility but reduce ambiguity.

Work:

1. List all current metadata fields from `MetadataSchema` and real writes.
2. Split into stable top-level fields versus agent-specific details:

```ts
type Metadata = {
    flavor: AgentFlavor
    path: string
    model?: string | null
    capabilities?: SessionCapabilities
    agent?: {
        claude?: ClaudeMetadata
        codex?: CodexMetadata
        cursor?: CursorMetadata
        opencode?: OpencodeMetadata
    }
}
```

3. Keep backward reads for old rows.
4. Write new shape only after Web and CLI both understand it.

Exit criteria:

- Web controls depend on stable fields, not ad hoc checks.
- Agent-specific metadata has a home.

## What not to refactor yet

Do not rewrite the whole agent adapter layer first. It is tempting. It is also the ocean.

Better sequence:

1. Lock behavior.
2. Split Hub service domains.
3. Add RPC schemas.
4. Split Web surfaces.
5. Then revisit a formal `AgentAdapter` contract if the remaining duplication is obvious.

## Review checklist for architecture changes

Before landing architecture changes, run:

```bash
bun typecheck
bun run test
```

Then manually verify at least one remote session flow:

```text
1. Start hub.
2. Start runner with a workspace root.
3. Open Web new session.
4. List models for the selected agent if supported.
5. Spawn session.
6. Send a message.
7. Approve or deny one permission if the agent asks.
8. Open terminal and run `pwd`.
```

If a change touches Codex model discovery, verify from a detached runner process, not just an interactive shell. Runner environments have different `PATH` behavior.

## Fast file index

| Need to change | Start here |
|----------------|------------|
| CLI command routing | `cli/src/commands/runCli.ts`, `cli/src/commands/registry.ts` |
| New agent wrapper | `cli/src/<agent>/`, `cli/src/agent/sessionFactory.ts` |
| Hub route | `hub/src/web/routes/*`, `hub/src/web/server.ts` |
| Session state | `hub/src/sync/syncEngine.ts`, `hub/src/sync/sessionCache.ts`, `shared/src/schemas.ts` |
| Machine/runner state | `cli/src/runner/run.ts`, `cli/src/api/apiMachine.ts`, `hub/src/sync/machineCache.ts` |
| RPC method | `shared/src/rpcMethods.ts`, `cli/src/modules/common/registerCommonHandlers.ts`, `hub/src/sync/rpcGateway.ts` |
| Web REST call | `web/src/api/client.ts` |
| Web realtime update | `web/src/hooks/useSSE.ts` |
| New session UI | `web/src/components/NewSession/index.tsx` |
| Chat/session UI | `web/src/components/SessionChat.tsx` |
| Terminal | `hub/src/socket/handlers/terminal.ts`, `hub/src/socket/handlers/cli/terminalHandlers.ts`, `cli/src/terminal/TerminalManager.ts` |
| Shared type/schema | `shared/src/apiTypes.ts`, `shared/src/schemas.ts`, `shared/src/socket.ts`, `shared/src/modes.ts` |
