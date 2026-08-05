import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

import { MachineStore } from './machineStore'
import { MessageStore } from './messageStore'
import { addMessage } from './messages'
import type { StoredMessage } from './types'
import { PushStore } from './pushStore'
import { FcmStore } from './fcmStore'
import { ScratchlistStore } from './scratchlistStore'
import { SessionStore } from './sessionStore'
import { UserStore } from './userStore'
import { UsageStore } from './usageStore'

export type {
    StoredMachine,
    StoredMessage,
    StoredPushSubscription,
    StoredFcmDevice,
    StoredScratchlistEntry,
    StoredSession,
    StoredUser,
    VersionedUpdateResult
} from './types'
export type { CancelQueuedMessageResult, LookupQueuedMessageResult } from './messages'
export { MachineStore } from './machineStore'
export { MessageStore } from './messageStore'
export { PushStore } from './pushStore'
export { FcmStore } from './fcmStore'
export { ScratchlistStore } from './scratchlistStore'
export { SessionStore } from './sessionStore'
export { UserStore } from './userStore'
export { UsageStore } from './usageStore'

const SCHEMA_VERSION: number = 20
const REQUIRED_TABLES = [
    'sessions',
    'machines',
    'messages',
    'message_epochs',
    'users',
    'push_subscriptions',
    'fcm_devices',
    'session_scratchlist',
    'usage_events',
    'usage_scan_state'
] as const

export class Store {
    private db: Database
    private readonly _dbPath: string
    private closed: boolean = false

    readonly sessions: SessionStore
    readonly machines: MachineStore
    readonly messages: MessageStore
    readonly users: UserStore
    readonly push: PushStore
    readonly fcm: FcmStore
    readonly scratchlist: ScratchlistStore
    readonly usage: UsageStore

    /**
     * Filesystem path of the underlying SQLite database, or ':memory:' for
     * in-memory stores. Used by the legacy → ACP migrator (#824) to take a
     * backup before a bulk run; treat as read-only.
     */
    get dbPath(): string {
        return this._dbPath
    }

    constructor(dbPath: string) {
        this._dbPath = dbPath
        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            const dir = dirname(dbPath)
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            try {
                chmodSync(dir, 0o700)
            } catch {
            }

            if (!existsSync(dbPath)) {
                try {
                    const fd = openSync(dbPath, 'a', 0o600)
                    closeSync(fd)
                } catch {
                }
            }
        }

        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        this.db.exec('PRAGMA foreign_keys = ON')
        this.db.exec('PRAGMA busy_timeout = 5000')
        this.initSchema()

        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                try {
                    chmodSync(path, 0o600)
                } catch {
                }
            }
        }

        this.sessions = new SessionStore(this.db)
        this.machines = new MachineStore(this.db)
        this.messages = new MessageStore(this.db)
        this.users = new UserStore(this.db)
        this.push = new PushStore(this.db)
        this.fcm = new FcmStore(this.db)
        this.scratchlist = new ScratchlistStore(this.db)
        this.usage = new UsageStore(this.db)
    }

    /**
     * Atomically records a CLI prompt-consumption acknowledgement and returns
     * the persisted session activity timestamp. A duplicate or sibling-stamped
     * acknowledgement leaves the session untouched while returning its existing
     * timestamp for replay-safe in-memory cache synchronization.
     */
    recordMessagesConsumed(
        sessionId: string,
        localIds: string[],
        invokedAt: number,
        namespace: string
    ): number {
        return this.db.transaction(() => {
            const changes = this.messages.markMessagesInvoked(sessionId, localIds, invokedAt)
            if (changes > 0) {
                this.sessions.touchSessionUpdatedAt(sessionId, invokedAt, namespace)
            }

            const session = this.sessions.getSessionByNamespace(sessionId, namespace)
            if (!session) {
                throw new Error('session not found after messages-consumed transition')
            }
            if (changes > 0 && session.updatedAt < invokedAt) {
                throw new Error('session activity was not persisted after messages-consumed transition')
            }

            return session.updatedAt
        })()
    }

    /** Resolve a durable OpenCode clear reservation and insert in one SQLite transaction. */
    addMessageForCurrentSession(
        sessionId: string,
        content: unknown,
        localId?: string,
        scheduledAt?: number | null
    ): { sessionId: string; message: StoredMessage; inserted: boolean } {
        return this.db.transaction(() => {
            const row = this.db.prepare('SELECT namespace, metadata FROM sessions WHERE id = ?').get(sessionId) as { namespace: string; metadata: string | null } | undefined
            if (!row) throw new Error('Message source session not found')
            let targetSessionId = sessionId
            if (row?.metadata) {
                const metadata = JSON.parse(row.metadata) as { opencodeClearOperation?: { replacementSessionId?: string; state?: string }, supersededBySessionId?: string }
                targetSessionId = metadata.supersededBySessionId
                    ?? (metadata.opencodeClearOperation?.state !== 'aborted'
                        ? metadata.opencodeClearOperation?.replacementSessionId
                        : undefined)
                    ?? sessionId
            }
            if (targetSessionId !== sessionId) {
                const target = this.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND namespace = ?')
                    .get(targetSessionId, row.namespace)
                if (!target) throw new Error('OpenCode clear redirect target is unavailable in the source namespace')
            }
            const alreadyExists = localId
                ? Boolean(this.db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1')
                    .get(targetSessionId, localId))
                : false
            return {
                sessionId: targetSessionId,
                message: addMessage(this.db, targetSessionId, content, localId, scheduledAt),
                inserted: !alreadyExists
            }
        })()
    }

    /** Durable delivery gate for a preallocated replacement owned by an unfinished clear. */
    isOpenCodeClearDeliveryGated(sessionId: string): boolean {
        const target = this.db.prepare('SELECT namespace FROM sessions WHERE id = ?')
            .get(sessionId) as { namespace: string } | undefined
        if (!target) return false
        const rows = this.db.prepare('SELECT metadata FROM sessions WHERE namespace = ? AND metadata IS NOT NULL')
            .all(target.namespace) as Array<{ metadata: string }>
        return rows.some((row) => {
            try {
                const operation = (JSON.parse(row.metadata) as {
                    opencodeClearOperation?: { replacementSessionId?: string; state?: string }
                }).opencodeClearOperation
                return operation?.replacementSessionId === sessionId
                    && operation.state !== 'completed'
                    && operation.state !== 'aborted'
            } catch {
                return false
            }
        })
    }

    abortOpenCodeClearOperation(
        sessionId: string,
        replacementSessionId: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string,
        expected?: { replacementSessionId: string; state: string; requireInactive?: boolean }
    ) {
        return this.db.transaction(() => {
            const current = this.sessions.getSessionByNamespace(sessionId, namespace)
            const operation = current?.metadata && typeof current.metadata === 'object'
                ? (current.metadata as { opencodeClearOperation?: { replacementSessionId?: string; state?: string } }).opencodeClearOperation
                : undefined
            if (expected && (!current
                || (expected.requireInactive === true && current.active)
                || operation?.replacementSessionId !== expected.replacementSessionId
                || operation.state !== expected.state)) {
                return { result: 'version-mismatch' as const }
            }
            const result = this.sessions.updateSessionMetadata(sessionId, metadata, expectedVersion, namespace, { touchUpdatedAt: false })
            if (result.result === 'success') this.messages.moveUninvokedMessages(replacementSessionId, sessionId)
            return result
        })()
    }

    transitionOpenCodeClearOperation(
        sessionId: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string,
        expected: { replacementSessionId: string; state: string }
    ) {
        return this.db.transaction(() => {
            const current = this.sessions.getSessionByNamespace(sessionId, namespace)
            const operation = current?.metadata && typeof current.metadata === 'object'
                ? (current.metadata as { opencodeClearOperation?: { replacementSessionId?: string; state?: string } }).opencodeClearOperation
                : undefined
            if (!current
                || operation?.replacementSessionId !== expected.replacementSessionId
                || operation.state !== expected.state) {
                return { result: 'version-mismatch' as const }
            }
            return this.sessions.updateSessionMetadata(sessionId, metadata, expectedVersion, namespace, { touchUpdatedAt: false })
        })()
    }

    close(): void {
        if (this.closed) return
        this.db.close()
        this.closed = true

        // Bun's SQLite close uses sqlite3_close_v2 by default, so prepared
        // statements that are already unreachable may keep the underlying file
        // handle alive until the next GC cycle. Windows refuses to remove a
        // directory while those SQLite WAL/SHM handles are still pending.
        if (process.platform === 'win32') {
            Bun.gc(true)
        }
    }

    private initSchema(): void {
        const currentVersion = this.getUserVersion()
        // V1/V2/V3 entries cover legacy DBs that pre-date our migration ladder.
        // Each step is idempotent (column-existence guards inside) so we can
        // safely run the full V1→V8 chain in the legacy branch where the DB
        // shape is unknown.
        const buildStepMigrations = (legacy: boolean): Record<number, () => void> => ({
            1: () => this.migrateFromV1ToV2(legacy),
            2: () => this.migrateFromV2ToV3(),
            3: () => this.migrateFromV3ToV4(),
            4: () => this.migrateFromV4ToV5(),
            5: () => this.migrateFromV5ToV6(),
            6: () => this.migrateFromV6ToV7(),
            7: () => this.migrateFromV7ToV8(),
            8: () => this.migrateFromV8ToV9(),
            9: () => this.migrateFromV9ToV10(),
            10: () => this.migrateFromV10ToV11(),
            11: () => this.migrateFromV11ToV12(),
            12: () => this.migrateFromV12ToV13(),
            13: () => this.migrateFromV13ToV14(),
            14: () => this.migrateFromV14ToV15(),
            15: () => this.migrateFromV15ToV16(),
            16: () => this.migrateFromV16ToV17(),
            17: () => this.migrateFromV17ToV18(),
            18: () => this.migrateFromV18ToV19(),
            19: () => this.migrateFromV19ToV20(),
        })

        if (currentVersion === 0) {
            if (this.hasAnyUserTables()) {
                this.migrateLegacySchemaIfNeeded()
                // Run the full step ladder BEFORE createSchema so legacy tables
                // pick up every later-version column (e.g. invoked_at) via ALTER
                // TABLE.  Without this, createSchema below would try to build
                // idx_messages_session_position over a column that does not
                // exist yet, and CREATE TABLE IF NOT EXISTS would not add the
                // missing column to the existing table.
                const legacySteps = buildStepMigrations(true)
                for (let v = 1; v < SCHEMA_VERSION; v++) {
                    legacySteps[v]?.()
                }
                // Backfill any *missing* tables (sessions, machines, ...) that
                // a partially-built legacy DB may not have yet.
                this.createSchema()
                this.setUserVersion(SCHEMA_VERSION)
                return
            }

            this.createSchema()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        const stepMigrations = buildStepMigrations(false)
        if (currentVersion < SCHEMA_VERSION && stepMigrations[currentVersion]) {
            for (let v = currentVersion; v < SCHEMA_VERSION; v++) {
                const step = stepMigrations[v]
                if (!step) throw this.buildSchemaMismatchError(currentVersion)
                step()
            }
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion !== SCHEMA_VERSION) {
            throw this.buildSchemaMismatchError(currentVersion)
        }

        this.assertRequiredTablesPresent()
    }

    private createSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                tag TEXT,
                namespace TEXT NOT NULL DEFAULT 'default',
                machine_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                agent_state TEXT,
                agent_state_version INTEGER DEFAULT 1,
                model TEXT,
                model_reasoning_effort TEXT,
                effort TEXT,
                service_tier TEXT,
                todos TEXT,
                todos_updated_at INTEGER,
                team_state TEXT,
                team_state_updated_at INTEGER,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                runner_state TEXT,
                runner_state_version INTEGER DEFAULT 1,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                local_id TEXT,
                invoked_at INTEGER,
                scheduled_at INTEGER,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_messages_session_position
                ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_scheduled_pending
                ON messages(scheduled_at)
                WHERE scheduled_at IS NOT NULL AND invoked_at IS NULL;

            CREATE TABLE IF NOT EXISTS message_epochs (
                session_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                platform_user_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                UNIQUE(platform, platform_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
            CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(namespace, endpoint)
            );
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);

            CREATE TABLE IF NOT EXISTS fcm_devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace TEXT NOT NULL,
                token TEXT NOT NULL,
                platform TEXT NOT NULL,
                device_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(namespace, device_id, platform)
            );
            CREATE INDEX IF NOT EXISTS idx_fcm_devices_namespace ON fcm_devices(namespace);
            CREATE INDEX IF NOT EXISTS idx_fcm_devices_token ON fcm_devices(token);

            CREATE TABLE IF NOT EXISTS session_scratchlist (
                session_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                attachments TEXT DEFAULT NULL,
                PRIMARY KEY (session_id, entry_id),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_scratchlist_session_created
                ON session_scratchlist(session_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS usage_events (
                session_id TEXT NOT NULL,
                source_key TEXT NOT NULL,
                source_seq INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                agent TEXT NOT NULL,
                model TEXT,
                kind TEXT NOT NULL CHECK (kind IN ('delta', 'cumulative')),
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                last_input_tokens INTEGER,
                last_output_tokens INTEGER,
                last_cache_read_tokens INTEGER,
                last_cache_creation_tokens INTEGER,
                PRIMARY KEY (session_id, source_key),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_usage_events_session_created
                ON usage_events(session_id, created_at, source_seq);
            CREATE INDEX IF NOT EXISTS idx_usage_events_created
                ON usage_events(created_at);

            CREATE TABLE IF NOT EXISTS usage_scan_state (
                session_id TEXT PRIMARY KEY,
                message_epoch INTEGER NOT NULL DEFAULT 0,
                last_seq INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
        `)
    }

    private migrateLegacySchemaIfNeeded(): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            return
        }

        const hasDaemon = columns.has('daemon_state') || columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') || columns.has('runner_state_version')

        if (hasDaemon && hasRunner) {
            throw new Error('SQLite schema has both daemon_state and runner_state columns in machines; manual cleanup required.')
        }

        if (hasDaemon && !hasRunner) {
            this.migrateFromV1ToV2()
        }
    }

    private migrateFromV1ToV2(legacy: boolean = false): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            // In the legacy branch the table may not exist yet — createSchema
            // will build the up-to-date one.  When invoked from the regular
            // upgrade path (user_version >= 1), missing the machines table is
            // still an error.
            if (legacy) return
            throw new Error('SQLite schema missing machines table for v1 to v2 migration.')
        }

        const hasDaemon = columns.has('daemon_state') && columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') && columns.has('runner_state_version')

        if (hasRunner && !hasDaemon) {
            return
        }

        if (!hasDaemon) {
            if (legacy) return
            throw new Error('SQLite schema missing daemon_state columns for v1 to v2 migration.')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state TO runner_state')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state_version TO runner_state_version')
            this.db.exec('COMMIT')
            return
        } catch (error) {
            this.db.exec('ROLLBACK')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec(`
                CREATE TABLE machines_new (
                    id TEXT PRIMARY KEY,
                    namespace TEXT NOT NULL DEFAULT 'default',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    metadata TEXT,
                    metadata_version INTEGER DEFAULT 1,
                    runner_state TEXT,
                    runner_state_version INTEGER DEFAULT 1,
                    active INTEGER DEFAULT 0,
                    active_at INTEGER,
                    seq INTEGER DEFAULT 0
                );
            `)
            this.db.exec(`
                INSERT INTO machines_new (
                    id, namespace, created_at, updated_at,
                    metadata, metadata_version,
                    runner_state, runner_state_version,
                    active, active_at, seq
                )
                SELECT id, namespace, created_at, updated_at,
                       metadata, metadata_version,
                       daemon_state, daemon_state_version,
                       active, active_at, seq
                FROM machines;
            `)
            this.db.exec('DROP TABLE machines')
            this.db.exec('ALTER TABLE machines_new RENAME TO machines')
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace)')
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`SQLite schema migration v1->v2 failed: ${message}`)
        }
    }

    private migrateFromV2ToV3(): void {
        return
    }

    private migrateFromV3ToV4(): void {
        const columns = this.getSessionColumnNames()
        // When the legacy branch invokes the full step ladder, an upstream-only
        // DB may not have the sessions table yet — createSchema runs after the
        // ladder.  Skip ALTERs in that case; createSchema will build the table
        // with the up-to-date columns.
        if (columns.size === 0) return
        if (!columns.has('team_state')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state TEXT')
        }
        if (!columns.has('team_state_updated_at')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state_updated_at INTEGER')
        }
    }

    private migrateFromV4ToV5(): void {
        const columns = this.getSessionColumnNames()
        if (columns.size === 0) return
        if (!columns.has('model')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN model TEXT')
        }
    }

    private migrateFromV5ToV6(): void {
        const columns = this.getSessionColumnNames()
        if (columns.size === 0) return
        if (!columns.has('effort')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN effort TEXT')
        }
    }

    private migrateFromV6ToV7(): void {
        const columns = this.getSessionColumnNames()
        if (columns.size === 0) return
        if (!columns.has('model_reasoning_effort')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN model_reasoning_effort TEXT')
        }
    }

    private migrateFromV7ToV8(): void {
        const columns = this.getMessageColumnNames()
        if (columns.size === 0) {
            // No messages table yet — createSchema will build the up-to-date one.
            return
        }
        if (!columns.has('invoked_at')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN invoked_at INTEGER')
        }
        // Idempotent (WHERE invoked_at IS NULL); safe to re-run if a previous attempt
        // crashed between ALTER and UPDATE before user_version was bumped.
        this.db.exec('UPDATE messages SET invoked_at = created_at WHERE invoked_at IS NULL')
        // Position index for byPosition pagination — idempotent via IF NOT EXISTS.
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_session_position
                ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC)
        `)
    }

    private migrateFromV8ToV9(): void {
        const columns = this.getMessageColumnNames()
        if (columns.size === 0) {
            // No messages table yet — createSchema will build the up-to-date one.
            return
        }
        if (!columns.has('scheduled_at')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN scheduled_at INTEGER')
        }
        // Partial index for efficient mature scheduled message lookup.
        // Idempotent via IF NOT EXISTS.
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_scheduled_pending
                ON messages(scheduled_at)
                WHERE scheduled_at IS NOT NULL AND invoked_at IS NULL
        `)
    }

    private migrateFromV9ToV10(): void {
        const columns = this.getSessionColumnNames()
        if (columns.size === 0) return
        if (!columns.has('service_tier')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN service_tier TEXT')
        }
    }

    private migrateFromV10ToV11(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS fcm_devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace TEXT NOT NULL,
                token TEXT NOT NULL,
                platform TEXT NOT NULL,
                device_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(namespace, device_id, platform)
            );
            CREATE INDEX IF NOT EXISTS idx_fcm_devices_namespace ON fcm_devices(namespace);
            CREATE INDEX IF NOT EXISTS idx_fcm_devices_token ON fcm_devices(token);
        `)
    }

    /**
     * tiann/hapi#893 (scratchlist v2): introduce the per-session
     * `session_scratchlist` typed table. Upstream main took V10→V11 for
     * `fcm_devices`; scratchlist is V11→V12.
     *
     * Idempotent via `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
     * EXISTS`. Cascade-delete from `sessions(id)` handles delete-session
     * cleanup. No data backfill: the web client's first-run migration
     * pushes any existing `localStorage` entries up via REST.
     *
     * Rollback: `DROP TABLE session_scratchlist; PRAGMA user_version = 11;`
     */
    private migrateFromV11ToV12(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_scratchlist (
                session_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, entry_id),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_scratchlist_session_created
                ON session_scratchlist(session_id, created_at DESC);
        `)
    }

    private migrateFromV12ToV13(): void {
        // Two development branches previously used schema v12 for different
        // tables. Reconcile both shapes before advancing the version.
        this.migrateFromV11ToV12()
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS message_epochs (
                session_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        `)
    }

    private migrateFromV13ToV14(): void {
        // Repair v13 databases produced before the divergent v12 migrations
        // were reconciled. Both underlying migrations are idempotent.
        this.migrateFromV12ToV13()
    }

    /**
     * tiann/hapi#921 (scratchlist v2.2): attachment metadata JSON column.
     * Bytes live on hub filesystem under HAPI_HOME/scratchlist-attachments/.
     * Upstream ladder: V11→V12 = session_scratchlist (#896); V12–V14 =
     * message_epochs reconciliation; this step is V14→V15 for attachments.
     *
     * Rollback: `ALTER TABLE session_scratchlist DROP COLUMN attachments` is
     * unsupported on older SQLite; rebuild DB or leave column unused.
     */
    private migrateFromV14ToV15(): void {
        const columns = this.db.prepare('PRAGMA table_info(session_scratchlist)').all() as Array<{ name: string }>
        if (!columns.some((col) => col.name === 'attachments')) {
            this.db.exec(`ALTER TABLE session_scratchlist ADD COLUMN attachments TEXT DEFAULT NULL`)
        }
    }

    /**
     * V16 has no DDL change: messages.content may now hold zstd-compressed
     * BLOBs alongside legacy plaintext JSON TEXT (see contentCodec.ts). The
     * version bump exists so an older hub build refuses to open the DB with a
     * schema-mismatch error instead of silently rendering every compressed
     * message as null.
     */
    private migrateFromV15ToV16(): void {}

    private migrateFromV16ToV17(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_events (
                session_id TEXT NOT NULL,
                source_key TEXT NOT NULL,
                source_seq INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                agent TEXT NOT NULL,
                model TEXT,
                kind TEXT NOT NULL CHECK (kind IN ('delta', 'cumulative')),
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (session_id, source_key),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_usage_events_session_created
                ON usage_events(session_id, created_at, source_seq);
            CREATE INDEX IF NOT EXISTS idx_usage_events_created
                ON usage_events(created_at);
        `)
    }

    private migrateFromV17ToV18(): void {
        // Usage events are a rebuildable index; v18 changes their source key
        // and baseline semantics, so stale rows must not be mixed with new ones.
        const columns = new Set(
            (this.db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>)
                .map((column) => column.name)
        )
        for (const name of [
            'last_input_tokens',
            'last_output_tokens',
            'last_cache_read_tokens',
            'last_cache_creation_tokens'
        ]) {
            if (!columns.has(name)) {
                this.db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} INTEGER`)
            }
        }
        this.db.exec('DELETE FROM usage_events')
    }

    private migrateFromV18ToV19(): void {
        // Cumulative event keys are stable in v19, so repeated transcript
        // imports collapse to one snapshot. Rebuild the derived index once.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_scan_state (
                session_id TEXT PRIMARY KEY,
                message_epoch INTEGER NOT NULL DEFAULT 0,
                last_seq INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            DELETE FROM usage_events;
            DELETE FROM usage_scan_state;
        `)
    }

    private migrateFromV19ToV20(): void {
        // tiann/hapi#1359 stamps a stable session-model fallback onto usage
        // events that predate model attribution. That only helps events
        // indexed after the upgrade, so clear the scan state once to force
        // usageService's lazy re-index to re-derive every event. The events
        // table is left alone: the re-index replaces each session's rows and
        // reuses any previously indexed explicit models.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_scan_state (
                session_id TEXT PRIMARY KEY,
                message_epoch INTEGER NOT NULL DEFAULT 0,
                last_seq INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            DELETE FROM usage_scan_state;
        `)
    }

    private getSessionColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getMachineColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getMessageColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getUserVersion(): number {
        const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
        return row?.user_version ?? 0
    }

    private setUserVersion(version: number): void {
        this.db.exec(`PRAGMA user_version = ${version}`)
    }

    private hasAnyUserTables(): boolean {
        const row = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
        ).get() as { name?: string } | undefined
        return Boolean(row?.name)
    }

    private assertRequiredTablesPresent(): void {
        const placeholders = REQUIRED_TABLES.map(() => '?').join(', ')
        const rows = this.db.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
        ).all(...REQUIRED_TABLES) as Array<{ name: string }>
        const existing = new Set(rows.map((row) => row.name))
        const missing = REQUIRED_TABLES.filter((table) => !existing.has(table))

        if (missing.length > 0) {
            throw new Error(
                `SQLite schema is missing required tables (${missing.join(', ')}). ` +
                'Back up and rebuild the database, or run an offline migration to the expected schema version.'
            )
        }
    }

    private buildSchemaMismatchError(currentVersion: number): Error {
        const location = (this._dbPath === ':memory:' || this._dbPath.startsWith('file::memory:'))
            ? 'in-memory database'
            : this._dbPath
        return new Error(
            `SQLite schema version mismatch for ${location}. ` +
            `Expected ${SCHEMA_VERSION}, found ${currentVersion}. ` +
            'This build does not run compatibility migrations. ' +
            'Back up and rebuild the database, or run an offline migration to the expected schema version.'
        )
    }
}
