import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('agentRootRegistry', () => {
    let home: string
    let previousHome: string | undefined

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'hapi-agent-root-'))
        previousHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = home
        vi.resetModules()
    })

    afterEach(() => {
        if (previousHome === undefined) delete process.env.HAPI_HOME
        else process.env.HAPI_HOME = previousHome
        vi.resetModules()
        rmSync(home, { recursive: true, force: true })
    })

    it('indexes by HAPI session id for Runner-restart lookup', async () => {
        const reg = await import('./agentRootRegistry')
        reg.writeAgentRoot({
            hostPid: 424242,
            pid: 999001,
            startMarker: 'Mon Jan 1 00:00:00 2026',
            bootId: 'boot-1',
            pgid: 999001,
            sessionId: 'hapi-sess-aaaa-bbbb-cccc-ddddeeee',
        })
        expect(reg.readAgentRootForSession('hapi-sess-aaaa-bbbb-cccc-ddddeeee')?.hostPid).toBe(424242)
        expect(reg.readAgentRootForHost(424242)?.sessionId).toBe('hapi-sess-aaaa-bbbb-cccc-ddddeeee')
    })

    it('treats a leaderless nonempty process group as still active (#2021 Approach)', async () => {
        vi.resetModules()
        vi.doMock('@/utils/process', async () => {
            const actual = await vi.importActual<typeof import('@/utils/process')>('@/utils/process')
            return {
                ...actual,
                isWindows: () => false,
                classifyAgentOwnedProcessGroup: () => 'unknown' as const,
                retainedIdentityStillAlive: () => false,
            }
        })
        const reg = await import('./agentRootRegistry')
        const record = {
            hostPid: 424250,
            pid: 999002,
            startMarker: 'Mon Jan 1 00:00:00 2026',
            bootId: 'boot-1',
            pgid: 999002,
            sessionId: 'hapi-sess-leaderless',
        }
        expect(reg.agentRootContainmentActive(record)).toBe(true)
        reg.writeAgentRoot(record)
        expect(reg.findLiveAgentRootForSession('hapi-sess-leaderless', [424250])).not.toBeNull()
    })

    it('clears when the process group classifier reports empty', async () => {
        vi.resetModules()
        vi.doMock('@/utils/process', async () => {
            const actual = await vi.importActual<typeof import('@/utils/process')>('@/utils/process')
            return {
                ...actual,
                isWindows: () => false,
                classifyAgentOwnedProcessGroup: () => 'empty' as const,
                retainedIdentityStillAlive: () => false,
            }
        })
        const reg = await import('./agentRootRegistry')
        reg.writeAgentRoot({
            hostPid: 424251,
            pid: 999003,
            startMarker: 'Mon Jan 1 00:00:00 2026',
            pgid: 999003,
            sessionId: 'hapi-sess-empty',
        })
        expect(reg.findLiveAgentRootForSession('hapi-sess-empty', [424251])).toBeNull()
        expect(reg.readAgentRootForHost(424251)).toBeNull()
    })

    it('publishAgentRootFromIdentity stamps HAPI_SESSION_ID from env', async () => {
        process.env.HAPI_SESSION_ID = 'env-hapi-session-id-1'
        const reg = await import('./agentRootRegistry')
        reg.publishAgentRootFromIdentity({
            pid: 999004,
            startMarker: 'Mon Jan 1 00:00:00 2026',
            bootId: null,
            tgid: null,
            pgid: 999004,
        })
        const stored = reg.readAgentRootForHost(process.pid)
        expect(stored?.sessionId).toBe('env-hapi-session-id-1')
        expect(reg.readAgentRootForSession('env-hapi-session-id-1')?.pid).toBe(999004)
        reg.clearAgentRootForCurrentHost()
        delete process.env.HAPI_SESSION_ID
    })

    it('Windows shim fallback keeps containment active after root exit (#2021 Approach)', async () => {
        vi.resetModules()
        vi.doMock('@/utils/process', async () => {
            const actual = await vi.importActual<typeof import('@/utils/process')>('@/utils/process')
            return {
                ...actual,
                isWindows: () => true,
                retainedIdentityStillAlive: () => false,
            }
        })
        const reg = await import('./agentRootRegistry')
        const uncontained = {
            hostPid: 424260,
            pid: 999010,
            startMarker: 'Mon Jan 1 00:00:00 2026',
            containmentEstablished: false as const,
            sessionId: 'hapi-sess-win-shim',
        }
        expect(reg.agentRootContainmentActive(uncontained)).toBe(true)
        reg.writeAgentRoot(uncontained)
        expect(reg.findLiveAgentRootForSession('hapi-sess-win-shim', [424260])).not.toBeNull()

        const contained = {
            ...uncontained,
            hostPid: 424261,
            containmentEstablished: true as const,
            sessionId: 'hapi-sess-win-job',
        }
        expect(reg.agentRootContainmentActive(contained)).toBe(false)
    })
})
