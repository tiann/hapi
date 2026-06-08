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

    // P1 from cold review: a sparse archive payload must result in a
    // metadata blob that still parses against MetadataSchema (path/host
    // are required). Without these, downstream consumers null-out the
    // metadata and resume cannot find the session even though the
    // resume token survived in the DB.
    it('preserves required path and host when archive payload is sparse (sparse-cache failure mode)', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-sparse-archive',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'parse-required'
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

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.path).toBe('/tmp/project')
        expect(metadata?.host).toBe('example')
        expect(metadata?.cursorSessionId).toBe('parse-required')
        expect(metadata?.lifecycleState).toBe('archived')
    })

    it('does not invent path or host when prior had none', () => {
        const store = makeStore()
        // create with minimal raw metadata (path is technically required by
        // the schema, but the store accepts any JSON; this exercises the
        // edge case where prior is missing identity fields)
        const session = store.sessions.getOrCreateSession(
            'no-prior-identity',
            { flavor: 'cursor' },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            { lifecycleState: 'archived' },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.lifecycleState).toBe('archived')
        expect('path' in (metadata ?? {})).toBe(false)
        expect('host' in (metadata ?? {})).toBe(false)
    })

    // P2 from cold review: flavor + machineId are routing fields. Without
    // flavor, hub/src/web/routes/sessions.ts and syncEngine fall through
    // to the `?? 'claude'` default and ignore the preserved Cursor/Codex
    // token. Without machineId, the CLI's resumable listing filters the
    // row out of the resume picker. Both must survive sparse archive.
    it('preserves flavor and machineId across sparse archive (resume routing)', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-routing-survives',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                machineId: 'mach-xyz',
                cursorSessionId: 'cursor-thread-routed'
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

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.flavor).toBe('cursor')
        expect(metadata?.machineId).toBe('mach-xyz')
        expect(metadata?.cursorSessionId).toBe('cursor-thread-routed')
    })

    it('does not invent flavor or machineId when prior had none', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'no-prior-routing',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            { lifecycleState: 'archived' },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.lifecycleState).toBe('archived')
        expect('flavor' in (metadata ?? {})).toBe(false)
        expect('machineId' in (metadata ?? {})).toBe(false)
    })

    it('lets the next write override flavor and machineId when explicitly set', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'override-routing',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                machineId: 'mach-old'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                machineId: 'mach-new'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.flavor).toBe('codex')
        expect(metadata?.machineId).toBe('mach-new')
    })

    // P2 from cold review: cursorSessionProtocol must NOT carry over
    // when the next write explicitly sets a different cursorSessionId.
    // The protocol is tied to the id, and a different id may use a
    // different protocol (e.g. legacy stream-json id under an old
    // ACP marker would be misrouted).
    it('drops cursorSessionProtocol when a new cursorSessionId is written', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-protocol-pair-drop',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'old-id',
                cursorSessionProtocol: 'acp'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'new-id'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.cursorSessionId).toBe('new-id')
        expect(metadata?.cursorSessionProtocol).toBeUndefined()
    })

    it('preserves cursorSessionProtocol when neither id nor protocol is in the next write', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-protocol-pair-preserve',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'stable-id',
                cursorSessionProtocol: 'acp'
            },
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

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.cursorSessionId).toBe('stable-id')
        expect(metadata?.cursorSessionProtocol).toBe('acp')
    })

    it('respects an explicit cursorSessionProtocol on the next write even when the id is unchanged', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-protocol-pair-explicit',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'stable-id'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionProtocol: 'stream-json'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.cursorSessionId).toBe('stable-id')
        expect(metadata?.cursorSessionProtocol).toBe('stream-json')
    })

    // P2 from cold review: the broadcast on a successful update must
    // ship the merged value so other CLIs in the session room update
    // their local cache to the persisted state. This is enforced in the
    // socket handler (see hub/src/socket/handlers/cli/sessionHandlers.ts);
    // the store-level guarantee here is that result.value reflects the
    // merged state and not the pre-merge input.
    it('returns the merged value in the success ack, not the pre-merge input', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cursor-ack-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'should-survive-ack'
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        expect(result.result).toBe('success')
        if (result.result === 'success') {
            const value = result.value as Record<string, unknown> | null
            expect(value?.path).toBe('/tmp/project')
            expect(value?.host).toBe('example')
            expect(value?.cursorSessionId).toBe('should-survive-ack')
            expect(value?.lifecycleState).toBe('archived')
        }
    })

    // Upstream cold-review (Major): preserve-on-omit must not block
    // intentional clears. `cli/src/codex/session.ts resetCodexThread()`
    // is the existing site that needs to drop `codexSessionId` (called
    // from /clear in codexRemoteLauncher.ts). The explicit-clear
    // sentinel: `null` in `next` means "drop this field entirely from
    // the merged blob" (key removed, not stored as null) — distinct
    // from omitted (`undefined`) which carries forward.
    it('drops a carry-forward field when next sets it to null (explicit clear)', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'codex-explicit-clear',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                codexSessionId: 'old-thread'
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
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        expect(result.result).toBe('success')
        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata).not.toBeNull()
        expect('codexSessionId' in (metadata ?? {})).toBe(false)
        expect(metadata?.flavor).toBe('codex')
    })

    it('treats null as clear for any carry-forward field, independently of others', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'multi-token-explicit-clear',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'cursor-keep',
                codexSessionId: 'codex-clear-me'
            },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect('codexSessionId' in (metadata ?? {})).toBe(false)
        expect(metadata?.cursorSessionId).toBe('cursor-keep')
        expect(metadata?.flavor).toBe('cursor')
    })

    it('null on a never-set field is a no-op (does not introduce the key)', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'null-on-absent',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )

        store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        const metadata = getMetadata(store, session.id) as Record<string, unknown> | null
        expect('codexSessionId' in (metadata ?? {})).toBe(false)
    })

    it('explicit clear leaves the merged value in the success ack', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'explicit-clear-ack',
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: 'thread-x'
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        expect(result.result).toBe('success')
        if (result.result === 'success') {
            const value = result.value as Record<string, unknown> | null
            expect('codexSessionId' in (value ?? {})).toBe(false)
            expect(value?.path).toBe('/tmp/project')
        }
    })
})
