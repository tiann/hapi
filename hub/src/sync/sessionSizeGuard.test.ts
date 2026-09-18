import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
    SESSION_SIZE_HARD_MAX_CONTENT_BYTES,
    SESSION_SIZE_SOFT_MAX_CONTENT_BYTES
} from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

/**
 * Resume-size guard (see shared/src/sessionSizeGuard.ts): resuming an
 * oversized session must refuse before any spawn work unless the caller
 * explicitly forces it — replaying a ~212k-message transcript into the hub
 * has OOMed it before.
 */

function createEngineWithSession(options?: { archived?: boolean }) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    const session = engine.getOrCreateSession(
        'session-size-guard',
        {
            path: '/tmp/project',
            host: 'localhost',
            machineId: 'machine-1',
            flavor: 'codex',
            codexSessionId: 'codex-thread-1',
            ...(options?.archived
                ? {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'test archive'
                }
                : {})
        },
        null,
        'default',
        'gpt-5'
    )
    engine.getOrCreateMachine(
        'machine-1',
        { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
        null,
        'default'
    )
    engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

    const spawnCalls: unknown[][] = []
    ;(engine as unknown as { rpcGateway: { spawnSession: (...args: unknown[]) => Promise<unknown> } })
        .rpcGateway.spawnSession = async (...args: unknown[]) => {
            spawnCalls.push(args)
            return { type: 'success', sessionId: session.id }
        }
    ;(engine as unknown as { waitForSessionActive: () => Promise<boolean> })
        .waitForSessionActive = async () => true

    return { store, engine, session, spawnCalls }
}

/** Incompressible user messages (never truncated) until stored bytes exceed the target. */
function fillSessionContent(store: Store, sessionId: string, targetBytes: number): void {
    while (store.messages.getSessionSizeStats(sessionId).contentBytes <= targetBytes) {
        store.messages.addMessage(sessionId, {
            role: 'user',
            content: { type: 'text', text: randomBytes(48 * 1024).toString('base64') }
        })
    }
}

describe('getSessionSizeStats', () => {
    it('counts rows and stored content bytes', () => {
        const { store, engine, session } = createEngineWithSession()
        try {
            const contents = [
                { role: 'user', content: { type: 'text', text: 'hello' } },
                { role: 'user', content: { type: 'text', text: 'world' } },
                { role: 'user', content: { type: 'text', text: 'again' } }
            ]
            for (const content of contents) {
                store.messages.addMessage(session.id, content)
            }
            const stats = store.messages.getSessionSizeStats(session.id)
            expect(stats.messageCount).toBe(3)
            // Short payloads stay plaintext JSON TEXT (< COMPRESS_MIN_CHARS),
            // so stored bytes equal the UTF-8 JSON byte length.
            const expectedBytes = contents.reduce(
                (sum, content) => sum + Buffer.byteLength(JSON.stringify(content), 'utf8'),
                0
            )
            expect(stats.contentBytes).toBe(expectedBytes)
        } finally {
            engine.stop()
        }
    })

    it('returns zeros for a session without messages', () => {
        const { store, engine, session } = createEngineWithSession()
        try {
            expect(store.messages.getSessionSizeStats(session.id)).toEqual({
                messageCount: 0,
                contentBytes: 0
            })
        } finally {
            engine.stop()
        }
    })
})

describe('resume-size guard', () => {
    it('resumes a session under the thresholds without force', async () => {
        const { store, engine, session, spawnCalls } = createEngineWithSession()
        try {
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'small' } })
            const result = await engine.resumeSession(session.id, 'default')
            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(spawnCalls.length).toBe(1)
        } finally {
            engine.stop()
        }
    })

    it('requires confirmation above the soft byte threshold and honors force', async () => {
        const { store, engine, session, spawnCalls } = createEngineWithSession()
        try {
            fillSessionContent(store, session.id, SESSION_SIZE_SOFT_MAX_CONTENT_BYTES)

            const blocked = await engine.resumeSession(session.id, 'default')
            expect(blocked.type).toBe('error')
            if (blocked.type !== 'error') throw new Error('expected error')
            expect(blocked.code).toBe('session_size_confirm_required')
            expect(blocked.message).toContain('confirmation threshold')
            expect(spawnCalls.length).toBe(0)

            const forced = await engine.resumeSession(session.id, 'default', { force: true })
            expect(forced).toEqual({ type: 'success', sessionId: session.id })
            expect(spawnCalls.length).toBe(1)
        } finally {
            engine.stop()
        }
    })

    it('hard-refuses above the hard byte threshold and honors force', async () => {
        const { store, engine, session, spawnCalls } = createEngineWithSession()
        try {
            fillSessionContent(store, session.id, SESSION_SIZE_HARD_MAX_CONTENT_BYTES)

            const blocked = await engine.resumeSession(session.id, 'default')
            expect(blocked.type).toBe('error')
            if (blocked.type !== 'error') throw new Error('expected error')
            expect(blocked.code).toBe('session_too_large')
            expect(blocked.message).toContain('hard resume limit')
            expect(spawnCalls.length).toBe(0)

            const forced = await engine.resumeSession(session.id, 'default', { force: true })
            expect(forced).toEqual({ type: 'success', sessionId: session.id })
            expect(spawnCalls.length).toBe(1)
        } finally {
            engine.stop()
        }
    })

    it('reports stats and verdict through getSessionSizeGuard', async () => {
        const { store, engine, session } = createEngineWithSession()
        try {
            expect(engine.getSessionSizeGuard(session.id, 'default')).toEqual({
                type: 'success',
                stats: { messageCount: 0, contentBytes: 0 },
                verdict: 'ok'
            })
            fillSessionContent(store, session.id, SESSION_SIZE_SOFT_MAX_CONTENT_BYTES)
            const result = engine.getSessionSizeGuard(session.id, 'default')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error('expected success')
            expect(result.verdict).toBe('soft')
            expect(result.stats.contentBytes).toBeGreaterThan(SESSION_SIZE_SOFT_MAX_CONTENT_BYTES)

            expect(engine.getSessionSizeGuard('missing-session', 'default')).toMatchObject({
                type: 'error',
                code: 'session_not_found'
            })
        } finally {
            engine.stop()
        }
    })

    it('blocks reopen of an oversized archived session and restores its archive metadata', async () => {
        const { store, engine, session, spawnCalls } = createEngineWithSession({ archived: true })
        try {
            fillSessionContent(store, session.id, SESSION_SIZE_HARD_MAX_CONTENT_BYTES)

            const blocked = await engine.reopenSession(session.id, 'default')
            expect(blocked.type).toBe('error')
            if (blocked.type !== 'error') throw new Error('expected error')
            expect(blocked.code).toBe('session_too_large')
            expect(spawnCalls.length).toBe(0)
            const after = store.sessions.getSession(session.id)
            expect((after?.metadata as { lifecycleState?: string } | null)?.lifecycleState).toBe('archived')

            const forced = await engine.reopenSession(session.id, 'default', { force: true })
            expect(forced).toMatchObject({ type: 'success', sessionId: session.id, resumed: true })
            expect(spawnCalls.length).toBe(1)
        } finally {
            engine.stop()
        }
    })
})
