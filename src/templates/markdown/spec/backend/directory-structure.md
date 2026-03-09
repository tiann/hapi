# Directory Structure

> How backend code is organized in this project.

---

## Overview

HAPI Hub is a Bun-based backend service that provides:
- HTTP API server (Hono framework)
- Socket.IO server for real-time CLI connections
- SSE (Server-Sent Events) for web client updates
- SQLite database with WAL mode
- WireGuard tunnel management

**Key characteristics**:
- Feature-based organization (notifications, socket, store, etc.)
- Flat module structure (max 2 levels deep)
- Clear separation of concerns (handlers, stores, services)
- Type-safe with strict TypeScript

---

## Directory Layout

```
hub/src/
├── config/                 # Configuration management
│   ├── jwtSecret.ts        # JWT secret generation/loading
│   ├── vapidKeys.ts        # VAPID keys for push notifications
│   ├── settings.ts         # Server settings (port, CORS, etc.)
│   └── ...
├── notifications/          # Notification system
│   ├── notificationHub.ts  # Central notification dispatcher
│   ├── eventParsing.ts     # Parse sync events into notifications
│   └── notificationTypes.ts # Notification channel interface
├── push/                   # Web Push notifications
│   ├── pushService.ts      # Push notification service
│   └── pushNotificationChannel.ts # Push channel implementation
├── socket/                 # Socket.IO server
│   ├── server.ts           # Socket.IO server setup
│   ├── handlers/           # Socket event handlers
│   │   ├── cli/            # CLI client handlers
│   │   │   ├── machineHandlers.ts
│   │   │   ├── sessionHandlers.ts
│   │   │   ├── terminalHandlers.ts
│   │   │   └── rpcHandlers.ts
│   │   └── terminal.ts     # Terminal emulator handlers
│   ├── rpcRegistry.ts      # RPC method registry
│   └── terminalRegistry.ts # Terminal session registry
├── sse/                    # Server-Sent Events
│   └── sseManager.ts       # SSE connection manager
├── store/                  # Database layer (SQLite)
│   ├── index.ts            # Store initialization & schema
│   ├── sessionStore.ts     # Session CRUD operations
│   ├── machineStore.ts     # Machine CRUD operations
│   ├── messageStore.ts     # Message CRUD operations
│   ├── userStore.ts        # User CRUD operations
│   ├── pushStore.ts        # Push subscription CRUD
│   ├── sessions.ts         # Session business logic
│   ├── machines.ts         # Machine business logic
│   ├── messages.ts         # Message business logic
│   └── types.ts            # Store type definitions
├── sync/                   # Sync engine
│   └── syncEngine.ts       # Central state synchronization
├── tunnel/                 # WireGuard tunnel management
│   └── ...
├── types/                  # Shared type definitions
│   └── ...
├── utils/                  # Utility functions
│   └── ...
├── visibility/             # Visibility tracking
│   └── visibilityTracker.ts
├── web/                    # HTTP API server
│   ├── server.ts           # Hono server setup
│   ├── middleware/         # HTTP middleware
│   └── routes/             # API route handlers
├── configuration.ts        # Configuration loading
└── index.ts                # Main entry point
```

---

## Module Organization

### Feature-Based Modules

Each feature is a directory containing related functionality:

```
notifications/
├── notificationHub.ts      # Main service
├── eventParsing.ts         # Helper logic
├── notificationTypes.ts    # Type definitions
└── notificationHub.test.ts # Tests
```

**Pattern**: `<feature>/<feature>Service.ts` + helpers + types + tests

### Store Layer Pattern

Database operations follow a two-layer pattern:

1. **Store classes** (`*Store.ts`) - Raw CRUD operations
2. **Business logic** (`*.ts`) - Higher-level operations

```
store/
├── sessionStore.ts         # Raw CRUD: insert, update, delete, select
├── sessions.ts             # Business logic: getOrCreateSession, updateMetadata
└── types.ts                # Shared types
```

**Why**: Separates data access from business logic, makes testing easier.

### Handler Pattern

Socket.IO and HTTP handlers are organized by client type:

```
socket/handlers/
├── cli/                    # Handlers for CLI clients
│   ├── machineHandlers.ts  # Machine lifecycle events
│   ├── sessionHandlers.ts  # Session management
│   └── terminalHandlers.ts # Terminal I/O
└── terminal.ts             # Handlers for web terminal clients
```

---

## Naming Conventions

### Files

- **Services/Managers**: PascalCase class name (e.g., `NotificationHub.ts`, `SSEManager.ts`)
- **Stores**: PascalCase with `Store` suffix (e.g., `SessionStore.ts`, `MachineStore.ts`)
- **Handlers**: camelCase with `Handlers` suffix (e.g., `machineHandlers.ts`, `sessionHandlers.ts`)
- **Types**: camelCase (e.g., `types.ts`, `socketTypes.ts`)
- **Tests**: Same as source with `.test.ts` suffix (e.g., `notificationHub.test.ts`)

### Directories

- **Feature directories**: lowercase (e.g., `notifications/`, `socket/`, `store/`)
- **Subdirectories**: lowercase (e.g., `handlers/`, `middleware/`, `routes/`)

### Exports

- **Named exports** for all classes, functions, types
- **Barrel exports** in `index.ts` for public API

```typescript
// store/index.ts - barrel export
export { Store } from './index'
export { SessionStore } from './sessionStore'
export { MachineStore } from './machineStore'
export type { StoredSession, StoredMachine } from './types'
```

---

## Entry Point Flow

### Main Entry (`index.ts`)

```typescript
// 1. Load configuration
const config = createConfiguration(configSource)

// 2. Initialize store (SQLite)
const store = new Store(dbPath)

// 3. Create sync engine
const syncEngine = new SyncEngine(store)

// 4. Create notification hub
const notificationHub = new NotificationHub(syncEngine, channels)

// 5. Start web server (Hono + Socket.IO)
const webServer = await startWebServer({ store, syncEngine, ... })

// 6. Start optional services (tunnel)
const webServer = await startWebServer({ store, syncEngine, ... })
```

**Pattern**: Configuration → Store → Services → Servers

---

## Configuration Management

Configuration is loaded from multiple sources with priority:

1. Environment variables (highest priority)
2. `settings.json` file
3. Default values (lowest priority)

```typescript
// config/settings.ts
export type ServerSettings = {
    port: number
    cors: { origins: string[] }
}

// configuration.ts
export function createConfiguration(source: ConfigSource): Configuration {
    // Merge env, file, defaults
}
```

**Pattern**: Type-safe configuration with source tracking.

---

## Examples

### Well-organized modules

- **`store/`** - Clean separation between CRUD (stores) and business logic
- **`socket/handlers/cli/`** - Clear handler organization by client type
- **`notifications/`** - Self-contained feature with hub, parsing, types

### Adding a new feature

When adding a new feature (e.g., "Analytics"):

1. Create feature directory: `analytics/`
2. Add main service: `analytics/analyticsService.ts`
3. Add types: `analytics/types.ts`
4. Add tests: `analytics/analyticsService.test.ts`
5. Export from barrel: `analytics/index.ts`
6. Integrate in `index.ts` main entry point

---

## Anti-patterns

### Don't

- ❌ Create deeply nested directories (max 2 levels: `socket/handlers/cli/`)
- ❌ Mix business logic with data access (use store layer pattern)
- ❌ Put everything in `index.ts` (use feature modules)
- ❌ Use default exports (use named exports)
- ❌ Create circular dependencies between modules
- ❌ Put types in separate `types/` directory unless shared across many modules

### Do

- ✅ Keep modules flat and discoverable
- ✅ Separate CRUD from business logic (store pattern)
- ✅ Group related functionality in feature directories
- ✅ Use named exports consistently
- ✅ Keep types close to usage (in same module)
- ✅ Use barrel exports for public API
