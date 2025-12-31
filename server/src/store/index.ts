import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type StoredSession = {
    id: string
    tag: string | null
    namespace: string
    machineId: string | null
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    agentState: unknown | null
    agentStateVersion: number
    todos: unknown | null
    todosUpdatedAt: number | null
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredMachine = {
    id: string
    namespace: string
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    daemonState: unknown | null
    daemonStateVersion: number
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredMessage = {
    id: string
    sessionId: string
    content: unknown
    createdAt: number
    seq: number
    localId: string | null
}

export type StoredUser = {
    id: number
    platform: string
    platformUserId: string
    namespace: string
    createdAt: number
}

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }

type DbSessionRow = {
    id: string
    tag: string | null
    namespace: string
    machine_id: string | null
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    agent_state: string | null
    agent_state_version: number
    todos: string | null
    todos_updated_at: number | null
    active: number
    active_at: number | null
    seq: number
}

type DbMachineRow = {
    id: string
    namespace: string
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    daemon_state: string | null
    daemon_state_version: number
    active: number
    active_at: number | null
    seq: number
}

type DbMessageRow = {
    id: string
    session_id: string
    content: string
    created_at: number
    seq: number
    local_id: string | null
}

type DbUserRow = {
    id: number
    platform: string
    platform_user_id: string
    namespace: string
    created_at: number
}

function safeJsonParse(value: string | null): unknown | null {
    if (value === null) return null
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

function toStoredSession(row: DbSessionRow): StoredSession {
    return {
        id: row.id,
        tag: row.tag,
        namespace: row.namespace,
        machineId: row.machine_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        agentState: safeJsonParse(row.agent_state),
        agentStateVersion: row.agent_state_version,
        todos: safeJsonParse(row.todos),
        todosUpdatedAt: row.todos_updated_at,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq
    }
}

function toStoredMachine(row: DbMachineRow): StoredMachine {
    return {
        id: row.id,
        namespace: row.namespace,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        daemonState: safeJsonParse(row.daemon_state),
        daemonStateVersion: row.daemon_state_version,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq
    }
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: safeJsonParse(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id
    }
}

function toStoredUser(row: DbUserRow): StoredUser {
    return {
        id: row.id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        namespace: row.namespace,
        createdAt: row.created_at
    }
}

export class Store {
    private db: Database

    constructor(dbPath: string) {
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
    }

    private initSchema(): void {
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
                todos TEXT,
                todos_updated_at INTEGER,
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
                daemon_state TEXT,
                daemon_state_version INTEGER DEFAULT 1,
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
                created_at INTEGER NOT NULL,
                UNIQUE(platform, platform_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
            CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);
        `)

        const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        const sessionColumnNames = new Set(sessionColumns.map((c) => c.name))

        if (!sessionColumnNames.has('namespace')) {
            this.db.exec("ALTER TABLE sessions ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'")
        }
        if (!sessionColumnNames.has('todos')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN todos TEXT')
        }
        if (!sessionColumnNames.has('todos_updated_at')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN todos_updated_at INTEGER')
        }

        const machineColumns = this.db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
        const machineColumnNames = new Set(machineColumns.map((c) => c.name))
        if (!machineColumnNames.has('namespace')) {
            this.db.exec("ALTER TABLE machines ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'")
        }

        const userColumns = this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
        const userColumnNames = new Set(userColumns.map((c) => c.name))
        if (!userColumnNames.has('namespace')) {
            this.db.exec("ALTER TABLE users ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'")
        }
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): StoredSession {
        const existing = this.db.prepare(
            'SELECT * FROM sessions WHERE tag = ? AND namespace = ? ORDER BY created_at DESC LIMIT 1'
        ).get(tag, namespace) as DbSessionRow | undefined

        if (existing) {
            return toStoredSession(existing)
        }

        const now = Date.now()
        const id = randomUUID()

        const metadataJson = JSON.stringify(metadata)
        const agentStateJson = agentState === null || agentState === undefined ? null : JSON.stringify(agentState)

        this.db.prepare(`
            INSERT INTO sessions (
                id, tag, namespace, machine_id, created_at, updated_at,
                metadata, metadata_version,
                agent_state, agent_state_version,
                todos, todos_updated_at,
                active, active_at, seq
            ) VALUES (
                @id, @tag, @namespace, NULL, @created_at, @updated_at,
                @metadata, 1,
                @agent_state, 1,
                NULL, NULL,
                0, NULL, 0
            )
        `).run({
            id,
            tag,
            namespace,
            created_at: now,
            updated_at: now,
            metadata: metadataJson,
            agent_state: agentStateJson
        })

        const row = this.getSession(id)
        if (!row) {
            throw new Error('Failed to create session')
        }
        return row
    }

    updateSessionMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string
    ): VersionedUpdateResult<unknown | null> {
        try {
            const now = Date.now()
            const json = JSON.stringify(metadata)
            const result = this.db.prepare(`
                UPDATE sessions
                SET metadata = @metadata,
                    metadata_version = metadata_version + 1,
                    updated_at = @updated_at,
                    seq = seq + 1
                WHERE id = @id AND namespace = @namespace AND metadata_version = @expectedVersion
            `).run({ id, metadata: json, updated_at: now, expectedVersion, namespace })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: metadata }
            }

            const current = this.db.prepare(
                'SELECT metadata, metadata_version FROM sessions WHERE id = ? AND namespace = ?'
            ).get(id, namespace) as
                | { metadata: string | null; metadata_version: number }
                | undefined
            if (!current) {
                return { result: 'error' }
            }
            return {
                result: 'version-mismatch',
                version: current.metadata_version,
                value: safeJsonParse(current.metadata)
            }
        } catch {
            return { result: 'error' }
        }
    }

    updateSessionAgentState(
        id: string,
        agentState: unknown,
        expectedVersion: number,
        namespace: string
    ): VersionedUpdateResult<unknown | null> {
        try {
            const now = Date.now()
            const json = agentState === null || agentState === undefined ? null : JSON.stringify(agentState)
            const result = this.db.prepare(`
                UPDATE sessions
                SET agent_state = @agent_state,
                    agent_state_version = agent_state_version + 1,
                    updated_at = @updated_at,
                    seq = seq + 1
                WHERE id = @id AND namespace = @namespace AND agent_state_version = @expectedVersion
            `).run({ id, agent_state: json, updated_at: now, expectedVersion, namespace })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: agentState === undefined ? null : agentState }
            }

            const current = this.db.prepare(
                'SELECT agent_state, agent_state_version FROM sessions WHERE id = ? AND namespace = ?'
            ).get(id, namespace) as
                | { agent_state: string | null; agent_state_version: number }
                | undefined
            if (!current) {
                return { result: 'error' }
            }
            return {
                result: 'version-mismatch',
                version: current.agent_state_version,
                value: safeJsonParse(current.agent_state)
            }
        } catch {
            return { result: 'error' }
        }
    }

    setSessionTodos(id: string, todos: unknown, todosUpdatedAt: number, namespace: string): boolean {
        try {
            const json = todos === null || todos === undefined ? null : JSON.stringify(todos)
            const result = this.db.prepare(`
                UPDATE sessions
                SET todos = @todos,
                    todos_updated_at = @todos_updated_at,
                    updated_at = CASE WHEN updated_at > @updated_at THEN updated_at ELSE @updated_at END,
                    seq = seq + 1
                WHERE id = @id
                  AND namespace = @namespace
                  AND (todos_updated_at IS NULL OR todos_updated_at < @todos_updated_at)
            `).run({
                id,
                todos: json,
                todos_updated_at: todosUpdatedAt,
                updated_at: todosUpdatedAt,
                namespace
            })

            return result.changes === 1
        } catch {
            return false
        }
    }

    getSession(id: string): StoredSession | null {
        const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSessionRow | undefined
        return row ? toStoredSession(row) : null
    }

    getSessionByNamespace(id: string, namespace: string): StoredSession | null {
        const row = this.db.prepare(
            'SELECT * FROM sessions WHERE id = ? AND namespace = ?'
        ).get(id, namespace) as DbSessionRow | undefined
        return row ? toStoredSession(row) : null
    }

    getSessions(): StoredSession[] {
        const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as DbSessionRow[]
        return rows.map(toStoredSession)
    }

    getSessionsByNamespace(namespace: string): StoredSession[] {
        const rows = this.db.prepare(
            'SELECT * FROM sessions WHERE namespace = ? ORDER BY updated_at DESC'
        ).all(namespace) as DbSessionRow[]
        return rows.map(toStoredSession)
    }

    getOrCreateMachine(id: string, metadata: unknown, daemonState: unknown, namespace: string): StoredMachine {
        const existing = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow | undefined
        if (existing) {
            const stored = toStoredMachine(existing)
            if (stored.namespace !== namespace) {
                throw new Error('Machine namespace mismatch')
            }
            return stored
        }

        const now = Date.now()
        const metadataJson = JSON.stringify(metadata)
        const daemonStateJson = daemonState === null || daemonState === undefined ? null : JSON.stringify(daemonState)

        this.db.prepare(`
            INSERT INTO machines (
                id, namespace, created_at, updated_at,
                metadata, metadata_version,
                daemon_state, daemon_state_version,
                active, active_at, seq
            ) VALUES (
                @id, @namespace, @created_at, @updated_at,
                @metadata, 1,
                @daemon_state, 1,
                0, NULL, 0
            )
        `).run({
            id,
            namespace,
            created_at: now,
            updated_at: now,
            metadata: metadataJson,
            daemon_state: daemonStateJson
        })

        const row = this.getMachine(id)
        if (!row) {
            throw new Error('Failed to create machine')
        }
        return row
    }

    updateMachineMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string
    ): VersionedUpdateResult<unknown | null> {
        try {
            const now = Date.now()
            const json = JSON.stringify(metadata)
            const result = this.db.prepare(`
                UPDATE machines
                SET metadata = @metadata,
                    metadata_version = metadata_version + 1,
                    updated_at = @updated_at,
                    seq = seq + 1
                WHERE id = @id AND namespace = @namespace AND metadata_version = @expectedVersion
            `).run({ id, metadata: json, updated_at: now, expectedVersion, namespace })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: metadata }
            }

            const current = this.db.prepare(
                'SELECT metadata, metadata_version FROM machines WHERE id = ? AND namespace = ?'
            ).get(id, namespace) as
                | { metadata: string | null; metadata_version: number }
                | undefined
            if (!current) {
                return { result: 'error' }
            }
            return {
                result: 'version-mismatch',
                version: current.metadata_version,
                value: safeJsonParse(current.metadata)
            }
        } catch {
            return { result: 'error' }
        }
    }

    updateMachineDaemonState(
        id: string,
        daemonState: unknown,
        expectedVersion: number,
        namespace: string
    ): VersionedUpdateResult<unknown | null> {
        try {
            const now = Date.now()
            const json = daemonState === null || daemonState === undefined ? null : JSON.stringify(daemonState)
            const result = this.db.prepare(`
                UPDATE machines
                SET daemon_state = @daemon_state,
                    daemon_state_version = daemon_state_version + 1,
                    updated_at = @updated_at,
                    active = 1,
                    active_at = @active_at,
                    seq = seq + 1
                WHERE id = @id AND namespace = @namespace AND daemon_state_version = @expectedVersion
            `).run({ id, daemon_state: json, updated_at: now, active_at: now, expectedVersion, namespace })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: daemonState === undefined ? null : daemonState }
            }

            const current = this.db.prepare(
                'SELECT daemon_state, daemon_state_version FROM machines WHERE id = ? AND namespace = ?'
            ).get(id, namespace) as
                | { daemon_state: string | null; daemon_state_version: number }
                | undefined
            if (!current) {
                return { result: 'error' }
            }
            return {
                result: 'version-mismatch',
                version: current.daemon_state_version,
                value: safeJsonParse(current.daemon_state)
            }
        } catch {
            return { result: 'error' }
        }
    }

    getMachine(id: string): StoredMachine | null {
        const row = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow | undefined
        return row ? toStoredMachine(row) : null
    }

    getMachineByNamespace(id: string, namespace: string): StoredMachine | null {
        const row = this.db.prepare(
            'SELECT * FROM machines WHERE id = ? AND namespace = ?'
        ).get(id, namespace) as DbMachineRow | undefined
        return row ? toStoredMachine(row) : null
    }

    getMachines(): StoredMachine[] {
        const rows = this.db.prepare('SELECT * FROM machines ORDER BY updated_at DESC').all() as DbMachineRow[]
        return rows.map(toStoredMachine)
    }

    getMachinesByNamespace(namespace: string): StoredMachine[] {
        const rows = this.db.prepare(
            'SELECT * FROM machines WHERE namespace = ? ORDER BY updated_at DESC'
        ).all(namespace) as DbMachineRow[]
        return rows.map(toStoredMachine)
    }

    addMessage(sessionId: string, content: unknown, localId?: string): StoredMessage {
        const now = Date.now()

        if (localId) {
            const existing = this.db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
            ).get(sessionId, localId) as DbMessageRow | undefined
            if (existing) {
                return toStoredMessage(existing)
            }
        }

        const msgSeqRow = this.db.prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
        ).get(sessionId) as { nextSeq: number }
        const msgSeq = msgSeqRow.nextSeq

        const id = randomUUID()
        const json = JSON.stringify(content)

        this.db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id
            )
        `).run({
            id,
            session_id: sessionId,
            content: json,
            created_at: now,
            seq: msgSeq,
            local_id: localId ?? null
        })

        const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) {
            throw new Error('Failed to create message')
        }
        return toStoredMessage(row)
    }

    getMessages(sessionId: string, limit: number = 200, beforeSeq?: number): StoredMessage[] {
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

        const rows = (beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(beforeSeq))
            ? this.db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
            ).all(sessionId, beforeSeq, safeLimit) as DbMessageRow[]
            : this.db.prepare(
                'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
            ).all(sessionId, safeLimit) as DbMessageRow[]

        return rows.reverse().map(toStoredMessage)
    }

    getMessagesAfter(sessionId: string, afterSeq: number, limit: number = 200): StoredMessage[] {
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
        const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

        const rows = this.db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
        ).all(sessionId, safeAfterSeq, safeLimit) as DbMessageRow[]

        return rows.map(toStoredMessage)
    }

    getUser(platform: string, platformUserId: string): StoredUser | null {
        const row = this.db.prepare(
            'SELECT * FROM users WHERE platform = ? AND platform_user_id = ? LIMIT 1'
        ).get(platform, platformUserId) as DbUserRow | undefined
        return row ? toStoredUser(row) : null
    }

    getUsersByPlatform(platform: string): StoredUser[] {
        const rows = this.db.prepare(
            'SELECT * FROM users WHERE platform = ? ORDER BY created_at ASC'
        ).all(platform) as DbUserRow[]
        return rows.map(toStoredUser)
    }

    getUsersByPlatformAndNamespace(platform: string, namespace: string): StoredUser[] {
        const rows = this.db.prepare(
            'SELECT * FROM users WHERE platform = ? AND namespace = ? ORDER BY created_at ASC'
        ).all(platform, namespace) as DbUserRow[]
        return rows.map(toStoredUser)
    }

    addUser(platform: string, platformUserId: string, namespace: string): StoredUser {
        const now = Date.now()
        this.db.prepare(`
            INSERT OR IGNORE INTO users (
                platform, platform_user_id, namespace, created_at
            ) VALUES (
                @platform, @platform_user_id, @namespace, @created_at
            )
        `).run({
            platform,
            platform_user_id: platformUserId,
            namespace,
            created_at: now
        })

        const row = this.getUser(platform, platformUserId)
        if (!row) {
            throw new Error('Failed to create user')
        }
        return row
    }

    removeUser(platform: string, platformUserId: string): boolean {
        const result = this.db.prepare(
            'DELETE FROM users WHERE platform = ? AND platform_user_id = ?'
        ).run(platform, platformUserId)
        return result.changes > 0
    }
}
