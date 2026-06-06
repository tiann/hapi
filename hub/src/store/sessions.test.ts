import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function getMetadata(store: Store, id: string): Record<string, unknown> | null {
    const row = store.sessions.getSession(id)
    return (row?.metadata ?? null) as Record<string, unknown> | null
}

describe('updateSessionMetadata: protocol resume token preservation', () => {
    it('preserves cursorSessionId when archive payload omits it (Cursor crash-archive)', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-archive-cursor-id',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'cursor-thread-abc',
                cursorSessionProtocol: 'stream-json',
                lifecycleState: 'running'
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                lifecycleState: 'archived',
                lifecycleStateSince: 2,
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata).not.toBeNull()
        expect(metadata?.cursorSessionId).toBe('cursor-thread-abc')
        expect(metadata?.cursorSessionProtocol).toBe('stream-json')
        expect(metadata?.lifecycleState).toBe('archived')
        expect(metadata?.archiveReason).toBe('Session crashed')
        expect(metadata?.archivedBy).toBe('cli')
    })

    it('preserves codexSessionId when archive payload omits it (Codex generic flavor)', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'codex-archive',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                codexSessionId: 'codex-thread-1',
                lifecycleState: 'running'
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.codexSessionId).toBe('codex-thread-1')
    })

    it.each([
        ['claudeSessionId', 'claude-thread-x'],
        ['codexSessionId', 'codex-thread-x'],
        ['geminiSessionId', 'gemini-thread-x'],
        ['opencodeSessionId', 'opencode-thread-x'],
        ['cursorSessionId', 'cursor-thread-x'],
        ['kimiSessionId', 'kimi-thread-x']
    ])('preserves %s across an archive metadata replacement', (field, value) => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            `archive-${field}`,
            {
                path: '/tmp/project',
                host: 'example',
                [field]: value
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                lifecycleState: 'archived',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.[field]).toBe(value)
    })

    it('preserves cursorSessionProtocol independently of cursorSessionId', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-protocol-only',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionProtocol: 'acp'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example' },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id)
        expect(metadata?.cursorSessionProtocol).toBe('acp')
    })

    it('lets the next write override a flavor session id when it explicitly sets a different value', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-overwrite',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'old-thread'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'new-thread'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id)
        expect(metadata?.cursorSessionId).toBe('new-thread')
    })

    it('does not invent fields when the prior row had no resume token', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'no-prior-token',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                lifecycleState: 'archived',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id)
        expect(metadata).not.toBeNull()
        expect('cursorSessionId' in (metadata as Record<string, unknown>)).toBe(false)
        expect('codexSessionId' in (metadata as Record<string, unknown>)).toBe(false)
    })

    it('preserves resume token when CLI sends an empty payload (stale-cache failure mode)', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-empty-payload',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'survives-empty-payload'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id)
        expect(metadata?.cursorSessionId).toBe('survives-empty-payload')
        expect(metadata?.lifecycleState).toBe('archived')
    })

    it('preserves resume token across multiple consecutive metadata writes', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-multi-write',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'persistent-thread'
            },
            null,
            'default'
        )

        const v1 = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', name: 'renamed' },
            session.metadataVersion,
            'default'
        )
        expect(v1.result).toBe('success')

        const v2 = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', name: 'renamed', tools: ['read_file'] },
            v1.result === 'success' ? v1.version : -1,
            'default'
        )
        expect(v2.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.cursorSessionId).toBe('persistent-thread')
        expect(metadata?.name).toBe('renamed')
        expect(metadata?.tools).toEqual(['read_file'])
    })

    it('returns version-mismatch unchanged when the expected version is stale', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-version-mismatch',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'stable-id'
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example' },
            session.metadataVersion + 99,
            'default'
        )
        expect(result.result).toBe('version-mismatch')
        if (result.result === 'version-mismatch') {
            const value = result.value as Record<string, unknown> | null
            expect(value?.cursorSessionId).toBe('stable-id')
        }
    })

    it('returns error when the session row does not exist', () => {
        const store = makeStore()
        const result = store.sessions.updateSessionMetadata(
            'no-such-session',
            { path: '/tmp/project', host: 'example' },
            0,
            'default'
        )
        expect(result.result).toBe('error')
    })

    it('archive then read-back ships a payload that legacy resume routing can use', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-roundtrip',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'legacy-uuid',
                lifecycleState: 'running'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                lifecycleState: 'archived',
                archiveReason: 'Session crashed',
                archivedBy: 'cli'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id)
        // Legacy routing in cursorProtocol.isLegacyCursorSession() defaults to
        // legacy when cursorSessionProtocol is unset and cursorSessionId is
        // truthy. Preserving the id alone is enough for resume to route
        // correctly even if the protocol marker was never persisted.
        expect(metadata?.cursorSessionId).toBe('legacy-uuid')
        expect(metadata?.flavor).toBe('cursor')
    })
})
