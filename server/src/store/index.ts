import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type StoredSession = {
    id: string
    tag: string | null
    machineId: string | null
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    agentState: unknown | null
    agentStateVersion: number
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredMachine = {
    id: string
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

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }

type DbSessionRow = {
    id: string
    tag: string | null
    machine_id: string | null
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    agent_state: string | null
    agent_state_version: number
    active: number
    active_at: number | null
    seq: number
}

type DbMachineRow = {
    id: string
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
        machineId: row.machine_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        agentState: safeJsonParse(row.agent_state),
        agentStateVersion: row.agent_state_version,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq
    }
}

function toStoredMachine(row: DbMachineRow): StoredMachine {
    return {
        id: row.id,
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
                machine_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                agent_state TEXT,
                agent_state_version INTEGER DEFAULT 1,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);

            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
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
        `)
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown): StoredSession {
        const existing = this.db.prepare(
            'SELECT * FROM sessions WHERE tag = ? ORDER BY created_at DESC LIMIT 1'
        ).get(tag) as DbSessionRow | undefined

        if (existing) {
            return toStoredSession(existing)
        }

        const now = Date.now()
        const id = randomUUID()

        const metadataJson = JSON.stringify(metadata)
        const agentStateJson = agentState === null || agentState === undefined ? null : JSON.stringify(agentState)

        this.db.prepare(`
            INSERT INTO sessions (
                id, tag, machine_id, created_at, updated_at,
                metadata, metadata_version,
                agent_state, agent_state_version,
                active, active_at, seq
            ) VALUES (
                @id, @tag, NULL, @created_at, @updated_at,
                @metadata, 1,
                @agent_state, 1,
                0, NULL, 0
            )
        `).run({
            id,
            tag,
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

    updateSessionMetadata(id: string, metadata: unknown, expectedVersion: number): VersionedUpdateResult<unknown | null> {
        try {
            const now = Date.now()
            const json = JSON.stringify(metadata)
            const result = this.db.prepare(`
                UPDATE sessions
                SET metadata = @metadata,
                    metadata_version = metadata_version + 1,
                    updated_at = @updated_at,
                    seq = seq + 1
                WHERE id = @id AND metadata_version = @expectedVersion
            `).run({ id, metadata: json, updated_at: now, expectedVersion })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: metadata }
            }

            const current = this.db.prepare('SELECT metadata, metadata_version FROM sessions WHERE id = ?').get(id) as
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

    updateSessionAgentState(id: string, agentState: unknown, expectedVersion: number): VersionedUpdateResult<unknown | null> {
        try {
            const now = Date.now()
            const json = agentState === null || agentState === undefined ? null : JSON.stringify(agentState)
            const result = this.db.prepare(`
                UPDATE sessions
                SET agent_state = @agent_state,
                    agent_state_version = agent_state_version + 1,
                    updated_at = @updated_at,
                    seq = seq + 1
                WHERE id = @id AND agent_state_version = @expectedVersion
            `).run({ id, agent_state: json, updated_at: now, expectedVersion })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: agentState === undefined ? null : agentState }
            }

            const current = this.db.prepare('SELECT agent_state, agent_state_version FROM sessions WHERE id = ?').get(id) as
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

    getSession(id: string): StoredSession | null {
        const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSessionRow | undefined
        return row ? toStoredSession(row) : null
    }

    getSessions(): StoredSession[] {
        const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as DbSessionRow[]
        return rows.map(toStoredSession)
    }

    getOrCreateMachine(id: string, metadata: unknown, daemonState: unknown): StoredMachine {
        const existing = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow | undefined
        if (existing) {
            return toStoredMachine(existing)
        }

        const now = Date.now()
        const metadataJson = JSON.stringify(metadata)
        const daemonStateJson = daemonState === null || daemonState === undefined ? null : JSON.stringify(daemonState)

        this.db.prepare(`
            INSERT INTO machines (
                id, created_at, updated_at,
                metadata, metadata_version,
                daemon_state, daemon_state_version,
                active, active_at, seq
            ) VALUES (
                @id, @created_at, @updated_at,
                @metadata, 1,
                @daemon_state, 1,
                0, NULL, 0
            )
        `).run({
            id,
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

    updateMachineMetadata(id: string, metadata: unknown, expectedVersion: number): VersionedUpdateResult<unknown | null> {
        try {
            const now = Date.now()
            const json = JSON.stringify(metadata)
            const result = this.db.prepare(`
                UPDATE machines
                SET metadata = @metadata,
                    metadata_version = metadata_version + 1,
                    updated_at = @updated_at,
                    seq = seq + 1
                WHERE id = @id AND metadata_version = @expectedVersion
            `).run({ id, metadata: json, updated_at: now, expectedVersion })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: metadata }
            }

            const current = this.db.prepare('SELECT metadata, metadata_version FROM machines WHERE id = ?').get(id) as
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

    updateMachineDaemonState(id: string, daemonState: unknown, expectedVersion: number): VersionedUpdateResult<unknown | null> {
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
                WHERE id = @id AND daemon_state_version = @expectedVersion
            `).run({ id, daemon_state: json, updated_at: now, active_at: now, expectedVersion })

            if (result.changes === 1) {
                return { result: 'success', version: expectedVersion + 1, value: daemonState === undefined ? null : daemonState }
            }

            const current = this.db.prepare('SELECT daemon_state, daemon_state_version FROM machines WHERE id = ?').get(id) as
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

    getMachines(): StoredMachine[] {
        const rows = this.db.prepare('SELECT * FROM machines ORDER BY updated_at DESC').all() as DbMachineRow[]
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
}
