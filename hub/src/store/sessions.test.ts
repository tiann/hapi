import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from './index'
import { randomUUID } from 'node:crypto'
import { SessionIdentityConflictError } from './sessions'

function makeStore(): Store {
    return new Store(':memory:')
}

function getMetadata(store: Store, id: string): Record<string, unknown> | null {
    const row = store.sessions.getSession(id)
    return (row?.metadata ?? null) as Record<string, unknown> | null
}

describe('getOrCreateSession: active_at', () => {
    it('persists a non-null active_at on insert (never NULL)', () => {
        const store = makeStore()
        const created = store.sessions.getOrCreateSession(
            'active-at-write',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )

        expect(typeof created.activeAt).toBe('number')
        expect(created.activeAt).not.toBeNull()
        expect(created.activeAt).toBe(created.createdAt)

        const reloaded = store.sessions.getSession(created.id)
        expect(reloaded?.activeAt).toBe(created.createdAt)
        store.close()
    })
})

describe('session pinning', () => {
    it('persists project and global pin modes without changing session recency', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession('pin-test', {}, null, 'default')

        expect(session.pinned).toBe(false)
        expect(session.globalPinned).toBe(false)
        expect(store.sessions.setSessionPinMode(session.id, 'project', 'default')).toBe(true)

        const projectPinned = store.sessions.getSession(session.id)
        expect(projectPinned?.pinned).toBe(true)
        expect(projectPinned?.globalPinned).toBe(false)
        expect(projectPinned?.updatedAt).toBe(session.updatedAt)

        expect(store.sessions.setSessionPinMode(session.id, 'global', 'default')).toBe(true)
        const globalPinned = store.sessions.getSession(session.id)
        expect(globalPinned?.pinned).toBe(false)
        expect(globalPinned?.globalPinned).toBe(true)

        expect(store.sessions.setSessionPinMode(session.id, 'none', 'other')).toBe(false)
        expect(store.sessions.getSession(session.id)?.globalPinned).toBe(true)
        store.close()
    })
})

describe('getOrCreateSession: requested identity', () => {
    it('creates and idempotently reloads a client-requested id', () => {
        const store = makeStore()
        const requestedId = randomUUID()

        const created = store.sessions.getOrCreateSession(
            'lazy-session-tag',
            { path: '/tmp/project' },
            { controlledByUser: true },
            'default',
            undefined,
            undefined,
            undefined,
            requestedId
        )
        const reloaded = store.sessions.getOrCreateSession(
            'lazy-session-tag',
            { path: '/tmp/ignored' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            requestedId
        )

        expect(created.id).toBe(requestedId)
        expect(reloaded.id).toBe(requestedId)
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
        store.close()
    })

    it('rejects a tag already bound to another requested id', () => {
        const store = makeStore()
        const firstId = randomUUID()
        store.sessions.getOrCreateSession(
            'conflicting-tag', {}, null, 'default', undefined, undefined, undefined, firstId
        )

        expect(() => store.sessions.getOrCreateSession(
            'conflicting-tag', {}, null, 'default', undefined, undefined, undefined, randomUUID()
        )).toThrow(SessionIdentityConflictError)
        store.close()
    })

    it('rejects a requested id already bound to another tag', () => {
        const store = makeStore()
        const requestedId = randomUUID()
        store.sessions.getOrCreateSession(
            'first-tag', {}, null, 'default', undefined, undefined, undefined, requestedId
        )

        expect(() => store.sessions.getOrCreateSession(
            'second-tag', {}, null, 'default', undefined, undefined, undefined, requestedId
        )).toThrow(SessionIdentityConflictError)
        store.close()
    })

    it('reproduces hub-prealloc vs CLI-tag conflict (machine-spawn stub, #1911)', () => {
        // Hub preallocates with tag machine-spawn:<uuid>; CLI create used a random
        // tag + the same id → 409. This documents the bug adopt must fix.
        const store = makeStore()
        const allocatedId = randomUUID()
        store.sessions.getOrCreateSession(
            `machine-spawn:${allocatedId}`,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                machineId: 'machine-1',
                startedBy: 'runner',
                startedFromRunner: true,
            },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            allocatedId
        )

        expect(() => store.sessions.getOrCreateSession(
            randomUUID(), // CLI bootstrap tag
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                machineId: 'machine-1',
                startedBy: 'runner',
                hostPid: 12345,
            },
            {},
            'default',
            undefined,
            undefined,
            undefined,
            allocatedId
        )).toThrow(SessionIdentityConflictError)
        store.close()
    })

    it('adopts a machine-spawn preallocated stub and overwrites tag + metadata', () => {
        const store = makeStore()
        const allocatedId = randomUUID()
        const cliTag = randomUUID()
        store.sessions.getOrCreateSession(
            `machine-spawn:${allocatedId}`,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                machineId: 'machine-1',
                startedBy: 'runner',
                startedFromRunner: true,
            },
            null,
            'default',
            'stub-model',
            undefined,
            undefined,
            allocatedId
        )

        const adopted = store.sessions.adoptPreallocatedSession(
            allocatedId,
            cliTag,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                machineId: 'machine-1',
                startedBy: 'runner',
                startedFromRunner: true,
                hostPid: 4242,
            },
            { controlledByUser: false },
            'default',
            'claude-sonnet',
            undefined,
            undefined
        )

        expect(adopted.id).toBe(allocatedId)
        expect(adopted.tag).toBe(cliTag)
        expect(adopted.model).toBe('claude-sonnet')
        const meta = adopted.metadata as { hostPid?: number }
        expect(meta.hostPid).toBe(4242)
        // Idempotent adopt with same tag returns the row
        const again = store.sessions.adoptPreallocatedSession(
            allocatedId,
            cliTag,
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            {},
            'default'
        )
        expect(again.id).toBe(allocatedId)
        expect(again.tag).toBe(cliTag)
        store.close()
    })

    it('rejects adopt when the row is not a preallocated stub', () => {
        const store = makeStore()
        const id = randomUUID()
        store.sessions.getOrCreateSession(
            'live-terminal-tag',
            { path: '/tmp', startedBy: 'terminal' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            id
        )

        expect(() => store.sessions.adoptPreallocatedSession(
            id,
            randomUUID(),
            { path: '/tmp', startedBy: 'runner' },
            {},
            'default'
        )).toThrow(/not a preallocated stub|not adoptable/i)
        store.close()
    })

    it('releases machine-spawn stub tag on metadata update (reopen-flavor path)', () => {
        // codex/cursor/pi/… use --existing-session-id → bootstrapExistingSession
        // → updateMetadata, never adopt. Stub tag must not stick forever.
        const store = makeStore()
        const allocatedId = randomUUID()
        const created = store.sessions.getOrCreateSession(
            `machine-spawn:${allocatedId}`,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                machineId: 'm1',
                startedBy: 'runner',
                startedFromRunner: true,
            },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            allocatedId
        )
        expect(created.tag).toBe(`machine-spawn:${allocatedId}`)

        const updated = store.sessions.updateSessionMetadata(
            allocatedId,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                machineId: 'm1',
                startedBy: 'runner',
                startedFromRunner: true,
                hostPid: 999,
            },
            created.metadataVersion,
            'default'
        )
        expect(updated.result).toBe('success')
        const row = store.sessions.getSession(allocatedId)
        expect(row?.tag).not.toMatch(/^machine-spawn:/)
        expect((row?.metadata as { hostPid?: number } | null)?.hostPid).toBe(999)

        // Live row must no longer be adoptable.
        expect(() => store.sessions.adoptPreallocatedSession(
            allocatedId,
            randomUUID(),
            { path: '/tmp', flavor: 'cursor' },
            {},
            'default'
        )).toThrow(/not a preallocated stub|not adoptable/i)
        store.close()
    })

    it('rejects adopt of an archived preallocated stub', () => {
        const store = makeStore()
        const allocatedId = randomUUID()
        store.sessions.getOrCreateSession(
            `machine-spawn:${allocatedId}`,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                startedBy: 'runner',
                startedFromRunner: true,
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'user archived while booting',
            },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            allocatedId
        )

        expect(() => store.sessions.adoptPreallocatedSession(
            allocatedId,
            randomUUID(),
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            {},
            'default'
        )).toThrow(/archived|not adoptable/i)
        const row = store.sessions.getSession(allocatedId)
        expect(row?.tag).toBe(`machine-spawn:${allocatedId}`)
        expect((row?.metadata as { lifecycleState?: string } | null)?.lifecycleState).toBe('archived')
        store.close()
    })
})

describe('updateSessionMetadata: refuse un-archive (#1911 M1)', () => {
    it('merge-preserves hub archive on unauthorized running write (success, not mismatch)', () => {
        const store = makeStore()
        const allocatedId = randomUUID()
        const session = store.sessions.getOrCreateSession(
            `machine-spawn:${allocatedId}`,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'KillSession miss',
                startedBy: 'runner',
                startedFromRunner: true,
            },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            allocatedId
        )

        const preserved = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'running',
            },
            session.metadataVersion,
            'default'
        )
        expect(preserved.result).toBe('success')
        if (preserved.result !== 'success') throw new Error('expected success')
        expect((preserved.value as { lifecycleState?: string; archivedBy?: string } | null)?.lifecycleState)
            .toBe('archived')
        expect((preserved.value as { archivedBy?: string } | null)?.archivedBy).toBe('hub')
        expect(getMetadata(store, session.id)?.lifecycleState).toBe('archived')
        expect(getMetadata(store, session.id)?.archivedBy).toBe('hub')
        // Tag may already be released by archive-via-metadata; assert archive held.
        expect(store.sessions.getSession(session.id)?.tag).toBe(`machine-spawn:${allocatedId}`)

        const allowed = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleStateSince: Date.now(),
            },
            // version advanced by preserve write
            (preserved.version),
            'default',
            { allowUnarchive: true }
        )
        expect(allowed.result).toBe('success')
        expect(getMetadata(store, session.id)?.lifecycleState).toBeUndefined()
        store.close()
    })

    it('does not preserve CLI self-archive (archivedBy=cli) when writing running', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'cli-self-archive',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'clean exit',
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'running',
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')
        expect(getMetadata(store, session.id)?.lifecycleState).toBe('running')
        store.close()
    })

    it('still allows non-lifecycle updates while hub-archived', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'archived-keep-fields',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'inactivity',
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'claude',
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'inactivity',
                hostPid: 4242,
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')
        expect(getMetadata(store, session.id)?.lifecycleState).toBe('archived')
        expect(getMetadata(store, session.id)?.hostPid).toBe(4242)
        store.close()
    })
})

describe('updateSessionMetadata: protocol resume token preservation', () => {
    it('preserves externalRefs when a sparse replacement omits them', () => {
        const store = makeStore()
        const externalRefs = [{
            kind: 'github_pr',
            repo: 'tiann/hapi',
            number: 1160,
            url: 'https://github.com/tiann/hapi/pull/1160',
            role: 'primary'
        }]
        const session = store.sessions.getOrCreateSession(
            'external-refs-preserve',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                externalRefs
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
                lifecycleState: 'running'
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')
        expect(getMetadata(store, session.id)?.externalRefs).toEqual(externalRefs)
        store.close()
    })

    it('preserves the automatic title attempt marker across sparse metadata updates', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'auto-title-marker',
            {
                path: '/tmp/project',
                host: 'example',
                titleSuggestionAutoAttemptedAt: 1234,
                titleSuggestionTurn: { first: true, completed: false }
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', lifecycleState: 'archived' },
            session.metadataVersion,
            'default'
        )

        expect(result.result).toBe('success')
        expect(getMetadata(store, session.id)?.titleSuggestionAutoAttemptedAt).toBe(1234)
        expect(getMetadata(store, session.id)?.titleSuggestionTurn).toEqual({ first: true, completed: false })
        store.close()
    })

    it('unions a sparse write\'s own distinct ref with prior refs, but still clears with explicit []', () => {
        // A write reaching this generic merge path with its own nonempty
        // externalRefs is virtually always a CLI metadata sync spreading a
        // local cache snapshot (title/model/resume changes etc.), not a
        // deliberate "replace my externalRefs with exactly X" call — those
        // go through the dedicated external-refs routes/sessionCache methods
        // instead, which never reach this function. Treating an unrelated
        // distinct ref in that snapshot as "the new complete truth" would
        // silently drop a PR/issue link the snapshot simply predates
        // (hapi-meta-daily.sh / out-of-band hapi link-issue incident class,
        // hapi#238) — union by identity instead.
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'external-refs-explicit',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                externalRefs: [{
                    kind: 'github_pr',
                    repo: 'tiann/hapi',
                    number: 1160,
                    url: 'https://github.com/tiann/hapi/pull/1160',
                    role: 'primary'
                }]
            },
            null,
            'default'
        )

        const replacement = [{
            kind: 'github_pr',
            repo: 'owner/other',
            number: 42,
            url: 'https://github.com/owner/other/pull/42',
            role: 'secondary'
        }]
        let version = session.metadataVersion
        let result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                externalRefs: replacement
            },
            version,
            'default'
        )
        expect(result.result).toBe('success')
        if (result.result === 'success') version = result.version
        const unioned = getMetadata(store, session.id)?.externalRefs as Array<{ number: number }> | undefined
        expect(unioned?.map(ref => ref.number).sort((a, b) => a - b)).toEqual([42, 1160])

        result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                externalRefs: []
            },
            version,
            'default'
        )
        expect(result.result).toBe('success')
        expect(getMetadata(store, session.id)?.externalRefs).toEqual([])
        store.close()
    })

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
        ['grokSessionId', 'grok-thread-x'],
        ['cursorSessionId', 'cursor-thread-x'],
        ['kimiSessionId', 'kimi-thread-x'],
        ['copilotSessionId', 'copilot-thread-x'],
        ['piSessionId', 'pi-thread-x']
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

    // P1 from Codex review (hapi#238): a sparse CLI metadata write (e.g. from
    // a null/stale local cache) that omits or doesn't yet know about
    // externalRefs must not wipe an issue/PR link set via `hapi link-issue`.
    it('preserves externalRefs when a sparse metadata write omits them entirely', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'sparse-write-omits-refs',
            {
                path: '/tmp/project',
                host: 'example',
                externalRefs: [
                    { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
                ]
            },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example' },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([
            { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        ])
    })

    it('unions externalRefs when a sparse write carries its own stale-but-present array', () => {
        const store = makeStore()
        const refOne = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        const refTwo = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/2', repo: 'acme/repo', number: 2, linkedAt: 2 }
        const session = store.sessions.getOrCreateSession(
            'sparse-write-stale-refs',
            { path: '/tmp/project', host: 'example', externalRefs: [refOne, refTwo] },
            null,
            'default'
        )

        // Simulates a CLI write built from a local cache that predates the
        // second `hapi link-issue` call — its own payload still only has the
        // first ref, not an omitted key, so a plain undefined-only
        // carry-forward would miss this and clobber ref #2.
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [refOne] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([refOne, refTwo])
    })

    // Review finding: a dedicated mutation (mutateSessionExternalRefs, behind
    // link_issue/link_pr/remove-primary) computes the full intended result
    // from a freshly-read current state — it is never a sparse snapshot like
    // the CLI write above, so unioning it with prior is exactly wrong: an
    // issue-only array (after removing a primary PR) looks identical to a
    // stale write that merely doesn't know about the PR yet, and the union
    // silently resurrected it. `replaceExternalRefs: true` opts out of that
    // union for this one call.
    it('replaceExternalRefs: true replaces outright instead of unioning with prior — does not resurrect a removed ref', () => {
        const store = makeStore()
        const prRef = { kind: 'github_pr', url: 'https://github.com/tiann/hapi/pull/1163', repo: 'tiann/hapi', number: 1163, role: 'primary', source: 'user', linkedAt: 1 }
        const issueRef = { kind: 'github_issue', url: 'https://github.com/tiann/hapi/issues/238', repo: 'tiann/hapi', number: 238, linkedAt: 2 }
        const session = store.sessions.getOrCreateSession(
            'replace-no-resurrect',
            { path: '/tmp/project', host: 'example', externalRefs: [prRef, issueRef] },
            null,
            'default'
        )

        // Mirrors remove-primary's own transform: drop the PR, keep the rest.
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [issueRef] },
            session.metadataVersion,
            'default',
            { replaceExternalRefs: true }
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([issueRef])
    })

    it('replaceExternalRefs: true still honors an explicit empty-array clear', () => {
        const store = makeStore()
        const ref = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        const session = store.sessions.getOrCreateSession(
            'replace-clear',
            { path: '/tmp/project', host: 'example', externalRefs: [ref] },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [] },
            session.metadataVersion,
            'default',
            { replaceExternalRefs: true }
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([])
    })

    // Review finding: a sparse-write union (the generic, non-replace path)
    // has no cap of its own even though ExternalRefsSchema does — two
    // independently-valid sets of refs near the 32 limit can union past it.
    // Persisting that doesn't just lose the extras: MetadataSchema
    // validation fails on the *next* read, nulling out the whole metadata
    // object (name, path, flavor, resume ids, every ref), not just
    // externalRefs. Falls back to priorRefs instead, the same "can't trust
    // this union" response the all-malformed-elements case already uses.
    it('falls back to priorRefs when a sparse-write union would exceed MAX_EXTERNAL_REFS', () => {
        const store = makeStore()
        const makeRef = (n: number) => ({
            kind: 'github_issue', url: `https://github.com/acme/repo/issues/${n}`, repo: 'acme/repo', number: n, linkedAt: n
        })
        const priorRefs = Array.from({ length: 20 }, (_, i) => makeRef(i + 1))
        const nextRefs = Array.from({ length: 20 }, (_, i) => makeRef(i + 1000))
        const session = store.sessions.getOrCreateSession(
            'union-over-cap',
            { path: '/tmp/project', host: 'example', externalRefs: priorRefs },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: nextRefs },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        // Union of 40 distinct refs exceeds the 32 cap — must not persist
        // it, and critically must not corrupt the rest of metadata either.
        expect(metadata?.path).toBe('/tmp/project')
        expect((metadata?.externalRefs as unknown[] | undefined)?.length).toBeLessThanOrEqual(32)
        expect(metadata?.externalRefs).toEqual(priorRefs)
    })

    // Found by Meta during a soup absorb and independently confirmed by hand
    // against this exact code (not just the test): an explicit
    // `externalRefs: []` is a deliberate unlink-to-empty, not a sparse/stale
    // write merely missing some refs it didn't know about yet — those two
    // looked identical as "an empty-ish array" before this fix, so the
    // union-recovery logic silently resurrected the cleared ref.
    it('honors an explicit externalRefs: [] clear instead of resurrecting the prior ref', () => {
        const store = makeStore()
        const ref = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        const session = store.sessions.getOrCreateSession(
            'explicit-unlink-to-empty',
            { path: '/tmp/project', host: 'example', externalRefs: [ref] },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([])
    })

    // Codex review (hapi#238): updateMetadataSchema accepts metadata as
    // z.unknown(), so a malformed externalRefs element from an authenticated
    // CLI used to reach reconcileExternalRefs' identity comparison and throw
    // (e.g. calling .toLowerCase() on a ref missing `repo`) — caught by
    // updateSessionMetadata's own try/catch, but that collapsed the ENTIRE
    // write into a generic error instead of just dropping the one bad ref.
    it('drops a malformed externalRefs element instead of throwing and failing the whole write, preserving the prior ref', () => {
        // Codex review (hapi#238, fresh finding after this exact fix landed):
        // a nonempty-but-wholly-invalid array must NOT be treated the same
        // as an explicit `externalRefs: []` clear — that would silently
        // unlink every valid ref over one malformed element. Updated from
        // this test's own earlier expectation (which asserted the
        // then-current, since-corrected "clears to []" behavior).
        const store = makeStore()
        const ref = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        const session = store.sessions.getOrCreateSession(
            'malformed-ref-element',
            { path: '/tmp/project', host: 'example', externalRefs: [ref] },
            null,
            'default'
        )

        const malformed = { kind: 'github_issue' } // missing url/repo/number/linkedAt entirely
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', name: 'renamed', externalRefs: [malformed] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.name).toBe('renamed')
        expect(metadata?.externalRefs).toEqual([ref])
    })

    it('still honors an explicit externalRefs: [] clear, distinct from an all-rejected nonempty array', () => {
        const store = makeStore()
        const ref = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        const session = store.sessions.getOrCreateSession(
            'explicit-clear-vs-all-rejected',
            { path: '/tmp/project', host: 'example', externalRefs: [ref] },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([])
    })

    it('keeps the valid refs and drops only the malformed one when a write mixes both', () => {
        const store = makeStore()
        const validRef = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        const session = store.sessions.getOrCreateSession(
            'mixed-valid-and-malformed-refs',
            { path: '/tmp/project', host: 'example', externalRefs: [validRef] },
            null,
            'default'
        )

        const newValidRef = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/2', repo: 'acme/repo', number: 2, linkedAt: 2 }
        const malformed = { kind: 'github_issue', url: 'not even a url', repo: 'acme/repo', number: 2, linkedAt: 2 }
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [newValidRef, malformed] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([validRef, newValidRef])
    })

    // Codex review (hapi#238): toValidExternalRefs used to filter the raw
    // array by `.safeParse(item).success` but return the original `item`,
    // discarding ExternalRefSchema's own canonical-URL transform — the
    // schema hardening a round earlier was a no-op from this function's own
    // callers' point of view, since the non-canonical raw url still ended up
    // persisted.
    it('drops a non-canonical (non-https) url instead of persisting it raw', () => {
        // Reconciled with the upstream-shaped schema (tiann/hapi#1160-#1163):
        // GithubIssueExternalRefSchema rejects a non-https url outright rather
        // than rewriting it to canonical form — every real write path
        // (parseIssueUrl) already produces a canonical https url, so a
        // non-https one here is dropped by toValidExternalRefs like any
        // other malformed element.
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'persists-canonical-url',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )

        const result = store.sessions.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                externalRefs: [{ kind: 'github_issue', url: 'http://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }]
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([])
    })

    // Codex review (hapi#238, second finding on this path): identity-only
    // collision handling (plain array-length no-op check) let a stale write
    // silently roll back a field-level update already applied directly to
    // the stored ref by out-of-band tooling (hapi-meta-daily.sh PR-chip
    // status updates), since both arrays had the same length and identity.
    it('preserves a newer field-level update on a matching ref instead of rolling it back to a stale copy', () => {
        const store = makeStore()
        const freshPrRef = { kind: 'github_pr', url: 'https://github.com/acme/repo/pull/9', repo: 'acme/repo', number: 9, linkedAt: 5, role: 'primary', statusCheckedAt: 200 }
        const session = store.sessions.getOrCreateSession(
            'preserve-field-update-on-collision',
            { path: '/tmp/project', host: 'example', externalRefs: [freshPrRef] },
            null,
            'default'
        )

        // Simulates a CLI write built from a cache snapshot taken before
        // hapi-meta-daily.sh applied the status update directly to storage —
        // same identity, same linkedAt, but stale status fields.
        const stalePrRef = { kind: 'github_pr', url: 'https://github.com/acme/repo/pull/9', repo: 'acme/repo', number: 9, linkedAt: 5, role: 'primary', statusCheckedAt: 100 }
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [stalePrRef] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([freshPrRef])
    })

    // Codex review (hapi#238, third finding on this path): hapi-meta-daily.sh's
    // own status-refresh writes bump statusCheckedAt without touching
    // linkedAt — comparing linkedAt alone made every such refresh a tie,
    // which defaulted to keeping prior (correct for the test above, where
    // PRIOR held the fresher out-of-band update) but wrong here, where the
    // refresh is itself the incoming `next` write and got discarded,
    // leaving the cached chip status stuck forever.
    it('accepts a status refresh arriving as the write itself, even though linkedAt is unchanged', () => {
        const store = makeStore()
        const stalePrRef = { kind: 'github_pr', url: 'https://github.com/acme/repo/pull/9', repo: 'acme/repo', number: 9, linkedAt: 5, role: 'primary', statusCheckedAt: 100 }
        const session = store.sessions.getOrCreateSession(
            'accept-status-refresh-same-linkedat',
            { path: '/tmp/project', host: 'example', externalRefs: [stalePrRef] },
            null,
            'default'
        )

        const freshPrRef = { kind: 'github_pr', url: 'https://github.com/acme/repo/pull/9', repo: 'acme/repo', number: 9, linkedAt: 5, role: 'primary', statusCheckedAt: 200 }
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [freshPrRef] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([freshPrRef])
    })

    it('still applies a legitimate re-link with a bumped linkedAt over the prior entry', () => {
        const store = makeStore()
        const oldRef = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 1 }
        const session = store.sessions.getOrCreateSession(
            'relink-bumps-linkedat',
            { path: '/tmp/project', host: 'example', externalRefs: [oldRef] },
            null,
            'default'
        )

        const newRef = { kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1', repo: 'acme/repo', number: 1, linkedAt: 2 }
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', externalRefs: [newRef] },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = getMetadata(store, session.id)
        expect(metadata?.externalRefs).toEqual([newRef])
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

describe('replaceSessionTodos: watermark ratchet (PR #897 rewind race)', () => {
    it('advances todosUpdatedAt past the prior write even when rebuilding older content', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'rewind-todos-watermark',
            { path: '/tmp/project' },
            null,
            'default'
        )

        const priorAt = 1_700_000_000_000
        const lateTodos = [{ content: 'late', status: 'pending', activeForm: 'doing late' }]
        const earlyTodos = [{ content: 'early', status: 'pending', activeForm: 'doing early' }]

        expect(store.sessions.setSessionTodos(session.id, lateTodos, priorAt, 'default')).toBe(true)
        expect(store.sessions.getSession(session.id)?.todosUpdatedAt).toBe(priorAt)

        // Rewind would otherwise stamp the remaining TodoWrite's older createdAt.
        expect(store.sessions.replaceSessionTodos(session.id, earlyTodos, 'default')).toBe(true)

        const after = store.sessions.getSession(session.id)
        expect(after?.todosUpdatedAt).toBe(priorAt + 1)
        expect(after?.todos).toEqual(earlyTodos)

        // A lagged pre-rewind structured patch using priorAt must lose the
        // store-side monotonic write too (defense in depth vs SSE gate).
        expect(store.sessions.setSessionTodos(session.id, lateTodos, priorAt, 'default')).toBe(false)
        expect(store.sessions.getSession(session.id)?.todos).toEqual(earlyTodos)

        store.close()
    })

    it('stamps Date.now() when replacing into a null watermark', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'rewind-todos-null-watermark',
            { path: '/tmp/project' },
            null,
            'default'
        )

        const before = Date.now()
        expect(store.sessions.replaceSessionTodos(
            session.id,
            [{ content: 'only', status: 'pending', activeForm: 'doing' }],
            'default'
        )).toBe(true)
        const after = store.sessions.getSession(session.id)
        expect(after?.todosUpdatedAt).toBeGreaterThanOrEqual(before)
        expect(after?.todosUpdatedAt).toBeLessThanOrEqual(Date.now())

        store.close()
    })

    it('clears todos while still ratcheting the watermark', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession(
            'rewind-todos-clear',
            { path: '/tmp/project' },
            null,
            'default'
        )

        expect(store.sessions.setSessionTodos(
            session.id,
            [{ content: 'gone', status: 'pending', activeForm: 'going' }],
            50,
            'default'
        )).toBe(true)

        expect(store.sessions.replaceSessionTodos(session.id, null, 'default')).toBe(true)
        const after = store.sessions.getSession(session.id)
        expect(after?.todos).toBeNull()
        expect(after?.todosUpdatedAt).toBe(51)

        store.close()
    })
})

describe('updateSessionAgentState: updated_at (#1855)', () => {
    it('only advances updated_at when a new permission request arrives', () => {
        const store = makeStore()
        const session = store.sessions.getOrCreateSession('agent-state-recency', { path: '/tmp/p', host: 'h' }, null, 'default')
        const resetUpdatedAt = () => (store as unknown as { db: Database }).db
            .prepare('UPDATE sessions SET updated_at = 1000 WHERE id = ?').run(session.id)
        resetUpdatedAt()
        const update = (state: unknown, version: number) =>
            store.sessions.updateSessionAgentState(session.id, state, version, 'default')

        expect(update({ codexUsage: { primary: 1 }, requests: {} }, 1).result).toBe('success')
        expect(store.sessions.getSession(session.id)?.updatedAt).toBe(1000)

        expect(update({ requests: { r1: { tool: 'Bash', arguments: {} } } }, 2).result).toBe('success')
        const touched = store.sessions.getSession(session.id)?.updatedAt ?? 0
        expect(touched).toBeGreaterThan(1000)

        resetUpdatedAt()
        expect(update({ requests: {}, completedRequests: { r1: { tool: 'Bash', arguments: {}, status: 'approved' } } }, 3).result).toBe('success')
        expect(store.sessions.getSession(session.id)?.updatedAt).toBe(1000)
        expect(update({}, 3).result).toBe('version-mismatch')
    })
})
