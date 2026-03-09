# Database Guidelines

> Database patterns and conventions in this project.

---

## Overview

HAPI Hub uses **SQLite** with Bun's native SQLite driver. The database layer follows a clean architecture with:

- **WAL mode** for better concurrency
- **Strict mode** for type safety
- **Foreign keys** enabled
- **Versioned updates** for optimistic concurrency control
- **Two-layer pattern**: Store classes (CRUD) + Business logic functions

**Key characteristics**:
- Single SQLite database file with WAL
- Namespace-based multi-tenancy
- Optimistic locking with version fields
- Type-safe query results
- Schema migrations with version tracking

---

## Database Configuration

### Initialization (`store/index.ts`)

```typescript
export class Store {
    constructor(dbPath: string) {
        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })

        // Enable WAL mode for better concurrency
        this.db.exec('PRAGMA journal_mode = WAL')

        // NORMAL synchronous mode (balance between safety and performance)
        this.db.exec('PRAGMA synchronous = NORMAL')

        // Enable foreign key constraints
        this.db.exec('PRAGMA foreign_keys = ON')

        // 5 second busy timeout for lock contention
        this.db.exec('PRAGMA busy_timeout = 5000')

        this.initSchema()
    }
}
```

**Key settings**:
- `journal_mode = WAL` - Write-Ahead Logging for concurrent reads
- `synchronous = NORMAL` - Balance safety and performance
- `foreign_keys = ON` - Enforce referential integrity
- `busy_timeout = 5000` - Wait 5s for locks before failing
- `strict: true` - Type-safe mode (Bun SQLite feature)

---

## Schema Design

### Table Structure

```sql
-- Sessions table
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    tag TEXT,
    namespace TEXT NOT NULL DEFAULT 'default',
    machine_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT,                    -- JSON blob
    metadata_version INTEGER DEFAULT 1,
    agent_state TEXT,                 -- JSON blob
    agent_state_version INTEGER DEFAULT 1,
    todos TEXT,                       -- JSON blob
    todos_updated_at INTEGER,
    active INTEGER DEFAULT 0,         -- Boolean (0/1)
    active_at INTEGER,
    seq INTEGER DEFAULT 0             -- Sequence number for sync
);

CREATE INDEX idx_sessions_tag ON sessions(tag);
CREATE INDEX idx_sessions_tag_namespace ON sessions(tag, namespace);
```

**Conventions**:
- Primary key: `TEXT` (UUID)
- Timestamps: `INTEGER` (Unix milliseconds)
- Booleans: `INTEGER` (0/1)
- JSON data: `TEXT` with `_version` field for optimistic locking
- Namespace: `TEXT NOT NULL` for multi-tenancy
- Sequence: `INTEGER` for sync ordering

### Foreign Keys

```sql
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    local_id TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

**Always use**:
- `FOREIGN KEY` constraints for relationships
- `ON DELETE CASCADE` for dependent data
- Indexes on foreign key columns

### Naming Conventions

- **Tables**: `snake_case`, plural (e.g., `sessions`, `push_subscriptions`)
- **Columns**: `snake_case` (e.g., `created_at`, `session_id`)
- **Indexes**: `idx_<table>_<columns>` (e.g., `idx_sessions_tag_namespace`)
- **IDs**: `TEXT` UUID primary keys for entities, `INTEGER AUTOINCREMENT` for lookup tables

---

## Two-Layer Pattern

### Layer 1: Store Classes (CRUD)

Store classes are thin wrappers that provide a typed API:

```typescript
// store/sessionStore.ts
export class SessionStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): StoredSession {
        return getOrCreateSession(this.db, tag, metadata, agentState, namespace)
    }

    updateSessionMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string,
        options?: { touchUpdatedAt?: boolean }
    ): VersionedUpdateResult<unknown | null> {
        return updateSessionMetadata(this.db, id, metadata, expectedVersion, namespace, options)
    }

    getSession(id: string): StoredSession | null {
        return getSession(this.db, id)
    }

    deleteSession(id: string, namespace: string): boolean {
        return deleteSession(this.db, id, namespace)
    }
}
```

**Pattern**: Store class delegates to pure functions, provides type-safe API.

### Layer 2: Business Logic Functions

Business logic functions contain the actual SQL:

```typescript
// store/sessions.ts
export function getOrCreateSession(
    db: Database,
    tag: string,
    metadata: unknown,
    agentState: unknown,
    namespace: string
): StoredSession {
    // 1. Check if exists
    const existing = db.prepare(
        'SELECT * FROM sessions WHERE tag = ? AND namespace = ? ORDER BY created_at DESC LIMIT 1'
    ).get(tag, namespace) as DbSessionRow | undefined

    if (existing) {
        return toStoredSession(existing)
    }

    // 2. Create new
    const id = randomUUID()
    const now = Date.now()

    db.prepare(`
        INSERT INTO sessions (id, tag, namespace, created_at, updated_at, metadata, ...)
        VALUES (@id, @tag, @namespace, @created_at, @updated_at, @metadata, ...)
    `).run({ id, tag, namespace, created_at: now, updated_at: now, metadata: JSON.stringify(metadata) })

    // 3. Fetch and return
    const row = getSession(db, id)
    if (!row) throw new Error('Failed to create session')
    return row
}
```

**Why two layers**:
- Store classes provide stable, typed API
- Business logic functions are pure and testable
- Easy to mock database in tests
- Clear separation of concerns

---

## Optimistic Locking

### Versioned Updates

For concurrent updates, use versioned fields:

```typescript
// store/versionedUpdates.ts
export function updateVersionedField<T>(args: VersionedUpdateArgs<T>): VersionedUpdateResult<T> {
    // Try update with version check
    const result = args.db.prepare(
        `UPDATE ${args.table}
         SET ${args.field} = @field_value,
             ${args.versionField} = ${args.versionField} + 1
         WHERE id = @id AND namespace = @namespace AND ${args.versionField} = @expectedVersion`
    ).run({ id: args.id, namespace: args.namespace, expectedVersion: args.expectedVersion, field_value: args.encode(args.value) })

    if (result.changes === 1) {
        return { result: 'success', version: args.expectedVersion + 1, value: args.value }
    }

    // Version mismatch - fetch current state
    const current = args.db.prepare(
        `SELECT ${args.field} AS field_value, ${args.versionField} AS version
         FROM ${args.table} WHERE id = ? AND namespace = ?`
    ).get(args.id, args.namespace) as { field_value: string | null; version: number } | undefined

    if (!current) {
        return { result: 'error' }
    }

    return { result: 'version-mismatch', version: current.version, value: args.decode(current.field_value) }
}
```

**Result types**:
- `{ result: 'success', version: number, value: T }` - Update succeeded
- `{ result: 'version-mismatch', version: number, value: T }` - Conflict, current value returned
- `{ result: 'error' }` - Row not found or database error

---

## Query Patterns

### Prepared Statements

Always use prepared statements (never string concatenation):

```typescript
// Good - parameterized
const row = db.prepare(
    'SELECT * FROM sessions WHERE id = ? AND namespace = ?'
).get(id, namespace) as DbSessionRow | undefined

// Bad - SQL injection risk
const row = db.query(`SELECT * FROM sessions WHERE id = '${id}'`)
```

### Named Parameters

Use named parameters for complex queries:

```typescript
db.prepare(`
    INSERT INTO sessions (id, tag, namespace, created_at, updated_at, metadata)
    VALUES (@id, @tag, @namespace, @created_at, @updated_at, @metadata)
`).run({
    id: randomUUID(),
    tag,
    namespace,
    created_at: Date.now(),
    updated_at: Date.now(),
    metadata: JSON.stringify(metadata)
})
```

### Type-Safe Results

Always type query results with a `Db*Row` type:

```typescript
// Define DB row type (snake_case matching DB columns)
type DbSessionRow = {
    id: string
    tag: string | null
    namespace: string
    created_at: number
    metadata: string | null
    metadata_version: number
    active: number  // SQLite boolean (0/1)
}

// Type assertion
const row = db.prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as DbSessionRow | undefined

// Transform to domain type (camelCase)
function toStoredSession(row: DbSessionRow): StoredSession {
    return {
        id: row.id,
        tag: row.tag,
        namespace: row.namespace,
        createdAt: row.created_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        active: row.active === 1  // Convert 0/1 to boolean
    }
}
```

---

## JSON Storage

### Storing JSON

```typescript
// Serialize (handle null)
const value = data === null || data === undefined ? null : JSON.stringify(data)
db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run(value, id)
```

### Parsing JSON (`store/json.ts`)

```typescript
export function safeJsonParse(value: string | null): unknown {
    if (value === null) return null
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}
```

**Always use `safeJsonParse`** - handles null and parse errors gracefully.

---

## Schema Migrations

### Version Tracking

```typescript
const SCHEMA_VERSION = 3

private initSchema(): void {
    const currentVersion = this.getUserVersion()

    if (currentVersion === 0) {
        this.createSchema()
        this.setUserVersion(SCHEMA_VERSION)
        return
    }

    // Sequential migrations
    if (currentVersion === 1 && SCHEMA_VERSION >= 2) {
        this.migrateFromV1ToV2()
        if (SCHEMA_VERSION === 2) {
            this.setUserVersion(SCHEMA_VERSION)
            return
        }
    }

    if (currentVersion <= 2 && SCHEMA_VERSION === 3) {
        this.migrateFromV2ToV3()
        this.setUserVersion(SCHEMA_VERSION)
        return
    }

    if (currentVersion !== SCHEMA_VERSION) {
        throw this.buildSchemaMismatchError(currentVersion)
    }
}
```

### Migration Pattern

```typescript
private migrateFromV2ToV3(): void {
    this.db.exec(`
        ALTER TABLE sessions ADD COLUMN todos TEXT;
        ALTER TABLE sessions ADD COLUMN todos_updated_at INTEGER;
    `)
}
```

**Rules**:
- Increment `SCHEMA_VERSION` for each migration
- One migration function per version transition
- Migrations are one-way (no rollback)
- `ALTER TABLE ADD COLUMN` with `DEFAULT` for backward compatibility

---

## Multi-Tenancy (Namespaces)

Always filter by `namespace` in all queries:

```typescript
// Reads - always filter by namespace
const sessions = db.prepare(
    'SELECT * FROM sessions WHERE namespace = ?'
).all(namespace) as DbSessionRow[]

// Writes - always include namespace check
db.prepare(
    'UPDATE sessions SET metadata = @metadata WHERE id = @id AND namespace = @namespace'
).run({ metadata, id, namespace })

// Deletes - always include namespace check
db.prepare(
    'DELETE FROM sessions WHERE id = ? AND namespace = ?'
).run(id, namespace)
```

**Why**: Prevents data leakage between users.

---

## Common Mistakes

- ❌ Not using prepared statements (SQL injection risk)
- ❌ String concatenation in queries
- ❌ Not typing query results (implicit `any`)
- ❌ Forgetting `namespace` filter in queries
- ❌ Not handling JSON parse errors (use `safeJsonParse`)
- ❌ Not using versioned updates for concurrent modifications
- ❌ Missing indexes on frequently queried columns
- ❌ Not using `ON DELETE CASCADE` for dependent data
- ❌ Storing timestamps as strings instead of integers
- ❌ Forgetting to increment `SCHEMA_VERSION` after schema changes
- ❌ Not enabling foreign keys (`PRAGMA foreign_keys = ON`)

---

## Best Practices

- ✅ Always use prepared statements with parameters
- ✅ Type all `Db*Row` types explicitly (snake_case)
- ✅ Transform DB rows to domain types (camelCase) in `toStored*` functions
- ✅ Use versioned updates for concurrent modifications
- ✅ Filter by `namespace` in all queries
- ✅ Use `safeJsonParse` for JSON columns
- ✅ Create indexes on frequently queried columns
- ✅ Use foreign keys with `ON DELETE CASCADE`
- ✅ Store timestamps as integers (Unix milliseconds)
- ✅ Keep migrations sequential and one-way
