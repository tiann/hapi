/**
 * Unit tests for the cursor flavor of the multi-agent import surface.
 *
 * Mirrors the codex import route test shape
 * (`hub/src/web/routes/codexDesktop.test.ts`) so reviewers can read the
 * two test files side-by-side.
 *
 * Strategy:
 *   - Real filesystem in a per-test tmpdir (mirrors the migrator unit tests).
 *   - Real bun:sqlite synthetic legacy store fixture
 *     (`hub/src/cursor/fixtures/buildSyntheticLegacyStore.ts`).
 *   - MOCK `agent acp` via the `createProbe` dependency injection point
 *     on `CursorImporterDeps`. The verify-probe is not spawned; tests
 *     script the initialize / loadSession responses to exercise every
 *     refusal branch without depending on a real `cursor-agent` install.
 *   - MOCK `findAgentBinary` by placing a stub `agent` shim under
 *     `<home>/.local/bin/agent` so the pre-flight binary check passes
 *     even in CI where cursor-agent is absent.
 *
 * Covers (one row per refusal reason + the happy path):
 *   - listImportableCursorSessions: legacy + acp discovery + dedup +
 *     alreadyImported flagging
 *   - importCursorSession happy path: legacy → transplant + Hapi row created
 *   - refusal: missing_on_disk_store
 *   - refusal: already_imported
 *   - refusal: ambiguous_legacy_store (multi-drawer)
 *   - refusal: corrupted_store
 *   - refusal: verify_load_failed (initialize)
 *   - refusal: verify_load_failed (session/load)
 *   - refusal: verify_timeout
 *   - refusal: target_already_exists
 *   - route shape: GET /api/cursor/importable-sessions
 *   - route shape: POST /api/cursor/import (multi-row batch, mixed outcomes)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import type { AcpRpcResponse } from '../../cursor/acpVerifyProbe'
import { buildSyntheticLegacyStore } from '../../cursor/fixtures/buildSyntheticLegacyStore'
import {
    importCursorSession,
    importSelectedCursorSessions,
    listImportableCursorSessions
} from '../../cursor/cursorImporter'
import { createCursorImportRoutes } from './cursorImport'

/* ---------- mock probe ---------- */

interface ScriptedProbe {
    initializeResponse: AcpRpcResponse
    loadResponse: AcpRpcResponse
    started: boolean
    stopped: boolean
}

function ok(result: Record<string, unknown> = {}): AcpRpcResponse {
    return { ok: true, result }
}

function err(message: string, code: number = -32602): AcpRpcResponse {
    return { ok: false, error: { code, message } }
}

interface MockProbeHandle {
    state: ScriptedProbe
    start: () => void
    stop: () => Promise<void>
    initialize: () => Promise<AcpRpcResponse>
    loadSession: () => Promise<{ response: AcpRpcResponse; notificationCount: number; notificationKinds: Record<string, number>; durationMs: number }>
}

function makeMockProbe(overrides: Partial<ScriptedProbe> = {}): MockProbeHandle {
    const state: ScriptedProbe = {
        initializeResponse: ok({ protocolVersion: 1 }),
        loadResponse: ok({ models: { availableModels: [], currentModelId: 'default[]' }, modes: { availableModes: [], currentModeId: 'agent' } }),
        started: false,
        stopped: false,
        ...overrides
    }
    return {
        state,
        start() { state.started = true },
        async stop() { state.stopped = true },
        async initialize() {
            return state.initializeResponse
        },
        async loadSession() {
            return {
                response: state.loadResponse,
                notificationCount: state.loadResponse.ok ? 5 : 0,
                notificationKinds: {},
                durationMs: 25
            }
        }
    }
}

/* ---------- test harness ---------- */

interface Harness {
    home: string
    chatsDir: string
    acpSessionsDir: string
    store: Store
    placeLegacyStore: (uuid: string, opts?: { workspaceHash?: string; lastUsedModel?: string; name?: string }) => string
    placeAcpStore: (uuid: string, opts?: { name?: string; cwd?: string; title?: string }) => string
    /** Plant a fake `agent` binary so findAgentBinary succeeds. */
    placeFakeAgentBinary: () => void
}

function makeHarness(): Harness {
    const home = mkdtempSync(join(tmpdir(), 'hapi-cursor-import-test-home-'))
    const chatsDir = join(home, '.cursor', 'chats')
    const acpSessionsDir = join(home, '.cursor', 'acp-sessions')
    mkdirSync(chatsDir, { recursive: true })
    mkdirSync(acpSessionsDir, { recursive: true })
    const store = new Store(':memory:')

    return {
        home,
        chatsDir,
        acpSessionsDir,
        store,
        placeLegacyStore(uuid, opts = {}) {
            const wsh = opts.workspaceHash ?? `wsh-${Math.random().toString(36).slice(2, 10)}`
            const dir = join(chatsDir, wsh, uuid)
            mkdirSync(dir, { recursive: true })
            const path = join(dir, 'store.db')
            buildSyntheticLegacyStore({
                path,
                name: opts.name,
                lastUsedModel: opts.lastUsedModel
            })
            return path
        },
        placeAcpStore(uuid, opts = {}) {
            const dir = join(acpSessionsDir, uuid)
            mkdirSync(dir, { recursive: true })
            const storePath = join(dir, 'store.db')
            buildSyntheticLegacyStore({
                path: storePath,
                name: opts.name
            })
            writeFileSync(
                join(dir, 'meta.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    cwd: opts.cwd ?? '/workspace/example',
                    title: opts.title ?? opts.name ?? 'acp chat'
                })
            )
            return storePath
        },
        placeFakeAgentBinary() {
            const binDir = join(home, '.local', 'bin')
            mkdirSync(binDir, { recursive: true })
            const path = join(binDir, 'agent')
            writeFileSync(path, '#!/bin/sh\necho "fake-agent"\n', { mode: 0o755 })
            try { chmodSync(path, 0o755) } catch {}
        }
    }
}

function cleanupHarness(h: Harness): void {
    try { h.store.close() } catch {}
    try { rmSync(h.home, { recursive: true, force: true }) } catch {}
}

function makeDeps(h: Harness, probe?: MockProbeHandle) {
    const handle = probe ?? makeMockProbe()
    return {
        homeDir: () => h.home,
        hostName: () => 'test-host',
        tmpDir: () => h.home,
        now: () => Date.now(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createProbe: (() => handle) as any,
        verifyTimeoutMs: 5_000,
        logger: { debug() {}, info() {}, warn() {}, error() {} }
    }
}

/* ---------- listImportableCursorSessions ---------- */

describe('listImportableCursorSessions', () => {
    let h: Harness
    beforeEach(() => { h = makeHarness() })
    afterEach(() => cleanupHarness(h))

    it('returns an empty list when no chats exist on disk', () => {
        const out = listImportableCursorSessions({ store: h.store, namespace: 'default', home: h.home })
        expect(out).toEqual([])
    })

    it('discovers legacy + acp stores and dedups by uuid (acp wins)', () => {
        const legacyPath = '/workspace/legacy-list'
        const legacyHash = createHash('md5').update(legacyPath).digest('hex')
        // Legacy-only chat.
        h.placeLegacyStore('11111111-1111-1111-1111-111111111111', {
            workspaceHash: legacyHash,
            name: 'legacy chat'
        })
        // ACP-only chat.
        h.placeAcpStore('22222222-2222-2222-2222-222222222222', { name: 'acp chat', title: 'acp display title' })
        // Same uuid in both — acp wins.
        h.placeLegacyStore('33333333-3333-3333-3333-333333333333', {
            workspaceHash: legacyHash,
            name: 'legacy version'
        })
        h.placeAcpStore('33333333-3333-3333-3333-333333333333', { name: 'acp version', title: 'acp version' })

        const out = listImportableCursorSessions({
            store: h.store,
            namespace: 'default',
            home: h.home,
            candidateWorkspacePaths: [legacyPath]
        })
        expect(out).toHaveLength(3)
        const byId = new Map(out.map((r) => [r.id, r]))
        expect(byId.get('11111111-1111-1111-1111-111111111111')?.sourceFormat).toBe('legacy')
        expect(byId.get('11111111-1111-1111-1111-111111111111')?.workspacePath).toBe(legacyPath)
        expect(byId.get('22222222-2222-2222-2222-222222222222')?.sourceFormat).toBe('acp')
        expect(byId.get('33333333-3333-3333-3333-333333333333')?.sourceFormat).toBe('acp')
        // Title fallthrough from legacy meta record.
        expect(byId.get('11111111-1111-1111-1111-111111111111')?.title).toBe('legacy chat')
        // ACP meta.json title preferred.
        expect(byId.get('22222222-2222-2222-2222-222222222222')?.title).toBe('acp display title')
    })

    it('flags already-imported uuids with the existing Hapi session id', () => {
        const legacyPath = '/workspace/x'
        const legacyHash = createHash('md5').update(legacyPath).digest('hex')
        h.placeLegacyStore('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', {
            workspaceHash: legacyHash,
            name: 'already imported'
        })
        // Plant a HAPI session that references this cursor uuid (path also
        // feeds candidateWorkspacePaths so the legacy drawer resolves).
        const created = h.store.sessions.getOrCreateSession('hapi-existing-tag', {
            path: legacyPath,
            host: 'test-host',
            flavor: 'cursor',
            cursorSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        } as Record<string, unknown>, {}, 'default')
        expect(created.id).toBeTruthy()

        const out = listImportableCursorSessions({ store: h.store, namespace: 'default', home: h.home })
        const row = out.find((r) => r.id === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        expect(row).toBeDefined()
        expect(row?.alreadyImportedHapiSessionId).toBe(created.id)
        expect(row?.workspacePath).toBe(legacyPath)
    })

    it('omits pathless legacy drawers from the importable list', () => {
        h.placeLegacyStore('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', {
            workspaceHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
            name: 'unresolvable legacy'
        })
        const out = listImportableCursorSessions({ store: h.store, namespace: 'default', home: h.home })
        expect(out.find((r) => r.id === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).toBeUndefined()
    })

    it('ignores non-uuid-ish basenames (path-traversal guard)', () => {
        // Manually create a directory with a bogus name; should not appear.
        const evil = join(h.acpSessionsDir, '..')
        // Don't actually create traversal entries — just verify the regex
        // rejection by planting an entry named '.evil/' which has '/' (not
        // legal on disk but readdirSync would expose '.evil').
        const allowed = '11111111-1111-1111-1111-111111111111'
        h.placeAcpStore(allowed, { name: 'allowed' })
        // Plant a non-matching entry.
        const bogusDir = join(h.acpSessionsDir, 'bogus name with spaces')
        mkdirSync(bogusDir, { recursive: true })
        writeFileSync(join(bogusDir, 'store.db'), '')

        const out = listImportableCursorSessions({ store: h.store, namespace: 'default', home: h.home })
        const ids = out.map((r) => r.id)
        expect(ids).toContain(allowed)
        expect(ids).not.toContain('bogus name with spaces')
        // Defensive evil-path check: never returns '..'.
        expect(ids).not.toContain('..')
        // unused var lint pacifier
        expect(evil.length).toBeGreaterThan(0)
    })
})

/* ---------- importCursorSession ---------- */

describe('importCursorSession refusals', () => {
    let h: Harness
    beforeEach(() => {
        h = makeHarness()
        h.placeFakeAgentBinary()
    })
    afterEach(() => cleanupHarness(h))

    it('refuses missing_on_disk_store when neither legacy nor acp store exists', async () => {
        const out = await importCursorSession({
            uuid: '11111111-2222-3333-4444-555555555555',
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('missing_on_disk_store')
    })

    it('refuses already_imported when a Hapi row already references the uuid', async () => {
        const uuid = '11111111-2222-3333-4444-666666666666'
        h.placeAcpStore(uuid, { name: 'already-imported chat' })
        const planted = h.store.sessions.getOrCreateSession('hapi-prev-tag', {
            path: '/workspace/y',
            host: 'test-host',
            flavor: 'cursor',
            cursorSessionId: uuid
        } as Record<string, unknown>, {}, 'default')

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('already_imported')
        expect(out.message).toContain(planted.id)
    })

    it('refuses ambiguous_legacy_store when the same uuid exists in 2+ drawers without workspacePath', async () => {
        const uuid = '11111111-2222-3333-4444-777777777777'
        h.placeLegacyStore(uuid, { workspaceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'd1' })
        h.placeLegacyStore(uuid, { workspaceHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'd2' })

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('ambiguous_legacy_store')
    })

    it('refuses ambiguous_legacy_store for a single legacy drawer without workspacePath', async () => {
        const uuid = '11111111-2222-3333-4444-666666666666'
        h.placeLegacyStore(uuid, { workspaceHash: 'cccccccccccccccccccccccccccccccc', name: 'solo' })

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('ambiguous_legacy_store')
        expect(out.message).toContain('requires workspacePath')
    })

    it('refuses ambiguous_legacy_store for ACP stores whose meta.json has no cwd', async () => {
        const uuid = '11111111-2222-3333-4444-555555555555'
        h.placeAcpStore(uuid, { name: 'no cwd' })
        writeFileSync(join(h.acpSessionsDir, uuid, 'meta.json'), JSON.stringify({ schemaVersion: 1 }))

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('ambiguous_legacy_store')
        expect(out.message).toContain('requires workspacePath')
    })

    it('refuses corrupted_store when store.db is not valid sqlite', async () => {
        const uuid = '11111111-2222-3333-4444-888888888888'
        const dir = join(h.acpSessionsDir, uuid)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'store.db'), 'not a sqlite database at all')
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd: '/x' }))

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('corrupted_store')
    })

    it('refuses verify_load_failed when agent acp initialize fails', async () => {
        const uuid = '11111111-2222-3333-4444-999999999999'
        h.placeAcpStore(uuid, { name: 'will fail init' })
        const probe = makeMockProbe({ initializeResponse: err('initialize bombed') })

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h, probe)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('verify_load_failed')
        expect(out.message).toContain('initialize')
        // STRICT contract: refusal must NOT have created a Hapi session row.
        expect(h.store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('refuses verify_load_failed when agent acp session/load fails', async () => {
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        h.placeAcpStore(uuid, { name: 'will fail load' })
        const probe = makeMockProbe({ loadResponse: err('session/load failed: bad blob graph') })

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h, probe)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('verify_load_failed')
        expect(out.message).toContain('session/load')
        expect(h.store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('refuses verify_timeout when probe reports a timeout', async () => {
        const uuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
        h.placeAcpStore(uuid, { name: 'will time out' })
        const probe = makeMockProbe({ loadResponse: err('timeout after 30000ms', -32001) })

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h, probe)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('verify_timeout')
        expect(h.store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('refuses target_already_exists when the ACP target dir is already populated for a legacy import', async () => {
        const uuid = 'cccccccc-dddd-eeee-ffff-000000000000'
        h.placeLegacyStore(uuid, { workspaceHash: 'wsh-only', name: 'legacy with stale acp twin' })
        // Plant an unrelated file in the ACP target so the existence check fires.
        const acpDir = join(h.acpSessionsDir, uuid)
        mkdirSync(acpDir, { recursive: true })
        writeFileSync(join(acpDir, 'meta.json'), JSON.stringify({ schemaVersion: 1 }))

        const out = await importCursorSession({
            uuid,
            workspacePath: '/workspace/stale-acp-twin',
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('target_already_exists')
    })

    it('refuses agent_binary_not_found when no `agent` binary is reachable', async () => {
        // Drop the fake binary placed by beforeEach.
        rmSync(join(h.home, '.local', 'bin', 'agent'), { force: true })
        const originalPath = process.env.PATH
        // Sanitize PATH so the real `agent` (if present on developer
        // machines) cannot be found either.
        process.env.PATH = '/__hapi_test_dummy__/bin'
        try {
            const uuid = 'dddddddd-eeee-ffff-0000-111111111111'
            h.placeAcpStore(uuid, { name: 'no agent binary' })
            const out = await importCursorSession({
                uuid,
                store: h.store,
                namespace: 'default',
                home: h.home,
                deps: makeDeps(h)
            })
            expect(out.ok).toBe(false)
            if (out.ok) return
            expect(out.reason).toBe('agent_binary_not_found')
        } finally {
            process.env.PATH = originalPath
        }
    })
})

describe('importCursorSession happy paths', () => {
    let h: Harness
    beforeEach(() => {
        h = makeHarness()
        h.placeFakeAgentBinary()
    })
    afterEach(() => cleanupHarness(h))

    it('imports an ACP-format chat without touching disk and creates a Hapi row', async () => {
        const uuid = 'eeeeeeee-ffff-0000-1111-222222222222'
        h.placeAcpStore(uuid, { name: 'acp happy', cwd: '/workspace/happy-acp' })

        const out = await importCursorSession({
            uuid,
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.sourceFormat).toBe('acp')
        expect(out.hapiSessionId).toBeTruthy()

        const session = h.store.sessions.getSessionsByNamespace('default')[0]
        expect(session).toBeDefined()
        const metadata = session.metadata as Record<string, unknown>
        expect(metadata.flavor).toBe('cursor')
        expect(metadata.cursorSessionId).toBe(uuid)
        expect(metadata.homeDir).toBe(h.home)
        // STRICT contract: any HAPI row produced by this import path is
        // ACP from birth.
        expect(metadata.cursorSessionProtocol).toBe('acp')
        expect(metadata.lifecycleState).toBe('imported')
    })

    it('imports a legacy chat by transplanting to the ACP location', async () => {
        const uuid = 'ffffffff-0000-1111-2222-333333333333'
        const sourceStorePath = h.placeLegacyStore(uuid, {
            workspaceHash: 'wsh-only-source',
            name: 'legacy happy'
        })
        // Sanity: the legacy store exists where we expect.
        expect(sourceStorePath).toContain('chats')

        const out = await importCursorSession({
            uuid,
            workspacePath: '/workspace/legacy-happy',
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.sourceFormat).toBe('legacy')

        // After import the ACP target dir should exist with store.db + meta.json.
        const acpDir = join(h.acpSessionsDir, uuid)
        const acpStore = join(acpDir, 'store.db')
        const acpMeta = join(acpDir, 'meta.json')
        const { existsSync, readFileSync } = await import('node:fs')
        expect(existsSync(acpStore)).toBe(true)
        expect(existsSync(acpMeta)).toBe(true)
        const meta = JSON.parse(readFileSync(acpMeta, 'utf-8')) as Record<string, unknown>
        expect(meta.schemaVersion).toBe(1)
        expect(meta.cwd).toBe('/workspace/legacy-happy')

        const session = h.store.sessions.getSessionsByNamespace('default')[0]
        const metadata = session.metadata as Record<string, unknown>
        expect(metadata.cursorSessionProtocol).toBe('acp')
        expect(metadata.path).toBe('/workspace/legacy-happy')
    })

    it('importSelectedCursorSessions returns per-row outcomes (mixed batch)', async () => {
        const goodUuid = '00000000-1111-2222-3333-444444444444'
        const badUuid = '00000000-1111-2222-3333-555555555555'
        h.placeAcpStore(goodUuid, { name: 'will succeed' })
        // badUuid intentionally has no on-disk store.

        const out = await importSelectedCursorSessions({
            uuids: [goodUuid, badUuid],
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.results).toHaveLength(2)
        expect(out.importedCount).toBe(1)
        const byUuid = new Map(out.results.map((r) => [r.uuid, r]))
        expect(byUuid.get(goodUuid)?.ok).toBe(true)
        const badRow = byUuid.get(badUuid)
        expect(badRow?.ok).toBe(false)
        if (badRow && !badRow.ok) {
            expect(badRow.reason).toBe('missing_on_disk_store')
        }
    })

    it('importSelectedCursorSessions honors per-row workspacePath from selections', async () => {
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        h.placeAcpStore(uuid, { name: 'selection path', cwd: '/workspace/from-meta' })

        const out = await importSelectedCursorSessions({
            selections: [{ uuid, workspacePath: '/workspace/from-ui' }],
            store: h.store,
            namespace: 'default',
            home: h.home,
            deps: makeDeps(h)
        })
        expect(out.importedCount).toBe(1)
        expect(out.results[0]?.ok).toBe(true)
        const session = h.store.sessions.getSessionsByNamespace('default')[0]
        const metadata = session.metadata as Record<string, unknown>
        expect(metadata.path).toBe('/workspace/from-ui')
    })
})

/* ---------- route shape ---------- */

function createRoutesApp(opts: { namespace: string; store: Store }): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', opts.namespace)
        await next()
    })
    app.route('/api', createCursorImportRoutes({
        store: opts.store,
        getSyncEngine: () => null
    }))
    return app
}

describe('Cursor import HTTP routes', () => {
    let h: Harness
    const originalHomeOverride = process.env.HAPI_CURSOR_HOME_OVERRIDE
    const originalLogRoot = process.env.HAPI_CURSOR_LOG_ROOT
    beforeEach(() => {
        h = makeHarness()
        h.placeFakeAgentBinary()
        process.env.HAPI_CURSOR_HOME_OVERRIDE = h.home
        process.env.HAPI_CURSOR_LOG_ROOT = h.home
    })
    afterEach(() => {
        if (originalHomeOverride === undefined) {
            delete process.env.HAPI_CURSOR_HOME_OVERRIDE
        } else {
            process.env.HAPI_CURSOR_HOME_OVERRIDE = originalHomeOverride
        }
        if (originalLogRoot === undefined) {
            delete process.env.HAPI_CURSOR_LOG_ROOT
        } else {
            process.env.HAPI_CURSOR_LOG_ROOT = originalLogRoot
        }
        cleanupHarness(h)
    })

    it('rejects non-default namespaces', async () => {
        const app = createRoutesApp({ namespace: 'tenant-a', store: h.store })
        const res = await app.request('/api/cursor/importable-sessions')
        expect(res.status).toBe(403)
        const body = await res.json() as Record<string, unknown>
        expect(body.success).toBe(false)
    })

    it('GET /api/cursor/importable-sessions returns the discovery list', async () => {
        const app = createRoutesApp({ namespace: 'default', store: h.store })
        h.placeAcpStore('77777777-7777-7777-7777-777777777777', { name: 'route test' })
        const res = await app.request('/api/cursor/importable-sessions')
        expect(res.status).toBe(200)
        const body = await res.json() as { success: true; sessions: Array<{ id: string }> }
        expect(body.success).toBe(true)
        expect(body.sessions.some((s) => s.id === '77777777-7777-7777-7777-777777777777')).toBe(true)
    })

    it('POST /api/cursor/import rejects empty uuid arrays', async () => {
        const app = createRoutesApp({ namespace: 'default', store: h.store })
        const res = await app.request('/api/cursor/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ uuids: [] })
        })
        expect(res.status).toBe(400)
    })

    it('POST /api/cursor/import returns a per-row outcome for each requested uuid', async () => {
        const app = createRoutesApp({ namespace: 'default', store: h.store })
        const res = await app.request('/api/cursor/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ uuids: ['not-on-disk-uuid'] })
        })
        // Pre-flight refuses on missing_on_disk_store before any probe spawn.
        expect(res.status).toBe(200)
        const body = await res.json() as { success: true; results: Array<{ ok: boolean; reason?: string }>; importedCount: number }
        expect(body.success).toBe(true)
        expect(body.results).toHaveLength(1)
        expect(body.results[0].ok).toBe(false)
        expect(body.importedCount).toBe(0)
    })

    it('POST /api/cursor/import accepts selections with per-row workspacePath', async () => {
        const app = createRoutesApp({ namespace: 'default', store: h.store })
        const res = await app.request('/api/cursor/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                selections: [{ uuid: 'not-on-disk-uuid', workspacePath: '/workspace/from-ui' }]
            })
        })
        // Route accepts the selections shape; refusal is still per-row (no agent probe needed).
        expect(res.status).toBe(200)
        const body = await res.json() as {
            success: true
            results: Array<{ ok: boolean; reason?: string; uuid: string }>
            importedCount: number
        }
        expect(body.success).toBe(true)
        expect(body.importedCount).toBe(0)
        expect(body.results).toHaveLength(1)
        expect(body.results[0]?.ok).toBe(false)
        expect(body.results[0]?.reason).toBe('missing_on_disk_store')
        expect(body.results[0]?.uuid).toBe('not-on-disk-uuid')
    })
})
