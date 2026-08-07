import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { runSessionJob } from './runSessionJob'

function fakeChild(exitCode: number) {
    const child = new EventEmitter() as EventEmitter & {
        pid: number
        killed: boolean
    }
    child.pid = 4242
    child.killed = false
    queueMicrotask(() => child.emit('exit', exitCode, null))
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
        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            heartbeatMs: 10,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(0)) as never,
            setIntervalImpl: ((fn: () => void) => {
                timers.push(fn)
                return 1 as unknown as NodeJS.Timeout
            }) as never,
            clearIntervalImpl: (() => undefined) as never
        })

        expect(exitCode).toBe(0)
        expect(http.put).toHaveBeenCalled()
        expect(http.patch).toHaveBeenCalled()
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as { status?: string }
        expect(lastPatch.status).toBe('completed')
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
