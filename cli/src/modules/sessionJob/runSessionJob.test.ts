import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { runSessionJob } from './runSessionJob'

function fakeChild(exitCode: number, deferExit = false) {
    const child = new EventEmitter() as EventEmitter & {
        pid: number
        killed: boolean
        exit: () => void
    }
    child.pid = 4242
    child.killed = false
    child.exit = () => child.emit('exit', exitCode, null)
    if (!deferExit) {
        queueMicrotask(() => child.exit())
    }
    return child
}

describe('runSessionJob', () => {
    it('sets running, heartbeats, then marks completed on exit 0', async () => {
        const http = {
            post: vi.fn(async () => ({ status: 200, data: { token: 'jwt' } })),
            get: vi.fn(async () => ({
                status: 200,
                data: { sessions: [{ id: 'aaaaaaaa-1111-1111-1111-111111111111' }] }
            })),
            put: vi.fn(async () => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: 'running',
                        heartbeatAt: 1,
                        startedAt: 1,
                        updatedAt: 1
                    }
                }
            })),
            patch: vi.fn(async (_url: string, body: { status?: string }) => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: body.status ?? 'running',
                        heartbeatAt: 2,
                        startedAt: 1,
                        updatedAt: 2
                    }
                }
            }))
        }

        const timers: Array<() => void> = []
        const child = fakeChild(0, true)
        const running = runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            heartbeatMs: 10,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => child) as never,
            setIntervalImpl: ((fn: () => void) => {
                timers.push(fn)
                return 1 as unknown as NodeJS.Timeout
            }) as never,
            clearIntervalImpl: (() => undefined) as never
        })

        await vi.waitFor(() => expect(http.put).toHaveBeenCalled())
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.get).toHaveBeenCalledTimes(1)

        // Heartbeat ticks reuse resolved client (no extra auth).
        expect(timers.length).toBe(1)
        timers[0]!()
        await vi.waitFor(() => expect(http.patch).toHaveBeenCalled())
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.get).toHaveBeenCalledTimes(1)

        child.exit()
        const exitCode = await running
        expect(exitCode).toBe(0)
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as { status?: string }
        expect(lastPatch.status).toBe('completed')
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.get).toHaveBeenCalledTimes(1)
    })

    it('marks failed on non-zero exit', async () => {
        const http = {
            post: vi.fn(async () => ({ status: 200, data: { token: 'jwt' } })),
            get: vi.fn(async () => ({
                status: 200,
                data: { sessions: [{ id: 'aaaaaaaa-1111-1111-1111-111111111111' }] }
            })),
            put: vi.fn(async () => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: 'running',
                        heartbeatAt: 1,
                        startedAt: 1,
                        updatedAt: 1
                    }
                }
            })),
            patch: vi.fn(async (_url: string, body: { status?: string }) => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: body.status ?? 'running',
                        heartbeatAt: 2,
                        startedAt: 1,
                        updatedAt: 2
                    }
                }
            }))
        }

        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['false'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(7)) as never,
            setIntervalImpl: ((() => 1) as never),
            clearIntervalImpl: (() => undefined) as never
        })

        expect(exitCode).toBe(7)
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as { status?: string }
        expect(lastPatch.status).toBe('failed')
    })
})
