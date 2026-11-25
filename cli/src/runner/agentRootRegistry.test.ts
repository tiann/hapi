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

    it('finds a live agent root published for a host pid', async () => {
        const reg = await import('./agentRootRegistry')
        const alivePid = process.pid
        reg.writeAgentRoot({
            hostPid: 424242,
            pid: alivePid,
            startMarker: null,
            sessionId: 'sess-live',
        })
        expect(reg.findLiveAgentRootForSession('sess-live', [424242])?.pid).toBe(alivePid)
        expect(reg.agentRootRecordStillAlive(reg.readAgentRootForHost(424242)!)).toBe(true)
    })

    it('clears dead agent roots and returns null', async () => {
        const reg = await import('./agentRootRegistry')
        reg.writeAgentRoot({
            hostPid: 424244,
            pid: 2_147_483_646,
            startMarker: null,
            sessionId: 'sess-gone',
        })
        expect(reg.findLiveAgentRootForSession('sess-gone', [424244])).toBeNull()
        expect(reg.readAgentRootForHost(424244)).toBeNull()
    })
})
