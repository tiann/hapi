import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function createV8Database(dbPath: string): void {
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
    db.exec(`
        CREATE TABLE sessions (
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
            todos TEXT,
            todos_updated_at INTEGER,
            team_state TEXT,
            team_state_updated_at INTEGER,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE TABLE machines (
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
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT
        );
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE session_notification_state (
            namespace TEXT NOT NULL,
            session_id TEXT NOT NULL,
            unread_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(namespace, session_id)
        );
        PRAGMA user_version = 8;
    `)
    db.close()
}

function upgradeFixtureToV12(dbPath: string): void {
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
    db.exec(`
        ALTER TABLE sessions ADD COLUMN service_tier TEXT;
        ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
        CREATE TABLE session_aliases (
            namespace TEXT NOT NULL, alias_id TEXT NOT NULL, canonical_session_id TEXT NOT NULL,
            created_at INTEGER NOT NULL, PRIMARY KEY(namespace, alias_id)
        );
        CREATE TABLE managed_outcome_idempotency (
            namespace TEXT NOT NULL, machine_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(namespace, machine_id, idempotency_key)
        );
        CREATE TABLE managed_resume_singleflight (
            namespace TEXT NOT NULL, canonical_session_id TEXT NOT NULL, owner_token TEXT NOT NULL,
            expires_at INTEGER NOT NULL, status TEXT NOT NULL, result_session_id TEXT, updated_at INTEGER NOT NULL,
            PRIMARY KEY(namespace, canonical_session_id)
        );
        CREATE TABLE delivery_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL,
            canonical_session_id TEXT NOT NULL, message_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL, launch_nonce TEXT NOT NULL, sequence INTEGER NOT NULL,
            state TEXT NOT NULL, created_at INTEGER NOT NULL,
            UNIQUE(namespace, canonical_session_id, message_id, attempt_id, state)
        );
        INSERT INTO delivery_attempts(namespace, canonical_session_id, message_id, attempt_id, launch_nonce, sequence, state, created_at)
        VALUES ('default', 'session-1', 'message-1', 'attempt-1', 'launch-1', 1, 'prepared', 1);
        PRAGMA user_version = 12;
    `)
    db.close()
}

function upgradeFixtureToV14WithLegacyRunningResume(dbPath: string): void {
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
    db.exec(`
        ALTER TABLE delivery_attempts ADD COLUMN idempotency_key TEXT;
        UPDATE delivery_attempts
        SET idempotency_key = attempt_id || ':' || message_id || ':' || state || ':migrated:' || rowid
        WHERE idempotency_key IS NULL;
        CREATE UNIQUE INDEX idx_delivery_attempts_idempotency
            ON delivery_attempts(namespace, idempotency_key);
        ALTER TABLE managed_resume_singleflight ADD COLUMN spawn_request_id TEXT;
        INSERT INTO managed_resume_singleflight(
            namespace, canonical_session_id, owner_token, expires_at,
            status, result_session_id, spawn_request_id, updated_at
        ) VALUES ('default', 'legacy-running', 'legacy-owner', 1, 'running', NULL, NULL, 1);
        PRAGMA user_version = 14;
    `)
    db.close()
}

function upgradeFixtureToActivityV14WithLegacyRunningResume(dbPath: string): void {
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
    db.exec(`
        ALTER TABLE delivery_attempts ADD COLUMN idempotency_key TEXT;
        UPDATE delivery_attempts
        SET idempotency_key = attempt_id || ':' || message_id || ':' || state || ':migrated:' || rowid
        WHERE idempotency_key IS NULL;
        CREATE UNIQUE INDEX idx_delivery_attempts_idempotency
            ON delivery_attempts(namespace, idempotency_key);
        ALTER TABLE sessions ADD COLUMN activity_event_at INTEGER;
        INSERT INTO managed_resume_singleflight(
            namespace, canonical_session_id, owner_token, expires_at,
            status, result_session_id, updated_at
        ) VALUES ('default', 'activity-v14-running', 'activity-v14-owner', 1, 'running', NULL, 1);
        PRAGMA user_version = 14;
    `)
    db.close()
}

function upgradeFixtureToV15WithLegacyTelegramBinding(dbPath: string): void {
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
    db.exec(`
        UPDATE managed_resume_singleflight
        SET status = 'legacy_ambiguous'
        WHERE status = 'running' AND spawn_request_id IS NULL;
        INSERT INTO users(platform, platform_user_id, namespace, created_at)
        VALUES ('telegram', '424242', 'victim-namespace', 1);
        PRAGMA user_version = 15;
    `)
    db.close()
}

function upgradeFixtureToV16WithBoundlessRunningResume(dbPath: string): void {
    const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
    db.exec(`
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
        INSERT INTO managed_resume_singleflight(
            namespace, canonical_session_id, owner_token, expires_at,
            status, result_session_id, spawn_request_id, updated_at
        ) VALUES (
            'default', 'v16-running', 'v16-owner', 9999999999999,
            'running', NULL, '16161616-1616-4616-8616-161616161616', 1
        );
        PRAGMA user_version = 16;
    `)
    db.close()
}

describe('Store schema migrations', () => {
    it('fully upgrades a populated legacy database whose user_version is zero', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-legacy-zero-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            const legacy = new Database(dbPath, { readwrite: true, strict: true })
            legacy.exec('PRAGMA user_version = 0')
            legacy.close()

            const store = new Store(dbPath)
            const session = store.sessions.getOrCreateSession(
                'legacy-zero-session',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            expect(store.sessions.setSessionActivity(session.id, true, 100, 100, 'default')).toBe(true)

            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            const columns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
            expect(columns).toContain('activity_event_at')
            expect(columns).toContain('service_tier')
            expect(columns).toContain('permission_mode')
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('prepares a v12 delivery ledger before creating current-schema indexes for a version-zero database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-v12-zero-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            upgradeFixtureToV12(dbPath)
            const legacy = new Database(dbPath, { readwrite: true, strict: true })
            legacy.exec('PRAGMA user_version = 0')
            legacy.close()

            const store = new Store(dbPath)
            expect(store.deliveryAttempts.recoverable('default', 'session-1')).toHaveLength(1)

            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            const columns = (db.prepare('PRAGMA table_info(delivery_attempts)').all() as Array<{ name: string }>).map((row) => row.name)
            expect(columns).toContain('idempotency_key')
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('migrates v8 databases to persist Codex service tiers', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-v8-service-tier-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)

            const store = new Store(dbPath)
            const session = store.sessions.getOrCreateSession(
                'session-service-tier-migration',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default',
                'gpt-5.5',
                undefined,
                'xhigh',
                'fast'
            )

            expect(session.serviceTier).toBe('fast')
            expect(store.sessions.getSession(session.id)?.serviceTier).toBe('fast')
            store.managedSessions.addAlias('default', 'legacy-session-id', session.id)
            expect(store.managedSessions.resolveCanonical('default', 'legacy-session-id')).toBe(session.id)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('migrates populated v12 delivery ledgers to durable idempotency keys', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-v12-delivery-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            upgradeFixtureToV12(dbPath)

            const store = new Store(dbPath)
            expect(store.deliveryAttempts.recoverable('default', 'session-1')).toHaveLength(1)
            expect(store.deliveryAttempts.append({
                namespace: 'default', canonicalSessionId: 'session-1', messageId: 'message-1',
                attemptId: 'attempt-1', launchNonce: 'launch-1', sequence: 1,
                state: 'written', createdAt: 2, idempotencyKey: 'post-migration-written'
            })).toEqual({ result: 'success', state: 'written' })

            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            const sessionColumns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
            expect(sessionColumns).toContain('activity_event_at')
            const resumeColumns = (db.prepare('PRAGMA table_info(managed_resume_singleflight)').all() as Array<{ name: string }>)
                .map((column) => column.name)
            expect(resumeColumns).toContain('spawn_request_id')
            expect(resumeColumns).toContain('spawn_operation_json')
            const migrated = db.prepare('SELECT idempotency_key FROM delivery_attempts WHERE state = ?').get('prepared') as { idempotency_key: string }
            expect(migrated.idempotency_key).toContain(':migrated:')
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('quarantines populated v14 running resumes that have no durable request ID', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-v14-legacy-resume-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            upgradeFixtureToV12(dbPath)
            upgradeFixtureToV14WithLegacyRunningResume(dbPath)

            new Store(dbPath)

            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            expect(db.prepare(`
                SELECT owner_token, status, spawn_request_id
                FROM managed_resume_singleflight
                WHERE namespace = 'default' AND canonical_session_id = 'legacy-running'
            `).get()).toEqual({
                owner_token: 'legacy-owner',
                status: 'legacy_ambiguous',
                spawn_request_id: null
            })
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('converges the deployed activity-v14 lineage with the security migration lineage', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-activity-v14-lineage-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            upgradeFixtureToV12(dbPath)
            upgradeFixtureToActivityV14WithLegacyRunningResume(dbPath)

            new Store(dbPath)

            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            const sessionColumns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
            expect(sessionColumns).toContain('activity_event_at')
            const resumeColumns = (db.prepare('PRAGMA table_info(managed_resume_singleflight)').all() as Array<{ name: string }>).map((row) => row.name)
            expect(resumeColumns).toContain('spawn_request_id')
            expect(resumeColumns).toContain('spawn_operation_json')
            expect(db.prepare(`
                SELECT owner_token, status, spawn_request_id, spawn_operation_json
                FROM managed_resume_singleflight
                WHERE namespace = 'default' AND canonical_session_id = 'activity-v14-running'
            `).get()).toEqual({
                owner_token: 'activity-v14-owner',
                status: 'legacy_ambiguous',
                spawn_request_id: null,
                spawn_operation_json: null
            })
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('invalidates suffix-era Telegram grants while migrating a real v15 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-v15-telegram-binding-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            upgradeFixtureToV12(dbPath)
            upgradeFixtureToV14WithLegacyRunningResume(dbPath)
            upgradeFixtureToV15WithLegacyTelegramBinding(dbPath)

            const migrated = new Store(dbPath)
            expect(migrated.users.getUser('telegram', '424242')).toBeNull()

            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            const credentialColumn = (db.prepare('PRAGMA table_info(users)').all() as Array<{
                name: string
                notnull: number
            }>).find((column) => column.name === 'credential_fingerprint')
            expect(credentialColumn?.notnull).toBe(1)
            expect((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(0)
            db.close()

            const reopened = new Store(dbPath)
            expect(reopened.users.getUser('telegram', '424242')).toBeNull()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('recovers an interrupted v12 migration where the column was already added', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-v12-interrupted-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            upgradeFixtureToV12(dbPath)
            const interrupted = new Database(dbPath, { readwrite: true, strict: true })
            interrupted.exec('ALTER TABLE delivery_attempts ADD COLUMN idempotency_key TEXT')
            interrupted.close()

            const store = new Store(dbPath)
            expect(store.deliveryAttempts.recoverable('default', 'session-1')).toHaveLength(1)
            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            const sessionColumns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
            expect(sessionColumns).toContain('activity_event_at')
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('quarantines v16 running resumes whose target and fingerprint were never persisted', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-store-v16-operation-identity-'))
        try {
            const dbPath = join(dir, 'store.sqlite')
            createV8Database(dbPath)
            upgradeFixtureToV12(dbPath)
            upgradeFixtureToV14WithLegacyRunningResume(dbPath)
            upgradeFixtureToV15WithLegacyTelegramBinding(dbPath)
            upgradeFixtureToV16WithBoundlessRunningResume(dbPath)

            new Store(dbPath)

            const db = new Database(dbPath, { readwrite: true, strict: true })
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
            expect(db.prepare(`
                SELECT owner_token, status, spawn_request_id, spawn_operation_json
                FROM managed_resume_singleflight
                WHERE namespace = 'default' AND canonical_session_id = 'v16-running'
            `).get()).toEqual({
                owner_token: 'v16-owner',
                status: 'legacy_ambiguous',
                spawn_request_id: '16161616-1616-4616-8616-161616161616',
                spawn_operation_json: null
            })
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
