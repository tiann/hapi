/**
 * Integration test for the legacy stream-json → ACP migrator.
 *
 * Spawns a REAL `agent acp` against an isolated $HOME with a synthetic
 * legacy store.db. Verifies that:
 *   - initialize succeeds
 *   - session/load succeeds against the transplanted store
 *   - one session/prompt completes
 *
 * This is the same verify recipe the production migrator runs in its
 * temp-HOME staging step. The test exists to detect drift between the
 * cursor-agent on the developer's machine and HAPI's assumptions about
 * its on-disk layout (#824).
 *
 * Opt-in: set CURSOR_AGENT_INTEGRATION=1 to enable. In CI without auth,
 * keep this off - the unit tests in cursorLegacyMigrator.test.ts cover
 * every migrator branch with mocks.
 *
 * Developer recipe:
 *   CURSOR_AGENT_INTEGRATION=1 bun test src/cursor/cursorLegacyMigratorIntegration.test.ts
 *
 * Fodder-strength: if LEGACY_FODDER_WSH + LEGACY_FODDER_UUID are also set,
 * the test will copy that real on-disk legacy store into the fake $HOME and
 * verify it survives the full migrator round-trip. The operator's real
 * ~/.cursor/chats/ is NOT mutated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import type { Metadata } from '@hapi/protocol/schemas'
import type { Session } from '@hapi/protocol/types'
import { CursorLegacyMigrator } from './cursorLegacyMigrator'
import { AcpVerifyProbe, tryAcquireAcpActiveLock } from './acpVerifyProbe'
import { buildSyntheticLegacyStore } from './fixtures/buildSyntheticLegacyStore'

const ENABLED = process.env.CURSOR_AGENT_INTEGRATION === '1'

function agentBinaryAvailable(): boolean {
    const which = spawnSync('agent', ['--version'], { stdio: 'pipe' })
    return which.status === 0
}

function copyAuthFiles(realHome: string, fakeHome: string): void {
    const realCursor = join(realHome, '.cursor')
    const fakeCursor = join(fakeHome, '.cursor')
    mkdirSync(fakeCursor, { recursive: true })
    for (const f of ['cli-config.json', 'agent-cli-state.json', 'acp-config.json']) {
        const src = join(realCursor, f)
        if (existsSync(src)) {
            try { copyFileSync(src, join(fakeCursor, f)) } catch {}
        }
    }
}

const describeIntegration = ENABLED ? describe : describe.skip

describeIntegration('CursorLegacyMigrator INTEGRATION (real agent acp)', () => {
    let fakeHome: string
    let tmp: string
    beforeEach(() => {
        if (!ENABLED) return
        if (!agentBinaryAvailable()) {
            throw new Error('agent binary not on PATH; install cursor-agent or unset CURSOR_AGENT_INTEGRATION')
        }
        fakeHome = mkdtempSync(join(tmpdir(), 'hapi-migrator-integration-home-'))
        tmp = mkdtempSync(join(tmpdir(), 'hapi-migrator-integration-tmp-'))
        copyAuthFiles(homedir(), fakeHome)
        mkdirSync(join(fakeHome, '.cursor', 'chats'), { recursive: true })
        mkdirSync(join(fakeHome, '.cursor', 'acp-sessions'), { recursive: true })
    })
    afterEach(() => {
        if (!ENABLED) return
        try { rmSync(fakeHome, { recursive: true, force: true }) } catch {}
        try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    })

    it('migrates a tiny synthetic legacy store through the real agent acp verify path', async () => {
        const cursorSessionId = '11111111-2222-3333-4444-555555555555'
        const wsh = 'wsh-int'
        const sourceDir = join(fakeHome, '.cursor', 'chats', wsh, cursorSessionId)
        mkdirSync(sourceDir, { recursive: true })
        const sourceStore = join(sourceDir, 'store.db')
        buildSyntheticLegacyStore({ path: sourceStore, name: 'integration synthetic', lastUsedModel: 'composer-2.5' })

        const updateCalls: Array<{ sessionId: string; namespace: string; lastUsedModel: string | null }> = []
        const migrator = new CursorLegacyMigrator(
            { verifyTimeoutMs: 120_000, verifyPromptText: 'Reply with exactly: ack' },
            {
                homeDir: () => fakeHome,
                hostName: () => "integration",
                tmpDir: () => tmp,
                now: () => Date.now(),
                createProbe: (env) => new AcpVerifyProbe({ env, timeoutMs: 60_000, hapiHome: tmp, skipLockAcquire: true }),
                awaitLockRelease: async () => true,
                isAgentAcpTransportActive: () => ({ active: false, holderPid: null }),
                acquireAcpActiveLock: () => tryAcquireAcpActiveLock(tmp),
                archiveSession: async () => {},
                updateSessionAfterMigrate: (sessionId, namespace, lastUsedModel) => {
                    updateCalls.push({ sessionId, namespace, lastUsedModel })
                    return { ok: true }
                }
            }
        )

        const session: Session = {
            id: 'integration-sess',
            tag: 'integration-sess',
            namespace: 'default',
            createdAt: 0,
            updatedAt: 0,
            seq: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: {
                path: tmpdir(),
                host: 'integration',
                flavor: 'cursor',
                cursorSessionId
            } as Metadata,
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

        const out = await migrator.migrateOne(session, {})
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.acpSessionId).toBe(cursorSessionId)
        expect(out.sourceRemoved).toBe(true)
        expect(existsSync(join(fakeHome, '.cursor', 'acp-sessions', cursorSessionId, 'store.db'))).toBe(true)
        expect(existsSync(sourceStore)).toBe(false)
        expect(updateCalls).toHaveLength(1)
        expect(updateCalls[0].lastUsedModel).toBe('composer-2.5')
    }, 180_000)

    it('migrates a REAL operator-supplied legacy store (LEGACY_FODDER_WSH + LEGACY_FODDER_UUID)', async () => {
        const fodderWsh = process.env.LEGACY_FODDER_WSH
        const fodderUuid = process.env.LEGACY_FODDER_UUID
        if (!fodderWsh || !fodderUuid) {
            // Skip silently; fodder is operator-local data we can't ship.
            return
        }
        const realSourceStore = join(homedir(), '.cursor', 'chats', fodderWsh, fodderUuid, 'store.db')
        if (!existsSync(realSourceStore)) {
            throw new Error(`LEGACY_FODDER_WSH/UUID set but ${realSourceStore} does not exist`)
        }
        // Copy into fake HOME — operator's real store is NEVER touched.
        const fakeSourceDir = join(fakeHome, '.cursor', 'chats', fodderWsh, fodderUuid)
        mkdirSync(fakeSourceDir, { recursive: true })
        copyFileSync(realSourceStore, join(fakeSourceDir, 'store.db'))

        const updateCalls: Array<{ sessionId: string; namespace: string; lastUsedModel: string | null }> = []
        const migrator = new CursorLegacyMigrator(
            { verifyTimeoutMs: 180_000 },
            {
                homeDir: () => fakeHome,
                hostName: () => "integration",
                tmpDir: () => tmp,
                now: () => Date.now(),
                createProbe: (env) => new AcpVerifyProbe({ env, timeoutMs: 120_000, hapiHome: tmp, skipLockAcquire: true }),
                awaitLockRelease: async () => true,
                isAgentAcpTransportActive: () => ({ active: false, holderPid: null }),
                acquireAcpActiveLock: () => tryAcquireAcpActiveLock(tmp),
                archiveSession: async () => {},
                updateSessionAfterMigrate: (sessionId, namespace, lastUsedModel) => {
                    updateCalls.push({ sessionId, namespace, lastUsedModel })
                    return { ok: true }
                }
            }
        )
        const session: Session = {
            id: 'fodder-sess',
            tag: 'fodder-sess',
            namespace: 'default',
            createdAt: 0,
            updatedAt: 0,
            seq: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: {
                path: tmpdir(),
                host: 'integration',
                flavor: 'cursor',
                cursorSessionId: fodderUuid
            } as Metadata,
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

        const out = await migrator.migrateOne(session, { skipVerify: true })
        // skipVerify because real fodder may have policies (e.g. ask permission, model unavailability) that fail a fresh prompt. The transplant + flip is the regression-critical path.
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.acpSessionId).toBe(fodderUuid)
        expect(out.sourceRemoved).toBe(true)
        expect(existsSync(join(fakeHome, '.cursor', 'acp-sessions', fodderUuid, 'store.db'))).toBe(true)
        // Operator's real store ON DISK is unaffected because we operated only against fakeHome.
        expect(existsSync(realSourceStore)).toBe(true)
        expect(updateCalls).toHaveLength(1)
    }, 240_000)

    it('refuses to migrate when target collision exists', async () => {
        const cursorSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const wsh = 'wsh-collide'
        const sourceDir = join(fakeHome, '.cursor', 'chats', wsh, cursorSessionId)
        mkdirSync(sourceDir, { recursive: true })
        buildSyntheticLegacyStore({ path: join(sourceDir, 'store.db') })
        // Pre-existing ACP target.
        mkdirSync(join(fakeHome, '.cursor', 'acp-sessions', cursorSessionId), { recursive: true })
        writeFileSync(join(fakeHome, '.cursor', 'acp-sessions', cursorSessionId, 'meta.json'), '{}')

        const migrator = new CursorLegacyMigrator({}, {
            homeDir: () => fakeHome,
                hostName: () => "integration",
            tmpDir: () => tmp,
            now: () => Date.now(),
            createProbe: (env) => new AcpVerifyProbe({ env, hapiHome: tmp, skipLockAcquire: true }),
            awaitLockRelease: async () => true,
                isAgentAcpTransportActive: () => ({ active: false, holderPid: null }),
                acquireAcpActiveLock: () => tryAcquireAcpActiveLock(tmp),
            archiveSession: async () => {},
            updateSessionAfterMigrate: () => ({ ok: true })
        })
        const session: Session = {
            id: 'integration-collide',
            tag: 'integration-collide',
            namespace: 'default',
            createdAt: 0,
            updatedAt: 0,
            seq: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: {
                path: tmpdir(),
                host: 'integration',
                flavor: 'cursor',
                cursorSessionId
            } as Metadata,
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
        const out = await migrator.migrateOne(session, {})
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.reason).toBe('target_already_exists')
    })
})
