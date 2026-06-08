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
import { CursorLegacyMigrator, findLegacyChatStore, readLegacyMetaLastUsedModel } from './cursorLegacyMigrator'
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

function makeMigrator(h: Harness, probe: ReturnType<typeof makeMockProbe> | null, opts: { archiveSession?: (id: string) => Promise<void>; updateOverride?: (sessionId: string, namespace: string, lastUsedModel: string | null) => { ok: true } | { ok: false; reason: 'version_mismatch_or_missing' } | { ok: false; reason: 'session_active' }; isAgentAcpTransportActive?: () => { active: boolean; holderPid: number | null }; getCurrentSession?: (sessionId: string, namespace: string) => { active: boolean; lifecycleState?: string; cursorSessionProtocol?: string } | null; acquireAcpActiveLock?: () => { release(): void } | null; checkpointLegacyStore?: (storeDbPath: string) => void } = {}): CursorLegacyMigrator {
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
        })
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
