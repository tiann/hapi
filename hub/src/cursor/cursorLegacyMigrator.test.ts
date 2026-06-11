/**
 * Unit tests for the legacy stream-json → ACP migrator (tiann/hapi#824).
 *
 * Strategy:
 *   - Real filesystem in a per-test tmpdir (cheaper than mocking node:fs)
 *   - Real bun:sqlite for the synthetic store fixture (the migrator reads
 *     meta.lastUsedModel directly)
 *   - MOCK agent acp via the createProbe dependency injection point. The
 *     mock probe records calls and returns scripted responses so we can
 *     exercise every branch without spawning a child process.
 *   - MOCK the hapi.db write via the updateSessionAfterMigrate dep.
 *
 * Covers:
 *   - happy path: cp + verify + flip + rm
 *   - --keep-source preserves the source after success
 *   - lastUsedModel round-trip
 *   - refusals: not a cursor session, already on ACP, no cursor session id,
 *     missing on-disk store, ACP target already exists, running without
 *     force-archive
 *   - rollback on session/load failure
 *   - rollback on session/prompt failure
 *   - rollback on metadata write failure
 *   - --force-archive-then-migrate archives a running session before proceeding
 *   - skipVerify path (load + prompt both skipped, no probe spawned)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { Metadata } from '@hapi/protocol/schemas'
import type { Session } from '@hapi/protocol/types'
import type { AcpRpcResponse } from './acpVerifyProbe'
import {
    AmbiguousLegacyStoreError,
    CursorLegacyMigrator,
    countLegacyStoreBlobs,
    findLegacyChatStore,
    listLegacyChatStoreCandidates,
    readLegacyMetaLastUsedModel,
    workspaceHashFromPath
} from './cursorLegacyMigrator'
import { buildSyntheticLegacyStore } from './fixtures/buildSyntheticLegacyStore'
/* ---------- mock probe ---------- */

interface ScriptedProbe {
    initializeResponse: AcpRpcResponse
    loadResponse: AcpRpcResponse
    loadNotificationCount: number
    promptResponse: AcpRpcResponse
    started: boolean
    stopped: boolean
    initializeCalls: number
    loadCalls: number
    promptCalls: number
}

function ok(result: Record<string, unknown> = {}): AcpRpcResponse {
    return { ok: true, result }
}

function err(message: string, code: number = -32602): AcpRpcResponse {
    return { ok: false, error: { code, message } }
}

function makeMockProbe(overrides: Partial<ScriptedProbe> = {}): ScriptedProbe & {
    start(): void
    stop(): Promise<void>
    initialize(): Promise<AcpRpcResponse>
    loadSession(): Promise<{ response: AcpRpcResponse; notificationCount: number; notificationKinds: Record<string, number>; durationMs: number }>
    prompt(): Promise<{ response: AcpRpcResponse; durationMs: number }>
    setModel?(): Promise<AcpRpcResponse>
} {
    const state: ScriptedProbe = {
        initializeResponse: ok({ protocolVersion: 1 }),
        loadResponse: ok({ models: { availableModels: [], currentModelId: 'default[]' }, modes: { availableModes: [], currentModeId: 'agent' } }),
        loadNotificationCount: 17,
        promptResponse: ok({ stopReason: 'end_turn' }),
        started: false,
        stopped: false,
        initializeCalls: 0,
        loadCalls: 0,
        promptCalls: 0,
        ...overrides
    }
    return {
        ...state,
        start() { state.started = true },
        async stop() { state.stopped = true },
        async initialize() {
            state.initializeCalls += 1
            return state.initializeResponse
        },
        async loadSession() {
            state.loadCalls += 1
            return {
                response: state.loadResponse,
                notificationCount: state.loadResponse.ok ? state.loadNotificationCount : 0,
                notificationKinds: {},
                durationMs: 50
            }
        },
        async prompt() {
            state.promptCalls += 1
            return { response: state.promptResponse, durationMs: 30 }
        },
        get started() { return state.started },
        get stopped() { return state.stopped },
        get initializeCalls() { return state.initializeCalls },
        get loadCalls() { return state.loadCalls },
        get promptCalls() { return state.promptCalls }
    } as unknown as ScriptedProbe & ReturnType<typeof makeMockProbe>
}

/* ---------- test harness ---------- */

interface Harness {
    home: string
    tmp: string
    chatsDir: string
    acpSessionsDir: string
    /** Build a fake legacy session on disk; returns the on-disk path of store.db */
    placeLegacyStore: (cursorSessionId: string, opts?: { workspaceHash?: string; lastUsedModel?: string; name?: string }) => string
    /** Make an in-memory Session row in the cursor flavor */
    makeSession: (overrides?: Partial<Session>) => Session
    updateCalls: Array<{ sessionId: string; namespace: string; lastUsedModel: string | null }>
    archiveCalls: string[]
    probes: ReturnType<typeof makeMockProbe>[]
    nextProbe: ReturnType<typeof makeMockProbe> | null
}

function makeHarness(): Harness {
    const home = mkdtempSync(join(tmpdir(), 'hapi-migrator-test-home-'))
    const tmp = mkdtempSync(join(tmpdir(), 'hapi-migrator-test-tmp-'))
    const chatsDir = join(home, '.cursor', 'chats')
    const acpSessionsDir = join(home, '.cursor', 'acp-sessions')
    mkdirSync(chatsDir, { recursive: true })
    mkdirSync(acpSessionsDir, { recursive: true })

    const updateCalls: Harness['updateCalls'] = []
    const archiveCalls: Harness['archiveCalls'] = []
    const probes: Harness['probes'] = []
    return {
        home,
        tmp,
        chatsDir,
        acpSessionsDir,
        updateCalls,
        archiveCalls,
        probes,
        nextProbe: null,
        placeLegacyStore(cursorSessionId, opts = {}) {
            const wsh = opts.workspaceHash ?? `wsh-${Math.random().toString(36).slice(2, 10)}`
            const dir = join(chatsDir, wsh, cursorSessionId)
            mkdirSync(dir, { recursive: true })
            const storePath = join(dir, 'store.db')
            buildSyntheticLegacyStore({
                path: storePath,
                name: opts.name,
                lastUsedModel: opts.lastUsedModel
            })
            return storePath
        },
        makeSession(overrides = {}) {
            const sessionId = overrides.id ?? `sess-${Math.random().toString(36).slice(2, 8)}`
            const cursorSessionId = (overrides.metadata as Metadata | undefined)?.cursorSessionId
                ?? `cursor-${Math.random().toString(36).slice(2, 8)}`
            const metadata: Metadata = {
                path: '/workspace/example',
                host: 'test-host',
                flavor: 'cursor',
                cursorSessionId,
                ...(overrides.metadata ?? {})
            }
            const base: Session = {
                id: sessionId,
                tag: sessionId,
                namespace: 'default',
                createdAt: 0,
                updatedAt: 0,
                seq: 0,
                metadataVersion: 1,
                agentStateVersion: 1,
                metadata,
                active: false,
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: undefined,
                collaborationMode: null,
                agentState: null,
                todos: null,
                todosUpdatedAt: null,
                teamState: null,
                teamStateUpdatedAt: null
            } as unknown as Session
            return { ...base, ...overrides, metadata }
        }
    }
}

function cleanupHarness(h: Harness): void {
    try { rmSync(h.home, { recursive: true, force: true }) } catch {}
    try { rmSync(h.tmp, { recursive: true, force: true }) } catch {}
}

function makeMigrator(h: Harness, probe: ReturnType<typeof makeMockProbe> | null, opts: { archiveSession?: (id: string) => Promise<void>; updateOverride?: (sessionId: string, namespace: string, lastUsedModel: string | null) => { ok: true } | { ok: false; reason: 'version_mismatch_or_missing' } | { ok: false; reason: 'session_active' }; isAgentAcpTransportActive?: () => { active: boolean; holderPid: number | null }; getCurrentSession?: (sessionId: string, namespace: string) => { active: boolean; lifecycleState?: string; cursorSessionProtocol?: string } | null; acquireAcpActiveLock?: () => { release(): void } | null; checkpointLegacyStore?: (storeDbPath: string) => void; getHapiMessageCount?: (sessionId: string, namespace: string) => number } = {}): CursorLegacyMigrator {
    return new CursorLegacyMigrator({}, {
        homeDir: () => h.home,
        hostName: () => 'h', // matches the test sessions' metadata.host
        tmpDir: () => h.tmp,
        now: () => 1_700_000_000_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createProbe: () => (probe ?? makeMockProbe()) as any,
        awaitLockRelease: async () => true,
        // Default to "no ACP transport active" so the migrator does not
        // accidentally refuse on a real-world HAPI_HOME that happens to have
        // a live lock during the test run (e.g. running on the operator's
        // own machine while the dogfood agent is active).
        isAgentAcpTransportActive: opts.isAgentAcpTransportActive ?? (() => ({ active: false, holderPid: null })),
        // Default: acquire returns a no-op handle (we control the live
        // lock check via isAgentAcpTransportActive instead). Tests
        // simulating "lock unavailable" can return null here directly.
        // Codex review #34 P2 v7.
        acquireAcpActiveLock: opts.acquireAcpActiveLock ?? (() => ({ release() {} })),
        // Default: no-op checkpoint. The real bun:sqlite checkpoint is
        // exercised in integration tests; unit tests inject custom
        // implementations to simulate post-checkpoint WAL growth.
        // Codex review #34 P2 v8.
        checkpointLegacyStore: opts.checkpointLegacyStore ?? (() => {}),
        getCurrentSession: opts.getCurrentSession,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        archiveSession: opts.archiveSession ?? (async (id) => { h.archiveCalls.push(id) }),
        updateSessionAfterMigrate: opts.updateOverride ?? ((sessionId, namespace, lastUsedModel) => {
            h.updateCalls.push({ sessionId, namespace, lastUsedModel })
            return { ok: true }
        }),
        getHapiMessageCount: opts.getHapiMessageCount
    })
}

/* ---------- tests ---------- */

describe('findLegacyChatStore', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('finds the store.db under ~/.cursor/chats/<wsh>/<uuid>/', () => {
        const storePath = h.placeLegacyStore('my-uuid', { workspaceHash: 'wsh-1' })
        const found = findLegacyChatStore('my-uuid', h.home)
        expect(found).not.toBeNull()
        expect(found?.storeDbPath).toBe(storePath)
        expect(found?.workspaceHash).toBe('wsh-1')
    })

    it('returns null when the chat does not exist on disk', () => {
        const found = findLegacyChatStore('non-existent-uuid', h.home)
        expect(found).toBeNull()
    })

    it('returns null when ~/.cursor/chats itself does not exist', () => {
        rmSync(join(h.home, '.cursor'), { recursive: true, force: true })
        const found = findLegacyChatStore('whatever', h.home)
        expect(found).toBeNull()
    })

    it('scans multiple workspace-hash dirs to find the matching uuid', () => {
        h.placeLegacyStore('uuid-a', { workspaceHash: 'wsh-a' })
        h.placeLegacyStore('uuid-b', { workspaceHash: 'wsh-b' })
        const found = findLegacyChatStore('uuid-b', h.home)
        expect(found?.workspaceHash).toBe('wsh-b')
    })

    // tiann/hapi#872 — path-priority + ambiguity behaviour added to guard
    // against the #844 regression where the same cursorSessionId in 2+
    // workspace-hash drawers silently picked the first readdir match.

    it('regression guard: single drawer still resolves with no canonical-path hint', () => {
        h.placeLegacyStore('reg-uuid', { workspaceHash: 'wsh-only' })
        const found = findLegacyChatStore('reg-uuid', h.home)
        expect(found?.workspaceHash).toBe('wsh-only')
    })

    it('canonical workspace path wins over any readdir-order match (tiann/hapi#872)', () => {
        const canonical = '/coding/hapi'
        const canonicalHash = workspaceHashFromPath(canonical)
        // Plant the SAME cursorSessionId under three workspace-hash drawers.
        // The canonical hash for `canonical` is one of them; the other two
        // are stale siblings.
        h.placeLegacyStore('same-uuid', { workspaceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
        h.placeLegacyStore('same-uuid', { workspaceHash: canonicalHash })
        h.placeLegacyStore('same-uuid', { workspaceHash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' })
        const found = findLegacyChatStore('same-uuid', h.home, canonical)
        expect(found).not.toBeNull()
        expect(found?.workspaceHash).toBe(canonicalHash)
    })

    it('throws AmbiguousLegacyStoreError when 3+ drawers exist and no canonical match (tiann/hapi#872)', () => {
        h.placeLegacyStore('amb-uuid', { workspaceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
        h.placeLegacyStore('amb-uuid', { workspaceHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
        h.placeLegacyStore('amb-uuid', { workspaceHash: 'cccccccccccccccccccccccccccccccc' })
        // Pass a canonical workspace path that does NOT correspond to any
        // of the planted drawers — falls through to readdir scan.
        let caught: unknown
        try {
            findLegacyChatStore('amb-uuid', h.home, '/some/unrelated/cwd')
        } catch (e) {
            caught = e
        }
        expect(caught).toBeInstanceOf(AmbiguousLegacyStoreError)
        const err = caught as AmbiguousLegacyStoreError
        expect(err.cursorSessionId).toBe('amb-uuid')
        expect(err.candidates).toHaveLength(3)
        const hashes = err.candidates.map((c) => c.workspaceHash).sort()
        expect(hashes).toEqual([
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            'cccccccccccccccccccccccccccccccc'
        ])
        for (const c of err.candidates) {
            expect(typeof c.sizeBytes).toBe('number')
            expect(c.sizeBytes).toBeGreaterThan(0)
            expect(typeof c.mtimeMs).toBe('number')
        }
    })

    it('throws AmbiguousLegacyStoreError when 2+ drawers exist and no canonical path is supplied (tiann/hapi#872)', () => {
        h.placeLegacyStore('amb-noarg', { workspaceHash: 'wsh-1-noarg' })
        h.placeLegacyStore('amb-noarg', { workspaceHash: 'wsh-2-noarg' })
        let caught: unknown
        try {
            findLegacyChatStore('amb-noarg', h.home)
        } catch (e) {
            caught = e
        }
        expect(caught).toBeInstanceOf(AmbiguousLegacyStoreError)
        expect((caught as AmbiguousLegacyStoreError).candidates).toHaveLength(2)
    })

    it('canonical-path hint resolves cleanly even when ambiguity exists', () => {
        const canonical = '/workspace/canon'
        const canonicalHash = workspaceHashFromPath(canonical)
        h.placeLegacyStore('amb-resolved', { workspaceHash: 'wsh-stale-1' })
        h.placeLegacyStore('amb-resolved', { workspaceHash: canonicalHash })
        h.placeLegacyStore('amb-resolved', { workspaceHash: 'wsh-stale-2' })
        expect(() => findLegacyChatStore('amb-resolved', h.home, canonical)).not.toThrow()
        const found = findLegacyChatStore('amb-resolved', h.home, canonical)
        expect(found?.workspaceHash).toBe(canonicalHash)
    })

    it('listLegacyChatStoreCandidates enumerates every drawer (used by transplant diagnostic log)', () => {
        h.placeLegacyStore('list-uuid', { workspaceHash: 'wsh-1' })
        h.placeLegacyStore('list-uuid', { workspaceHash: 'wsh-2' })
        const candidates = listLegacyChatStoreCandidates('list-uuid', h.home)
        expect(candidates.map((c) => c.workspaceHash).sort()).toEqual(['wsh-1', 'wsh-2'])
        for (const c of candidates) {
            expect(c.sizeBytes).toBeGreaterThan(0)
        }
    })

    it('workspaceHashFromPath returns a 32-char lowercase hex md5', () => {
        const hash = workspaceHashFromPath('/coding/hapi')
        expect(hash).toMatch(/^[0-9a-f]{32}$/)
    })

    /**
     * Pins the algorithm contract: workspace-hash is plain md5 of the raw
     * absolute path bytes, no normalization. Reference values were
     * independently computed via `printf '%s' <path> | md5sum`. A future
     * refactor that adds path.resolve() or trims trailing slashes would
     * change these and silently break Cursor's drawer naming - Cursor
     * uses raw md5 on whatever absolute path the session was opened
     * under. tiann/hapi#873 cold review.
     */
    it('workspaceHashFromPath matches independently-computed md5 (raw, no normalization)', () => {
        // Reference values computed via `printf '%s' <path> | md5sum`.
        expect(workspaceHashFromPath('/home/user/project')).toBe('90722f2638004be06d790eaac9ac1f8a')
        expect(workspaceHashFromPath('/workspace/example')).toBe('56512a070a25878a45bf0c1a46021ad9')
        expect(workspaceHashFromPath('/tmp/x')).toBe('7ae3976faedb45a92335f73e4d7bb9e5')
        // Trailing slash MUST yield a different hash (else /foo and /foo/
        // would collide on disk, which Cursor's layout does not allow).
        const noSlash = workspaceHashFromPath('/workspace/example')
        const withSlash = workspaceHashFromPath('/workspace/example/')
        expect(noSlash).not.toBe(withSlash)
    })

    it('rejects path-traversal cursorSessionId inputs at the function boundary (tiann/hapi#872 cold review)', () => {
        // External callers may bypass preflightSession; the function must
        // not statSync arbitrary paths when fed a malformed id. All of the
        // following must return null (and never throw / never probe).
        for (const id of ['..', '.', '../etc', '/etc/passwd', 'a/b', 'a/../b']) {
            expect(findLegacyChatStore(id, h.home, '/coding/hapi')).toBeNull()
            expect(findLegacyChatStore(id, h.home)).toBeNull()
        }
    })
})

describe('readLegacyMetaLastUsedModel', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('reads hex-encoded JSON meta record (legacy encoding)', () => {
        const p = join(h.tmp, 'legacy.db')
        buildSyntheticLegacyStore({ path: p, lastUsedModel: 'composer-2.5', name: 'chat 1', metaEncoding: 'hex' })
        const out = readLegacyMetaLastUsedModel(p)
        expect(out).not.toBeNull()
        expect(out?.lastUsedModel).toBe('composer-2.5')
        expect(out?.name).toBe('chat 1')
    })

    it('reads raw JSON meta record (newer encoding)', () => {
        const p = join(h.tmp, 'newer.db')
        buildSyntheticLegacyStore({ path: p, lastUsedModel: 'gpt-5.3-codex', metaEncoding: 'json' })
        const out = readLegacyMetaLastUsedModel(p)
        expect(out?.lastUsedModel).toBe('gpt-5.3-codex')
    })

    it('returns null on a missing store', () => {
        const out = readLegacyMetaLastUsedModel(join(h.tmp, 'does-not-exist.db'))
        expect(out).toBeNull()
    })
})

describe('CursorLegacyMigrator.migrateOne — refusals', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('refuses non-cursor sessions', async () => {
        const session = h.makeSession({ metadata: { path: '/x', host: 'h', flavor: 'claude' } as Metadata })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.reason).toBe('not_cursor_session')
    })

    it('refuses already-ACP sessions', async () => {
        const session = h.makeSession({
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId: 'u', cursorSessionProtocol: 'acp' }
        })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.reason).toBe('already_acp')
    })

    it('refuses sessions with no cursorSessionId', async () => {
        const session = h.makeSession({
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId: undefined as unknown as string }
        })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.reason).toBe('no_cursor_session_id')
    })

    it('refuses sessions whose lifecycleState is "running" without forceArchiveRunning', async () => {
        const session = h.makeSession({
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId: 'u', lifecycleState: 'running' }
        })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.reason).toBe('running_refused')
    })

    it('refuses sessions where session.active=true even without lifecycleState (Codex #34 P2)', async () => {
        const session = h.makeSession({
            active: true,
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId: 'u' }
        })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.reason).toBe('running_refused')
    })

    it('refuses cursorSessionId values that fail basename validation (Codex #34 P2)', async () => {
        for (const bad of ['../escape', 'has/slash', '.', '..', 'has\\backslash']) {
            const session = h.makeSession({
                metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId: bad }
            })
            const out = await makeMigrator(h, null).migrateOne(session, {})
            expect(out.ok).toBe(false)
            if (!out.ok) expect(out.reason).toBe('no_cursor_session_id')
        }
    })

    it('refuses sessions recorded on a different host (Codex #34 P2)', async () => {
        const session = h.makeSession({
            metadata: { path: '/x', host: 'other-machine', flavor: 'cursor', cursorSessionId: 'a' }
        })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('cross_host_session')
        expect(out.message).toContain('other-machine')
    })

    it('refuses when the legacy on-disk store is missing', async () => {
        const session = h.makeSession({
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId: 'ghost-uuid' }
        })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.reason).toBe('no_legacy_store_on_disk')
    })

    it('refuses when another agent acp transport is live (Codex #34 P1 / P2 v7)', async () => {
        const cursorSessionId = 'acp-active-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            // Codex review #34 P2 v7: lock acquisition is the primary
            // refuse-on signal now. isAgentAcpTransportActive is read
            // only to format the holder pid in the refusal message.
            acquireAcpActiveLock: () => null,
            isAgentAcpTransportActive: () => ({ active: true, holderPid: 12345 })
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('acp_transport_active')
        expect(out.message).toContain('12345')
        // Source untouched.
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
    })

    it('refuses when ~/.cursor/acp-sessions/<uuid>/ already exists (collision)', async () => {
        const cursorSessionId = 'collision-uuid'
        h.placeLegacyStore(cursorSessionId)
        mkdirSync(join(h.acpSessionsDir, cursorSessionId), { recursive: true })
        writeFileSync(join(h.acpSessionsDir, cursorSessionId, 'meta.json'), '{}')
        const session = h.makeSession({
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, null).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.reason).toBe('target_already_exists')
    })
})

describe('CursorLegacyMigrator.migrateOne — happy path', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('cp + verify + flip + rm in order; populates outcome', async () => {
        const cursorSessionId = 'happy-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId, { lastUsedModel: 'composer-2.5' })
        const probe = makeMockProbe()
        const session = h.makeSession({
            id: 'happy-sess',
            metadata: { path: '/workspace/example', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, probe).migrateOne(session, {})
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.acpSessionId).toBe(cursorSessionId)
        expect(out.replayNotifications).toBe(17)
        expect(out.lastUsedModelPreserved).toBe('composer-2.5')
        expect(out.sourceRemoved).toBe(true)

        // ACP location populated.
        const acpStorePath = join(h.acpSessionsDir, cursorSessionId, 'store.db')
        expect(existsSync(acpStorePath)).toBe(true)
        const sidecarPath = join(h.acpSessionsDir, cursorSessionId, 'meta.json')
        expect(existsSync(sidecarPath)).toBe(true)
        const sidecarText = require('node:fs').readFileSync(sidecarPath, 'utf8') as string
        const sidecarObj = JSON.parse(sidecarText) as Record<string, unknown>
        expect(sidecarObj.schemaVersion).toBe(1)
        expect(sidecarObj.cwd).toBe('/workspace/example')

        // Legacy source removed.
        expect(existsSync(sourceStore)).toBe(false)

        // updateSessionAfterMigrate invoked.
        expect(h.updateCalls).toHaveLength(1)
        expect(h.updateCalls[0].sessionId).toBe('happy-sess')
        expect(h.updateCalls[0].lastUsedModel).toBe('composer-2.5')

        // Probe used.
        expect(probe.started).toBe(true)
        expect(probe.stopped).toBe(true)
        expect(probe.initializeCalls).toBe(1)
        expect(probe.loadCalls).toBe(1)
        expect(probe.promptCalls).toBe(1)
    })

    it('passes HOME and HAPI_HOME isolated to the fakeHome into the verify probe (tiann/hapi#824)', async () => {
        // tiann/hapi#824: the verify probe must inherit a private HAPI_HOME
        // so its child `agent acp` registers its lock in an isolated tmp dir
        // — NOT in the host's $HAPI_HOME where peer agents may hold the
        // global agent-acp-active lock. Without this isolation the auto-
        // migration path on a busy machine would always refuse with
        // acp_transport_active, defeating its own purpose.
        const cursorSessionId = 'isolated-home-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/iso', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        let capturedEnv: NodeJS.ProcessEnv | null = null
        const migrator = new CursorLegacyMigrator({}, {
            homeDir: () => h.home,
            hostName: () => 'h',
            tmpDir: () => h.tmp,
            now: () => 1_700_000_000_000,
            createProbe: (env) => {
                capturedEnv = env
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return makeMockProbe() as any
            },
            awaitLockRelease: async () => true,
            isAgentAcpTransportActive: () => ({ active: false, holderPid: null }),
            acquireAcpActiveLock: () => ({ release() {} }),
            checkpointLegacyStore: () => {},
            getCurrentSession: () => null,
            logger: { debug() {}, info() {}, warn() {}, error() {} },
            archiveSession: async (id) => { h.archiveCalls.push(id) },
            updateSessionAfterMigrate: () => ({ ok: true })
        })
        const out = await migrator.migrateOne(session, {})
        expect(out.ok).toBe(true)
        expect(capturedEnv).not.toBeNull()
        const env = capturedEnv as unknown as NodeJS.ProcessEnv
        // The fakeHome path is generated inside verifyInTempHome under
        // h.tmp; we don't need its exact value, only that HOME and
        // HAPI_HOME point at the same path and that path is under our
        // temp root (i.e. NOT the operator's real $HOME or $HAPI_HOME).
        expect(typeof env.HOME).toBe('string')
        expect(typeof env.HAPI_HOME).toBe('string')
        expect(env.HOME).toBe(env.HAPI_HOME)
        expect(env.HOME!.startsWith(h.tmp)).toBe(true)
        // Defence in depth: the captured env must NOT leak the host's
        // real HAPI_HOME (which could point at ~/.hapi or /tmp/hapi).
        const realHapiHome = process.env.HAPI_HOME?.trim() || ''
        if (realHapiHome.length > 0) {
            expect(env.HAPI_HOME).not.toBe(realHapiHome)
        }
    })

    it('passes metadata.homeDir (NOT deps.homeDir) as agentLookupHome to the verify probe (tiann/hapi#844)', async () => {
        // tiann/hapi#844 upstream Codex Major: the default createProbe factory
        // used `this.deps.homeDir()` for `agentLookupHome`, which on service-
        // account hub deployments resolves to the hub user's $HOME — but the
        // legacy store lives under the human user's home (metadata.homeDir).
        // Earlier rounds wired `agentLookupHome` into the factory default
        // but never threaded the resolved sourceHome through, so verification
        // silently looked up `agent` under the wrong home and migrations
        // fell back to legacy. The fix: createProbe takes a 2nd arg, and
        // verifyInTempHome passes opts.sourceHome through.
        const userHome = mkdtempSync(join(tmpdir(), 'hapi-migrator-user-home-'))
        try {
            const hubHome = h.home // distinct from userHome
            const cursorSessionId = 'service-account-uuid'
            const userChatsDir = join(userHome, '.cursor', 'chats', 'wsh-svc', cursorSessionId)
            mkdirSync(userChatsDir, { recursive: true })
            const sourceStore = join(userChatsDir, 'store.db')
            buildSyntheticLegacyStore({ path: sourceStore })
            const userAcpDir = join(userHome, '.cursor', 'acp-sessions')
            mkdirSync(userAcpDir, { recursive: true })
            const session = h.makeSession({
                metadata: {
                    path: '/workspace/svc',
                    host: 'h',
                    flavor: 'cursor',
                    cursorSessionId,
                    homeDir: userHome
                }
            })
            let capturedAgentLookupHome: string | null = null
            const migrator = new CursorLegacyMigrator({}, {
                homeDir: () => hubHome,
                hostName: () => 'h',
                tmpDir: () => h.tmp,
                now: () => 1_700_000_000_000,
                createProbe: (_env, agentLookupHome) => {
                    capturedAgentLookupHome = agentLookupHome
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return makeMockProbe() as any
                },
                awaitLockRelease: async () => true,
                isAgentAcpTransportActive: () => ({ active: false, holderPid: null }),
                acquireAcpActiveLock: () => ({ release() {} }),
                checkpointLegacyStore: () => {},
                getCurrentSession: () => null,
                logger: { debug() {}, info() {}, warn() {}, error() {} },
                archiveSession: async (id) => { h.archiveCalls.push(id) },
                updateSessionAfterMigrate: () => ({ ok: true })
            })
            const out = await migrator.migrateOne(session, {})
            expect(out.ok).toBe(true)
            expect(capturedAgentLookupHome as unknown as string).toBe(userHome)
            expect(capturedAgentLookupHome as unknown as string).not.toBe(hubHome)
        } finally {
            try { rmSync(userHome, { recursive: true, force: true }) } catch {}
        }
    })

    it('falls back to deps.homeDir() for agentLookupHome when metadata.homeDir is absent (legacy session records)', async () => {
        // Older session records may lack metadata.homeDir (the field was added
        // in a later CLI rev). For those, the migrator falls back to
        // this.deps.homeDir() for both the store lookup AND agentLookupHome.
        const cursorSessionId = 'no-metadata-home-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/legacy', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        let capturedAgentLookupHome: string | null = null
        const migrator = new CursorLegacyMigrator({}, {
            homeDir: () => h.home,
            hostName: () => 'h',
            tmpDir: () => h.tmp,
            now: () => 1_700_000_000_000,
            createProbe: (_env, agentLookupHome) => {
                capturedAgentLookupHome = agentLookupHome
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return makeMockProbe() as any
            },
            awaitLockRelease: async () => true,
            isAgentAcpTransportActive: () => ({ active: false, holderPid: null }),
            acquireAcpActiveLock: () => ({ release() {} }),
            checkpointLegacyStore: () => {},
            getCurrentSession: () => null,
            logger: { debug() {}, info() {}, warn() {}, error() {} },
            archiveSession: async (id) => { h.archiveCalls.push(id) },
            updateSessionAfterMigrate: () => ({ ok: true })
        })
        const out = await migrator.migrateOne(session, {})
        expect(out.ok).toBe(true)
        expect(capturedAgentLookupHome as unknown as string).toBe(h.home)
    })

    it('--keep-source preserves the legacy source after success', async () => {
        const cursorSessionId = 'keep-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, { keepSource: true })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.sourceRemoved).toBe(false)
        expect(existsSync(sourceStore)).toBe(true)
    })

    it('skipVerify skips ONLY the session/prompt step (load is still verified)', async () => {
        const cursorSessionId = 'skipverify-uuid'
        h.placeLegacyStore(cursorSessionId)
        const probe = makeMockProbe()
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, probe).migrateOne(session, { skipVerify: true })
        expect(out.ok).toBe(true)
        // Codex review #34 P2: load must still run; only the prompt step is skipped.
        expect(probe.started).toBe(true)
        expect(probe.initializeCalls).toBe(1)
        expect(probe.loadCalls).toBe(1)
        expect(probe.promptCalls).toBe(0)
    })

    it('skipVerify still refuses on session/load failure', async () => {
        const cursorSessionId = 'skipverify-loadfail-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const probe = makeMockProbe({ loadResponse: err('corrupted store') })
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, probe).migrateOne(session, { skipVerify: true })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('verify_load_failed')
        // Source untouched.
        expect(existsSync(sourceStore)).toBe(true)
    })

    it('lastUsedModel = null when the legacy meta record does not carry one', async () => {
        const cursorSessionId = 'no-model-uuid'
        h.placeLegacyStore(cursorSessionId) // no lastUsedModel
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.lastUsedModelPreserved).toBeNull()
        expect(h.updateCalls[0].lastUsedModel).toBeNull()
    })
})

describe('CursorLegacyMigrator.migrateOne — ambiguous source store (tiann/hapi#872)', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('canonical workspace path on session.metadata.path picks the right drawer when others have the same uuid', async () => {
        const cursorSessionId = 'pick-canonical-uuid'
        const canonicalCwd = '/workspace/example'
        const canonicalHash = workspaceHashFromPath(canonicalCwd)
        // Plant the REAL store under the canonical drawer; siblings have
        // smaller decoy stores.
        const realStore = h.placeLegacyStore(cursorSessionId, { workspaceHash: canonicalHash, name: 'real chat' })
        h.placeLegacyStore(cursorSessionId, { workspaceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
        h.placeLegacyStore(cursorSessionId, { workspaceHash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' })
        const session = h.makeSession({
            metadata: { path: canonicalCwd, host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
        expect(out.ok).toBe(true)
        if (!out.ok) return
        // Real store removed (proves the canonical drawer was the source).
        expect(existsSync(realStore)).toBe(false)
        // ACP target placed and intact.
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId, 'store.db'))).toBe(true)
    })

    it('refuses ambiguous_legacy_store when 3 drawers exist and no canonical path matches', async () => {
        const cursorSessionId = 'ambig-uuid'
        const storeA = h.placeLegacyStore(cursorSessionId, { workspaceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
        const storeB = h.placeLegacyStore(cursorSessionId, { workspaceHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
        const storeC = h.placeLegacyStore(cursorSessionId, { workspaceHash: 'cccccccccccccccccccccccccccccccc' })
        const session = h.makeSession({
            // canonical path does NOT hash to any of the planted drawers
            metadata: { path: '/workspace/unrelated', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('ambiguous_legacy_store')
        expect(out.message).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        expect(out.message).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        expect(out.message).toContain('cccccccccccccccccccccccccccccccc')
        // No transplant happened.
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
        // All three sources untouched.
        expect(existsSync(storeA)).toBe(true)
        expect(existsSync(storeB)).toBe(true)
        expect(existsSync(storeC)).toBe(true)
    })

    it('proceeds when 3 drawers exist but canonical path resolves to one of them', async () => {
        const cursorSessionId = 'ambig-resolved-uuid'
        const canonicalCwd = '/workspace/resolved'
        const canonicalHash = workspaceHashFromPath(canonicalCwd)
        const realStore = h.placeLegacyStore(cursorSessionId, { workspaceHash: canonicalHash })
        h.placeLegacyStore(cursorSessionId, { workspaceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
        h.placeLegacyStore(cursorSessionId, { workspaceHash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' })
        const session = h.makeSession({
            metadata: { path: canonicalCwd, host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
        expect(out.ok).toBe(true)
        // Only the canonical drawer's source got removed; the other two siblings stay.
        expect(existsSync(realStore)).toBe(false)
    })
})

describe('CursorLegacyMigrator.migrateOne — size sanity (tiann/hapi#872)', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('refuses with size_mismatch when HAPI has > 100 messages and candidate has <messageCount/4 blobs', async () => {
        const cursorSessionId = 'sm-tiny-uuid'
        // Synthetic store has a tiny number of blobs (single seed row).
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getHapiMessageCount: () => 6000
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('size_mismatch')
        expect(out.message).toMatch(/HAPI tracks 6000 message/)
        // Source untouched, no ACP placement.
        expect(existsSync(sourceStore)).toBe(true)
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
    })

    it('proceeds when candidate blob count meets the messageCount/4 floor', async () => {
        const cursorSessionId = 'sm-big-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        // Pad the source store's blobs table to clear the floor. The
        // synthetic store ships `blobs(id TEXT PRIMARY KEY, data BLOB)`
        // with zero rows; insert enough decoy rows to satisfy the
        // migrator's sanity check without changing the on-disk layout
        // in any way the migrator cares about.
        const Database = require('bun:sqlite').Database
        const padDb = new Database(sourceStore, { readwrite: true })
        try {
            padDb.exec('BEGIN')
            const stmt = padDb.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
            for (let i = 0; i < 200; i += 1) {
                stmt.run(`pad-${i}-${Math.random()}`, Buffer.from([0]))
            }
            padDb.exec('COMMIT')
        } finally {
            padDb.close()
        }
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getHapiMessageCount: () => 600 // floor = 150; padded blobs > 200
        }).migrateOne(session, {})
        expect(out.ok).toBe(true)
        if (!out.ok) return
        // Sanity: source removed, target placed.
        expect(existsSync(sourceStore)).toBe(false)
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId, 'store.db'))).toBe(true)
    })

    it('skips the sanity check when HAPI message count is 0 (brand new session)', async () => {
        const cursorSessionId = 'sm-zero-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getHapiMessageCount: () => 0
        }).migrateOne(session, {})
        expect(out.ok).toBe(true)
    })

    it('skips the sanity check when the getHapiMessageCount dep is not wired', async () => {
        const cursorSessionId = 'sm-nodep-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        // No getHapiMessageCount override → dep undefined → check disabled.
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
        expect(out.ok).toBe(true)
    })

    it('skips the sanity check when getHapiMessageCount throws (fail-open)', async () => {
        const cursorSessionId = 'sm-throws-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getHapiMessageCount: () => { throw new Error('store unreadable') }
        }).migrateOne(session, {})
        expect(out.ok).toBe(true)
    })

    it('skips the sanity check when message count is exactly 100 (boundary; floor only kicks in above 100)', async () => {
        const cursorSessionId = 'sm-boundary-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getHapiMessageCount: () => 100
        }).migrateOne(session, {})
        expect(out.ok).toBe(true)
    })

    it('engages the sanity check when message count is 101 (first value above the skip threshold)', async () => {
        // The synthetic store has only a handful of blobs (well under
        // 101/4 = 25). messageCount=101 is the first value that lets the
        // floor kick in - this test pins the boundary contract so a
        // future refactor that moves the cutoff to >=100 or >100 is
        // caught by CI rather than a production session refusal.
        // tiann/hapi#873 cold review Nit.
        const cursorSessionId = 'sm-boundary-engaged-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getHapiMessageCount: () => 101
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('size_mismatch')
    })
})

describe('countLegacyStoreBlobs (tiann/hapi#872)', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('returns the blob row count for a real synthetic store', () => {
        const p = h.placeLegacyStore('blob-count-uuid')
        const n = countLegacyStoreBlobs(p)
        expect(typeof n).toBe('number')
        expect((n ?? -1) >= 0).toBe(true)
    })

    it('returns null when the store cannot be opened', () => {
        const n = countLegacyStoreBlobs(join(h.tmp, 'does-not-exist.db'))
        expect(n).toBeNull()
    })
})

describe('CursorLegacyMigrator.migrateOne — rollback paths', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('rolls back the ACP placement when session/load fails', async () => {
        const cursorSessionId = 'load-fail-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const probe = makeMockProbe({ loadResponse: err('Session not found') })
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, probe).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('verify_load_failed')

        // Acp dir not created (verify is in temp HOME, so the real acp-sessions
        // location was never touched).
        const acpStorePath = join(h.acpSessionsDir, cursorSessionId, 'store.db')
        expect(existsSync(acpStorePath)).toBe(false)
        // Source untouched.
        expect(existsSync(sourceStore)).toBe(true)
        // No hapi.db write.
        expect(h.updateCalls).toHaveLength(0)
    })

    it('rolls back when session/prompt fails', async () => {
        const cursorSessionId = 'prompt-fail-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const probe = makeMockProbe({ promptResponse: err('agent acp died') })
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, probe).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('verify_prompt_failed')
        expect(existsSync(sourceStore)).toBe(true)
        expect(h.updateCalls).toHaveLength(0)
    })

    it('rolls back when the session is resumed mid-migration (Codex #34 P1)', async () => {
        const cursorSessionId = 'resumed-mid-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getCurrentSession: () => ({ active: true, lifecycleState: 'running' })
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('session_resumed_during_migrate')
        // ACP placement rolled back.
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
        // Source untouched.
        expect(existsSync(sourceStore)).toBe(true)
    })

    it('does NOT trip the resume-race recheck on stale lifecycleState=running after our own archive (Codex #34 P2 v5)', async () => {
        // The force-archive flow archives synchronously (sets active=false)
        // but the cleanup metadata write that flips lifecycleState to
        // 'archived' may still be in-flight. The recheck must trust the
        // active flag, not lifecycleState.
        const cursorSessionId = 'stale-lifecycle-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            // Live runner at preflight (active=true), gets archived by us.
            active: true,
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId, lifecycleState: 'running' }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            archiveSession: async () => {},
            // After our archive: active=false (set by archive), but
            // lifecycleState is still 'running' because the metadata
            // cleanup write hasn't flushed yet. This should NOT refuse.
            getCurrentSession: () => ({ active: false, lifecycleState: 'running' })
        }).migrateOne(session, { forceArchiveRunning: true })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(h.updateCalls).toHaveLength(1)
    })

    it('still refuses the resume-race recheck when an EXTERNAL party set lifecycleState=running and wasActive=false (Codex #34 P2 v5)', async () => {
        // If we did NOT archive and lifecycleState becomes running,
        // someone else lifted the session back — that's a real race.
        const cursorSessionId = 'external-resume-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            // Session NOT active/running at preflight — passes precheck.
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getCurrentSession: () => ({ active: false, lifecycleState: 'running' })
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('session_resumed_during_migrate')
    })

    it('rolls back when the legacy store.db is touched during the migration window (Codex #34 P1 v3)', async () => {
        const cursorSessionId = 'fingerprint-divergence-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        // Override createProbe to mutate the legacy source between
        // checkpoint and the resume-race recheck.
        const probe = {
            ...makeMockProbe(),
            start() { /* no-op */ },
            async loadSession() {
                // Simulate a brief resume that wrote new turns to the
                // legacy store after our checkpoint.
                require('node:fs').appendFileSync(sourceStore, Buffer.from([0x00, 0x01, 0x02]))
                return { response: { ok: true as const, result: {} }, notificationCount: 0, notificationKinds: {}, durationMs: 1 }
            },
            async initialize() { return { ok: true as const, result: {} } },
            async prompt() { return { response: { ok: true as const, result: {} }, durationMs: 1 } },
            async stop() {},
            getStderr() { return '' },
            getNotifications() { return [] },
            clearNotifications() {}
        } as unknown as ReturnType<typeof makeMockProbe>
        const out = await makeMigrator(h, probe, {}).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('legacy_store_modified_during_migrate')
        expect(out.message).toMatch(/store\.db/)
        // ACP placement rolled back.
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
        // Source untouched.
        expect(existsSync(sourceStore)).toBe(true)
    })

    it('refuses early when WAL has content immediately after the checkpoint (Codex #34 P2 v8)', async () => {
        // Codex review #34 P2 v8: a TRUNCATE-mode wal_checkpoint zeros
        // the WAL. If a writer lands between checkpoint return and the
        // fingerprint capture, the WAL grows above zero and our baseline
        // would be poisoned (we copy main-file-only). The migrator must
        // refuse rather than accept the post-resume state.
        const cursorSessionId = 'wal-grew-post-checkpoint-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            // Simulate a writer landing in the gap: the checkpoint
            // "returned" but a WAL with content has appeared right
            // after — exactly the race the bot flagged.
            checkpointLegacyStore: (path) => {
                require('node:fs').writeFileSync(`${path}-wal`, Buffer.from([0xff, 0xff, 0xff, 0xff]))
            }
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('legacy_store_modified_during_migrate')
        expect(out.message).toMatch(/between checkpoint and fingerprint/)
        // No ACP placement, no source deletion.
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
        expect(existsSync(sourceStore)).toBe(true)
    })

    it('rolls back when a WAL sidecar appears during the migration window (Codex #34 P1 v4)', async () => {
        const cursorSessionId = 'wal-divergence-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        // Override createProbe to CREATE a store.db-wal sidecar where
        // none existed at fingerprint time. This is what a brief resume
        // does: opens the store, writes a frame to WAL.
        const probe = {
            ...makeMockProbe(),
            start() {},
            async loadSession() {
                require('node:fs').writeFileSync(`${sourceStore}-wal`, Buffer.from([0xff, 0xff, 0xff]))
                return { response: { ok: true as const, result: {} }, notificationCount: 0, notificationKinds: {}, durationMs: 1 }
            },
            async initialize() { return { ok: true as const, result: {} } },
            async prompt() { return { response: { ok: true as const, result: {} }, durationMs: 1 } },
            async stop() {},
            getStderr() { return '' },
            getNotifications() { return [] },
            clearNotifications() {}
        } as unknown as ReturnType<typeof makeMockProbe>
        const out = await makeMigrator(h, probe, {}).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('legacy_store_modified_during_migrate')
        expect(out.message).toMatch(/store\.db-wal/)
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
    })

    it('rolls back when the atomic flip-time active check fires (Codex #34 P1 v2)', async () => {
        // The migrator's earlier getCurrentSession recheck saw the session
        // as inactive (default null), but the inner updateSessionAfterMigrate
        // returns session_active — simulating the resume landing AFTER the
        // recheck but inside the atomic flip.
        const cursorSessionId = 'flip-time-active-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const migrator = makeMigrator(h, makeMockProbe(), {
            updateOverride: () => ({ ok: false, reason: 'session_active' })
        })
        const out = await migrator.migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('session_resumed_during_migrate')
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
        expect(existsSync(sourceStore)).toBe(true)
    })

    it('rolls back when a concurrent migration already flipped protocol to acp (Codex #34 P1)', async () => {
        const cursorSessionId = 'concurrent-flip-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            getCurrentSession: () => ({ active: false, cursorSessionProtocol: 'acp' })
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('already_acp')
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
        expect(existsSync(sourceStore)).toBe(true)
    })

    it('rolls back ACP placement when hapi.db metadata write fails', async () => {
        const cursorSessionId = 'meta-fail-uuid'
        const sourceStore = h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const migrator = makeMigrator(h, makeMockProbe(), {
            updateOverride: () => ({ ok: false, reason: 'version_mismatch_or_missing' })
        })
        const out = await migrator.migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('metadata_write_failed')
        // The ACP placement was rolled back.
        expect(existsSync(join(h.acpSessionsDir, cursorSessionId))).toBe(false)
        // Source untouched.
        expect(existsSync(sourceStore)).toBe(true)
    })
})

describe('CursorLegacyMigrator.migrateOne — force-archive-then-migrate', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('archives a running session first, then proceeds', async () => {
        const cursorSessionId = 'force-archive-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            // active=true triggers the archive RPC. Codex review #34
            // P2 v6: the lifecycleState alone is no longer enough.
            active: true,
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId, lifecycleState: 'running' }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, { forceArchiveRunning: true })
        expect(out.ok).toBe(true)
        expect(h.archiveCalls).toEqual([session.id])
    })

    it('does NOT call archiveSession on stale lifecycleState=running rows with no live runner (Codex #34 P2 v6)', async () => {
        const cursorSessionId = 'stale-running-no-archive-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            // lifecycle says running but cache.active is false — the
            // cleanup metadata write that flips 'running' → 'archived'
            // was dropped (process crash before write). There is no
            // live runner to archive.
            active: false,
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId, lifecycleState: 'running' }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, { forceArchiveRunning: true })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        // Critically: we did NOT call archive RPC. The metadata flip
        // itself cleans up the stale lifecycle value.
        expect(h.archiveCalls).toHaveLength(0)
    })

    it('does not archive when cross_host_session refusal would fire (Codex #34 P2 v2)', async () => {
        const cursorSessionId = 'cross-host-no-archive-uuid'
        h.placeLegacyStore(cursorSessionId)
        const archiveCalls: string[] = []
        const session = h.makeSession({
            // active=true so wasActive would normally trigger archive
            // — proves the cross-host check correctly precedes it.
            active: true,
            metadata: { path: '/x', host: 'other-machine', flavor: 'cursor', cursorSessionId, lifecycleState: 'running' }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            archiveSession: async (id) => { archiveCalls.push(id) }
        }).migrateOne(session, { forceArchiveRunning: true })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('cross_host_session')
        expect(archiveCalls).toHaveLength(0)
    })

    it('reserves and releases the ACP lock around the mutation window (Codex #34 P2 v7)', async () => {
        const cursorSessionId = 'acp-lock-lifecycle-uuid'
        h.placeLegacyStore(cursorSessionId)
        let releaseCount = 0
        let acquireCount = 0
        const session = h.makeSession({
            active: true,
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId, lifecycleState: 'running' }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            acquireAcpActiveLock: () => {
                acquireCount += 1
                return { release() { releaseCount += 1 } }
            }
        }).migrateOne(session, { forceArchiveRunning: true })
        expect(out.ok).toBe(true)
        // Lock was acquired exactly once and released exactly once even
        // on the happy path.
        expect(acquireCount).toBe(1)
        expect(releaseCount).toBe(1)
    })

    it('releases the ACP lock even when migration refuses inside the locked window (Codex #34 P2 v7)', async () => {
        const cursorSessionId = 'acp-lock-on-refusal-uuid'
        h.placeLegacyStore(cursorSessionId)
        // Pre-create the ACP target dir so target_already_exists fires
        // INSIDE migrateOneWithLock (lock has been acquired by then).
        const { mkdirSync } = require('node:fs')
        mkdirSync(join(h.acpSessionsDir, cursorSessionId), { recursive: true })
        let releaseCount = 0
        const session = h.makeSession({
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            acquireAcpActiveLock: () => ({ release() { releaseCount += 1 } })
        }).migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('target_already_exists')
        expect(releaseCount).toBe(1)
    })

    it('does not archive when acp_transport_active refusal would fire (Codex #34 P2 v2 / P2 v7)', async () => {
        const cursorSessionId = 'acp-active-no-archive-uuid'
        h.placeLegacyStore(cursorSessionId)
        const archiveCalls: string[] = []
        const session = h.makeSession({
            // active=true so wasActive would normally trigger archive
            // — proves the acp_transport_active check correctly precedes it.
            active: true,
            metadata: { path: '/x', host: 'h', flavor: 'cursor', cursorSessionId, lifecycleState: 'running' }
        })
        const out = await makeMigrator(h, makeMockProbe(), {
            // Codex review #34 P2 v7: lock acquisition is reserved BEFORE
            // archive. Returning null here is the new way to express
            // "another agent acp transport is live".
            acquireAcpActiveLock: () => null,
            isAgentAcpTransportActive: () => ({ active: true, holderPid: 42 }),
            archiveSession: async (id) => { archiveCalls.push(id) }
        }).migrateOne(session, { forceArchiveRunning: true })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('acp_transport_active')
        expect(archiveCalls).toHaveLength(0)
    })

    it('surfaces archive failures as archive_failed', async () => {
        const cursorSessionId = 'archive-throws-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            // Live runner — wasActive=true triggers the archive RPC,
            // which throws and we surface archive_failed. Codex #34 P2 v6.
            active: true,
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId, lifecycleState: 'running' }
        })
        const migrator = makeMigrator(h, makeMockProbe(), {
            archiveSession: async () => { throw new Error('rpc gateway down') }
        })
        const out = await migrator.migrateOne(session, { forceArchiveRunning: true })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('archive_failed')
        expect(out.message).toContain('rpc gateway down')
    })
})

describe('CursorLegacyMigrator.migrateOne — telemetry', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('records a non-zero durationMs in every outcome', async () => {
        const cursorSessionId = 'duration-uuid'
        h.placeLegacyStore(cursorSessionId)
        let t = 1_000_000
        const migrator = new CursorLegacyMigrator({}, {
            homeDir: () => h.home,
            hostName: () => 'h',
            tmpDir: () => h.tmp,
            now: () => (t += 25),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createProbe: () => makeMockProbe() as any,
            awaitLockRelease: async () => true,
            isAgentAcpTransportActive: () => ({ active: false, holderPid: null }),
            archiveSession: async () => {},
            updateSessionAfterMigrate: () => ({ ok: true })
        })
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await migrator.migrateOne(session, {})
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.durationMs).toBeGreaterThan(0)
    })

    it('synthesized meta.json title comes from legacy meta name when present', async () => {
        const cursorSessionId = 'title-uuid'
        h.placeLegacyStore(cursorSessionId, { name: 'My Test Chat' })
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
        expect(out.ok).toBe(true)
        const sidecarPath = join(h.acpSessionsDir, cursorSessionId, 'meta.json')
        const sidecar = JSON.parse(require('node:fs').readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>
        expect(sidecar.title).toBe('My Test Chat')
    })

    it('uses metadata.homeDir when present in preference to the hub HOME (Codex #34 P2)', async () => {
        // Use a SEPARATE home dir than the harness's `h.home`, set on
        // metadata. The legacy chat must live under the metadata-recorded
        // home; the migrator should pick that path, not the hub HOME.
        const ownerHome = mkdtempSync(join(tmpdir(), 'hapi-owner-home-'))
        try {
            const cursorSessionId = 'owner-home-uuid'
            const ownerChatsDir = join(ownerHome, '.cursor', 'chats', 'wsh-owner', cursorSessionId)
            mkdirSync(ownerChatsDir, { recursive: true })
            require('./fixtures/buildSyntheticLegacyStore').buildSyntheticLegacyStore({
                path: join(ownerChatsDir, 'store.db')
            })
            // Hub HOME (h.home) has NO matching chat — only metadata.homeDir does.
            const session = h.makeSession({
                metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId, homeDir: ownerHome } as Metadata
            })
            // Re-route the migrator's resolution: even though h.home points to
            // a temp dir without the chat, the migrator should resolve under
            // ownerHome (metadata.homeDir).
            // The acp-sessions placement targets the SAME ownerHome since
            // home is now resolved from metadata.
            const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
            expect(out.ok).toBe(true)
            if (!out.ok) return
            expect(existsSync(join(ownerHome, '.cursor', 'acp-sessions', cursorSessionId, 'store.db'))).toBe(true)
        } finally {
            try { rmSync(ownerHome, { recursive: true, force: true }) } catch {}
        }
    })

    it('cp leaves the placed store.db non-empty (sanity)', async () => {
        const cursorSessionId = 'sanity-uuid'
        h.placeLegacyStore(cursorSessionId)
        const session = h.makeSession({
            metadata: { path: '/workspace/x', host: 'h', flavor: 'cursor', cursorSessionId }
        })
        const out = await makeMigrator(h, makeMockProbe()).migrateOne(session, {})
        expect(out.ok).toBe(true)
        const acpStorePath = join(h.acpSessionsDir, cursorSessionId, 'store.db')
        const st = statSync(acpStorePath)
        expect(st.size).toBeGreaterThan(0)
    })
})
