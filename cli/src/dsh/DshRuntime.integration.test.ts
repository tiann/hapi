import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDshHost, type DshHostHandle } from './DshRuntime'
import { DshClient } from './DshClient'
import { DSH_RUNTIME_PATH_ENV } from './types'

/**
 * Real-host integration test. Skipped unless HAPI_DSH_INTEGRATION=1 and the
 * pinned DSH runtime is reachable via HAPI_DSH_RUNTIME_PATH (or the
 * HAPI_HOME/dsh-runtime install). CI keeps this skipped; developers run it
 * against a real `dsh` install to verify the spawn + no-web overlay +
 * create-as-resume flow end to end.
 */
const enabled = process.env.HAPI_DSH_INTEGRATION === '1'
    && (Boolean(process.env[DSH_RUNTIME_PATH_ENV]) || process.env.HAPI_HOME !== undefined)

describe.skipIf(!enabled)('DshRuntime + DshClient against a real DSH host', () => {
    let workDir: string
    let dshHome: string
    let handle: DshHostHandle | null = null
    let client: DshClient | null = null

    beforeAll(async () => {
        workDir = mkdtempSync(join(tmpdir(), 'hapi-dsh-int-'))
        dshHome = mkdtempSync(join(tmpdir(), 'hapi-dsh-home-'))
        handle = await startDshHost({
            cwd: workDir,
            dshHome,
            readyTimeoutMs: 60_000,
            logTag: 'dsh-int'
        })
        client = DshClient.connect(handle.baseUrl)
    })

    afterAll(async () => {
        await handle?.stop({ timeoutMs: 5_000 })
        handle = null
        rmSync(workDir, { recursive: true, force: true })
        rmSync(dshHome, { recursive: true, force: true })
    })

    it('readies with a reported host version and loopback binding', () => {
        expect(handle!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        // Host-internal app version; non-empty per the describe contract.
        expect(handle!.info.version.length).toBeGreaterThan(0)
    })

    it('does not serve the web frontend (GET / → 404)', async () => {
        const response = await fetch(handle!.baseUrl + '/')
        expect(response.status).toBe(404)
        const index = await fetch(handle!.baseUrl + '/index.html')
        expect(index.status).toBe(404)
    })

    it('creates a session with a preallocated id and resumes it idempotently', async () => {
        const created = await client!.createSession({
            cwd: workDir,
            sessionId: 'hapi-int-session-001'
        })
        expect(created.sessionId).toBe('hapi-int-session-001')

        const resumed = await client!.createSession({
            cwd: workDir,
            sessionId: 'hapi-int-session-001'
        })
        expect(resumed.sessionId).toBe('hapi-int-session-001')

        await expect(client!.createSession({
            cwd: join(workDir, 'other'),
            sessionId: 'hapi-int-session-001'
        })).rejects.toMatchObject({ code: 'session-conflict' })
    })

    it('streams mux frames for the created session', async () => {
        const ac = new AbortController()
        const frames: string[] = []
        const pump = (async () => {
            for await (const envelope of client!.muxStream(ac.signal)) {
                frames.push(envelope.payload.type)
            }
        })()

        // The session was created above; the mux baseline replays a
        // subscribed control frame for every attached session.
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        expect(frames).toContain('session/subscribed')

        ac.abort()
        await pump
    })
})
