import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

import { MachineStore } from './machineStore'
import { MessageStore } from './messageStore'
import { PushStore } from './pushStore'
import { SessionStore } from './sessionStore'
import { SessionNotificationStateStore } from './sessionNotificationState'
import { UserStore } from './userStore'
import { ManagedSessionStore } from './managedSessionStore'
import { DeliveryAttemptStore } from './deliveryAttemptStore'

export type {
    StoredMachine,
    StoredMessage,
    StoredPushSubscription,
    StoredSession,
    StoredSessionAlias,
    StoredDeliveryAttemptState,
    StoredUser,
    VersionedUpdateResult
} from './types'
export { MachineStore } from './machineStore'
export { MessageStore } from './messageStore'
export { PushStore } from './pushStore'
export { SessionStore } from './sessionStore'
export { SessionNotificationStateStore } from './sessionNotificationState'
export { UserStore } from './userStore'
export { ManagedSessionStore } from './managedSessionStore'
export { DeliveryAttemptStore } from './deliveryAttemptStore'

const SCHEMA_VERSION: number = 18
const REQUIRED_TABLES = [
    'sessions',
    'machines',
    'messages',
    'users',
    'push_subscriptions',
    'session_notification_state',
    'session_aliases',
    'managed_outcome_idempotency',
    'managed_resume_singleflight',
    'delivery_attempts'
] as const

export function assertDurableSQLiteMode(journalMode: string, synchronous: number, inMemory: boolean): void {
    if (!inMemory && journalMode.toLowerCase() !== 'wal') {
        throw new Error(`SQLite durability requires WAL mode, negotiated ${journalMode}`)
    }
    if (synchronous !== 2) {
        throw new Error(`SQLite durability requires synchronous=FULL, negotiated ${synchronous}`)
    }
}

export class Store {
    private db: Database
    private readonly dbPath: string

    readonly sessions: SessionStore
    readonly machines: MachineStore
    readonly messages: MessageStore
    readonly users: UserStore
    readonly push: PushStore
    readonly sessionNotifications: SessionNotificationStateStore
    readonly managedSessions: ManagedSessionStore
    readonly deliveryAttempts: DeliveryAttemptStore

    constructor(dbPath: string) {
        this.dbPath = dbPath
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

        const inMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:')
        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        // Delivery and managed-outcome acknowledgements are crash barriers: once
        // the client observes success it may delete its own durable outbox. FULL
        // is therefore required so a power loss cannot roll the acknowledged WAL
        // commit back behind an already-performed provider write.
        this.db.exec('PRAGMA synchronous = FULL')
        const journalMode = (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined)?.journal_mode ?? 'unknown'
        const synchronous = (this.db.prepare('PRAGMA synchronous').get() as { synchronous?: number } | undefined)?.synchronous ?? -1
        try {
            assertDurableSQLiteMode(journalMode, synchronous, inMemory)
        } catch (error) {
            this.db.close()
            throw error
        }
        this.db.exec('PRAGMA foreign_keys = ON')
        this.db.exec('PRAGMA busy_timeout = 5000')
        this.initSchema()

        if (!inMemory) {
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
        this.sessionNotifications = new SessionNotificationStateStore(this.db)
        this.managedSessions = new ManagedSessionStore(this.db)
        this.deliveryAttempts = new DeliveryAttemptStore(this.db)
    }

    mergeSessionIdentity(
        namespace: string,
        oldSessionId: string,
        newSessionId: string
    ): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return this.db.transaction(() => {
            this.managedSessions.addAliasInTransaction(namespace, oldSessionId, newSessionId)
            return this.messages.mergeSessionMessagesInTransaction(oldSessionId, newSessionId)
        })()
    }

    private initSchema(): void {
        const currentVersion = this.getUserVersion()
        if (currentVersion === 0) {
            if (this.hasAnyUserTables()) {
                this.migrateLegacySchemaIfNeeded()
                this.prepareLegacySchemaForCreate()
                this.createSchema()
                this.migrateLegacySchemaToCurrent()
                this.setUserVersion(SCHEMA_VERSION)
                this.assertRequiredTablesPresent()
                this.assertCredentialBoundUserSchema()
                return
            }

            this.createSchema()
            this.setUserVersion(SCHEMA_VERSION)
            this.assertCredentialBoundUserSchema()
            return
        }

        if (currentVersion > 0 && currentVersion < SCHEMA_VERSION) {
            this.migrateToCurrentVersion(currentVersion)
            this.setUserVersion(SCHEMA_VERSION)
            this.assertRequiredTablesPresent()
            this.assertCredentialBoundUserSchema()
            return
        }

        if (currentVersion !== SCHEMA_VERSION) {
            throw this.buildSchemaMismatchError(currentVersion)
        }

        this.assertRequiredTablesPresent()
        this.assertCredentialBoundUserSchema()
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
                service_tier TEXT,
                effort TEXT,
                permission_mode TEXT,
                todos TEXT,
                todos_updated_at INTEGER,
                team_state TEXT,
                team_state_updated_at INTEGER,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                activity_event_at INTEGER,
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
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                platform_user_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                credential_fingerprint TEXT NOT NULL,
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

            CREATE TABLE IF NOT EXISTS session_notification_state (
                namespace TEXT NOT NULL,
                session_id TEXT NOT NULL,
                unread_count INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, session_id),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_notification_state_namespace
                ON session_notification_state(namespace, unread_count);

            CREATE TABLE IF NOT EXISTS session_aliases (
                namespace TEXT NOT NULL,
                alias_id TEXT NOT NULL,
                canonical_session_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, alias_id),
                FOREIGN KEY (canonical_session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS managed_outcome_idempotency (
                namespace TEXT NOT NULL,
                machine_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                response_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, machine_id, idempotency_key)
            );
            CREATE TABLE IF NOT EXISTS managed_resume_singleflight (
                namespace TEXT NOT NULL,
                canonical_session_id TEXT NOT NULL,
                owner_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                result_session_id TEXT,
                spawn_request_id TEXT,
                spawn_operation_json TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, canonical_session_id)
            );
            CREATE TABLE IF NOT EXISTS delivery_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace TEXT NOT NULL,
                canonical_session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                launch_nonce TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                idempotency_key TEXT NOT NULL,
                UNIQUE(namespace, canonical_session_id, message_id, attempt_id, state)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempts_idempotency
                ON delivery_attempts(namespace, idempotency_key);
        `)
    }

    private migrateToCurrentVersion(currentVersion: number): void {
        let version = currentVersion
        if (version === 1) {
            this.migrateFromV1ToV2()
            version = 2
        }
        if (version === 2) {
            this.migrateFromV2ToV3()
            version = 3
        }
        if (version === 3) {
            this.migrateFromV3ToV4()
            version = 4
        }
        if (version === 4) {
            this.migrateFromV4ToV5()
            version = 5
        }
        if (version === 5) {
            this.migrateFromV5ToV6()
            version = 6
        }
        if (version === 6) {
            this.migrateFromV6ToV7()
            version = 7
        }
        if (version === 7) {
            this.migrateFromV7ToV8()
            version = 8
        }
        if (version === 8) {
            this.migrateFromV8ToV9()
            version = 9
        }
        if (version === 9) {
            this.migrateFromV9ToV10()
            version = 10
        }
        if (version === 10) {
            this.migrateFromV10ToV11()
            version = 11
        }
        if (version === 11) {
            this.migrateFromV11ToV12()
            version = 12
        }
        if (version === 12) {
            this.migrateFromV12ToV13()
            version = 13
        }
        if (version === 13) {
            this.migrateFromV13ToV14()
            version = 14
        }
        if (version === 14) {
            this.migrateFromV14ToV15()
            version = 15
        }
        if (version === 15) {
            this.migrateFromV15ToV16()
            version = 16
        }
        if (version === 16) {
            this.migrateFromV16ToV17()
            version = 17
        }
        if (version === 17) {
            this.migrateFromV17ToV18()
            version = 18
        }
        if (version !== SCHEMA_VERSION) {
            throw this.buildSchemaMismatchError(currentVersion)
        }
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

    private migrateLegacySchemaToCurrent(): void {
        this.migrateFromV3ToV4()
        this.migrateFromV4ToV5()
        this.migrateFromV5ToV6()
        this.migrateFromV6ToV7()
        this.migrateFromV7ToV8()
        this.migrateFromV8ToV9()
        this.migrateFromV9ToV10()
        this.migrateFromV10ToV11()
        this.migrateFromV11ToV12()
        this.migrateFromV12ToV13()
        this.migrateFromV13ToV14()
        this.migrateFromV14ToV15()
        this.migrateFromV15ToV16()
        this.migrateFromV16ToV17()
        this.migrateFromV17ToV18()
    }

    private prepareLegacySchemaForCreate(): void {
        const deliveryAttemptsExists = Boolean(this.db.prepare(`
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'delivery_attempts'
        `).get())
        if (!deliveryAttemptsExists) return

        const columns = new Set((this.db.prepare('PRAGMA table_info(delivery_attempts)').all() as Array<{ name: string }>).map((row) => row.name))
        if (!columns.has('idempotency_key')) {
            this.db.exec('ALTER TABLE delivery_attempts ADD COLUMN idempotency_key TEXT')
        }
    }

    private migrateFromV1ToV2(): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            throw new Error('SQLite schema missing machines table for v1 to v2 migration.')
        }

        const hasDaemon = columns.has('daemon_state') && columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') && columns.has('runner_state_version')

        if (hasRunner && !hasDaemon) {
            return
        }

        if (!hasDaemon) {
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
        if (!columns.has('team_state')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state TEXT')
        }
        if (!columns.has('team_state_updated_at')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state_updated_at INTEGER')
        }
    }

    private migrateFromV4ToV5(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('model')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN model TEXT')
        }
    }

    private migrateFromV5ToV6(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('effort')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN effort TEXT')
        }
    }

    private migrateFromV6ToV7(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('model_reasoning_effort')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN model_reasoning_effort TEXT')
        }
    }

    private migrateFromV7ToV8(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_notification_state (
                namespace TEXT NOT NULL,
                session_id TEXT NOT NULL,
                unread_count INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, session_id),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_notification_state_namespace
                ON session_notification_state(namespace, unread_count);
        `)
    }

    private migrateFromV8ToV9(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('service_tier')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN service_tier TEXT')
        }
    }

    private migrateFromV9ToV10(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('permission_mode')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN permission_mode TEXT')
        }
    }

    private migrateFromV10ToV11(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_aliases (
                namespace TEXT NOT NULL, alias_id TEXT NOT NULL, canonical_session_id TEXT NOT NULL,
                created_at INTEGER NOT NULL, PRIMARY KEY(namespace, alias_id),
                FOREIGN KEY (canonical_session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS managed_outcome_idempotency (
                namespace TEXT NOT NULL, machine_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, machine_id, idempotency_key)
            );
            CREATE TABLE IF NOT EXISTS managed_resume_singleflight (
                namespace TEXT NOT NULL, canonical_session_id TEXT NOT NULL, owner_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL, status TEXT NOT NULL, result_session_id TEXT, updated_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, canonical_session_id)
            );
        `)
    }

    private migrateFromV11ToV12(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS delivery_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL,
                canonical_session_id TEXT NOT NULL, message_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL, launch_nonce TEXT NOT NULL, sequence INTEGER NOT NULL,
                state TEXT NOT NULL, created_at INTEGER NOT NULL,
                UNIQUE(namespace, canonical_session_id, message_id, attempt_id, state)
            );
        `)
    }

    private migrateFromV12ToV13(): void {
        try {
            this.db.exec('BEGIN IMMEDIATE')
            const columns = new Set((this.db.prepare('PRAGMA table_info(delivery_attempts)').all() as Array<{ name: string }>).map((row) => row.name))
            if (!columns.has('idempotency_key')) {
                this.db.exec('ALTER TABLE delivery_attempts ADD COLUMN idempotency_key TEXT')
            }
            this.db.exec(`
                UPDATE delivery_attempts
                SET idempotency_key = attempt_id || ':' || message_id || ':' || state || ':migrated:' || id
                WHERE idempotency_key IS NULL;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempts_idempotency
                    ON delivery_attempts(namespace, idempotency_key);
                PRAGMA user_version = 13;
                COMMIT;
            `)
        } catch (error) {
            try { this.db.exec('ROLLBACK') } catch {}
            throw error
        }
    }

    private migrateFromV13ToV14(): void {
        const columns = new Set((this.db.prepare('PRAGMA table_info(managed_resume_singleflight)').all() as Array<{ name: string }>).map((row) => row.name))
        if (!columns.has('spawn_request_id')) {
            this.db.exec('ALTER TABLE managed_resume_singleflight ADD COLUMN spawn_request_id TEXT')
        }
    }

    private migrateFromV14ToV15(): void {
        // Activity persistence was briefly deployed as schema v14 on the
        // production lineage before the security migrations were integrated.
        // Feature-detect the candidate v14 column so either v14 lineage can
        // converge safely on the same v18 schema.
        const columns = new Set((this.db.prepare('PRAGMA table_info(managed_resume_singleflight)').all() as Array<{ name: string }>).map((row) => row.name))
        if (!columns.has('spawn_request_id')) {
            this.db.exec('ALTER TABLE managed_resume_singleflight ADD COLUMN spawn_request_id TEXT')
        }
        // v13 never persisted the Runner request ID. Reusing an expired
        // in-flight row after adding the nullable v14 column would mint a new
        // ID even though the old child may exist. Quarantine that unknowable
        // state until an old owner completes it or an operator reconciles it.
        this.db.exec(`
            UPDATE managed_resume_singleflight
            SET status = 'legacy_ambiguous'
            WHERE status = 'running' AND spawn_request_id IS NULL
        `)
    }

    private migrateFromV15ToV16(): void {
        // Suffix-era Telegram rows cannot prove which credential authorized
        // their namespace. Rebuild the table without copying any binding so
        // every account must bind again with a currently configured opaque
        // credential. The new non-null fingerprint lets auth and bot paths
        // invalidate a binding after credential rotation or removal.
        try {
            this.db.exec('BEGIN IMMEDIATE')
            this.db.exec(`
                DROP TABLE IF EXISTS users_v16;
                CREATE TABLE users_v16 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    platform_user_id TEXT NOT NULL,
                    namespace TEXT NOT NULL DEFAULT 'default',
                    credential_fingerprint TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(platform, platform_user_id)
                );
                DROP TABLE users;
                ALTER TABLE users_v16 RENAME TO users;
                CREATE INDEX idx_users_platform ON users(platform);
                CREATE INDEX idx_users_platform_namespace ON users(platform, namespace);
                PRAGMA user_version = 16;
                COMMIT;
            `)
        } catch (error) {
            try { this.db.exec('ROLLBACK') } catch {}
            throw error
        }
    }

    private migrateFromV16ToV17(): void {
        try {
            this.db.exec('BEGIN IMMEDIATE')
            const columns = new Set((this.db.prepare('PRAGMA table_info(managed_resume_singleflight)').all() as Array<{ name: string }>).map((row) => row.name))
            if (!columns.has('spawn_operation_json')) {
                this.db.exec('ALTER TABLE managed_resume_singleflight ADD COLUMN spawn_operation_json TEXT')
            }
            // v16 retained only a UUID. The target Runner and fingerprint inputs
            // are unknowable after restart, so an in-flight row cannot be safely
            // queried or replayed and must remain quarantined.
            this.db.exec(`
                UPDATE managed_resume_singleflight
                SET status = 'legacy_ambiguous'
                WHERE status = 'running' AND spawn_operation_json IS NULL;
                PRAGMA user_version = 17;
                COMMIT;
            `)
        } catch (error) {
            try { this.db.exec('ROLLBACK') } catch {}
            throw error
        }
    }

    private migrateFromV17ToV18(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('activity_event_at')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN activity_event_at INTEGER')
        }
    }

    private assertCredentialBoundUserSchema(): void {
        const columns = this.db.prepare('PRAGMA table_info(users)').all() as Array<{
            name: string
            notnull: number
        }>
        const fingerprint = columns.find((column) => column.name === 'credential_fingerprint')
        if (!fingerprint || fingerprint.notnull !== 1) {
            throw new Error('SQLite users table is missing the required credential_fingerprint authorization column.')
        }
    }

    private getSessionColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getMachineColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
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
        const location = (this.dbPath === ':memory:' || this.dbPath.startsWith('file::memory:'))
            ? 'in-memory database'
            : this.dbPath
        return new Error(
            `SQLite schema version mismatch for ${location}. ` +
            `Expected ${SCHEMA_VERSION}, found ${currentVersion}. ` +
            'This build does not run compatibility migrations. ' +
            'Back up and rebuild the database, or run an offline migration to the expected schema version.'
        )
    }
}
