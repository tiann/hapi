import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_JOB_JWT_REFRESH_AFTER_MS, resolveSessionJobClient, updateSessionJob } from './sessionJob'
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
    it('until heartbeats re-stamp remaining against explicit window startedAt', async () => {
        const windowStart = Date.parse('2098-12-01T00:00:00.000Z')
        const until = Date.parse('2099-01-01T00:00:00.000Z')
        const nowMs = Date.parse('2098-12-15T00:00:00.000Z')
        const http = {
            post: vi.fn(async () => ({ status: 200, data: { token: 'jwt' } })),
            get: vi.fn(async () => ({
                status: 200,
                data: { sessions: [{ id: 'aaaaaaaa-1111-1111-1111-111111111111' }] }
            })),
            put: vi.fn(async (_url: string, body: { startedAt?: number }) => ({
                status: 200,
                data: {
                    job: {
                        key: 'dogfood',
                        label: 'dogfood',
                        status: 'running',
                        heartbeatAt: 1,
                        startedAt: body.startedAt ?? 1,
                        updatedAt: 1
                    }
                }
            })),
            patch: vi.fn(async (_url: string, _body: {
                remaining?: number
                total?: number
                unit?: string
                expectedRunId?: string
            }) => ({
                status: 200,
                data: {
                    job: {
                        key: 'dogfood',
                        label: 'dogfood',
                        status: 'running',
                        heartbeatAt: 2,
                        startedAt: windowStart,
                        updatedAt: 2
                    }
                }
            }))
        }

        const timers: Array<() => void> = []
        const child = fakeChild(0, true)
        const running = runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'dogfood',
            label: 'dogfood',
            command: ['sleep', '999999'],
            untilMs: until,
            startedAtMs: windowStart,
            remaining: Math.ceil((until - nowMs) / 1000),
            total: Math.ceil((until - windowStart) / 1000),
            unit: 's',
            heartbeatMs: 10,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            nowImpl: () => nowMs,
            spawnImpl: (() => child) as never,
            setIntervalImpl: ((fn: () => void) => {
                timers.push(fn)
                return 1 as unknown as NodeJS.Timeout
            }) as never,
            clearIntervalImpl: (() => undefined) as never
        })

        await vi.waitFor(() => expect(http.put).toHaveBeenCalled())
        expect(http.put.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            startedAt: windowStart,
            remaining: Math.ceil((until - nowMs) / 1000),
            total: Math.ceil((until - windowStart) / 1000)
        }))

        timers[0]!()
        await vi.waitFor(() => expect(http.patch).toHaveBeenCalled())
        expect(http.patch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            remaining: Math.ceil((until - nowMs) / 1000),
            total: Math.ceil((until - windowStart) / 1000),
            unit: 's'
        }))

        child.exit()
        await expect(running).resolves.toBe(0)
    })

    it('sets running, heartbeats, then marks completed on exit 0', async () => {
        const http = {
            post: vi.fn(async () => ({ status: 200, data: { token: 'jwt' } })),
            get: vi.fn(async () => ({
                status: 200,
                data: { sessions: [{ id: 'aaaaaaaa-1111-1111-1111-111111111111' }] }
            })),
            put: vi.fn(async (_url: string, body: { status?: string; startedAt?: number }) => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: body.status ?? 'running',
                        heartbeatAt: 1,
                        startedAt: body.startedAt ?? 1,
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
        expect(http.put.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            status: 'running',
            runId: expect.any(String)
        }))
        expect((http.put.mock.calls[0]?.[1] as { startedAt?: number }).startedAt).toBeUndefined()
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.get).toHaveBeenCalledTimes(1)

        // Heartbeat ticks reuse resolved client (no extra auth) and must not
        // send status:running (late heartbeat must not resurrect after exit).
        expect(timers.length).toBe(1)
        timers[0]!()
        await vi.waitFor(() => expect(http.patch).toHaveBeenCalled())
        const putRunId = (http.put.mock.calls[0]?.[1] as { runId: string }).runId
        expect(putRunId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        )
        const heartbeatBody = http.patch.mock.calls[0]?.[1] as {
            status?: string
            expectedRunId?: string
        }
        expect(heartbeatBody.status).toBeUndefined()
        expect(heartbeatBody.expectedRunId).toBe(putRunId)
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.get).toHaveBeenCalledTimes(1)

        child.exit()
        const exitCode = await running
        expect(exitCode).toBe(0)
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as {
            status?: string
            expectedRunId?: string
        }
        expect(lastPatch.status).toBe('completed')
        expect(lastPatch.expectedRunId).toBe(putRunId)
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.get).toHaveBeenCalledTimes(1)
    })

    it('does not mark terminal when hub reports run mismatch (key reused)', async () => {
        const http = {
            post: vi.fn(async () => ({ status: 200, data: { token: 'jwt' } })),
            get: vi.fn(async () => ({
                status: 200,
                data: { sessions: [{ id: 'aaaaaaaa-1111-1111-1111-111111111111' }] }
            })),
            put: vi.fn(async (_url: string, body: { startedAt?: number }) => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: 'running',
                        heartbeatAt: 1,
                        startedAt: body.startedAt ?? 1,
                        updatedAt: 1
                    }
                }
            })),
            patch: vi.fn(async () => ({
                status: 409,
                data: { error: 'Job run mismatch' }
            }))
        }

        const child = fakeChild(0, true)
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const running = runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => child) as never,
            setIntervalImpl: ((() => 1) as unknown as typeof setInterval),
            clearIntervalImpl: (() => undefined) as never,
            sleepImpl: async () => undefined
        })
        await vi.waitFor(() => expect(http.put).toHaveBeenCalled())
        child.exit()
        const exitCode = await running
        expect(exitCode).toBe(0)
        expect(http.patch).toHaveBeenCalledTimes(1)
        expect(err).toHaveBeenCalledWith(expect.stringMatching(/run mismatch|Job run mismatch/i))
        err.mockRestore()
    })

    it('retries terminal status write after transient failures', async () => {
        let patchCalls = 0
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
            patch: vi.fn(async (_url: string, body: { status?: string }) => {
                patchCalls += 1
                if (body.status === 'completed' && patchCalls < 3) {
                    throw new Error('transient hub 503')
                }
                return {
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
                }
            })
        }

        const sleeps: number[] = []
        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(0)) as never,
            setIntervalImpl: ((() => 1) as never),
            clearIntervalImpl: (() => undefined) as never,
            sleepImpl: async (ms) => { sleeps.push(ms) }
        })

        expect(exitCode).toBe(0)
        expect(patchCalls).toBe(3)
        expect(sleeps).toEqual([1_000, 2_000])
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as { status?: string }
        expect(lastPatch.status).toBe('completed')
    })

    it('exits 0 when child succeeds but meter was cleared before terminal write', async () => {
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
            patch: vi.fn(async (_url: string, body: { status?: string }) => {
                if (body.status === 'completed') {
                    return { status: 404, data: { error: 'job not found' } }
                }
                return {
                    status: 200,
                    data: {
                        job: {
                            key: 'drain',
                            label: 'drain',
                            status: 'running',
                            heartbeatAt: 2,
                            startedAt: 1,
                            updatedAt: 2
                        }
                    }
                }
            })
        }

        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(0)) as never,
            setIntervalImpl: ((() => 1) as never),
            clearIntervalImpl: (() => undefined) as never,
            sleepImpl: async () => undefined
        })

        expect(exitCode).toBe(0)
        expect(http.patch).toHaveBeenCalled()
    })

    it('exits 1 when child succeeds but terminal status never persists', async () => {
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
            patch: vi.fn(async () => {
                // Non-connection failure: short retry budget only (3 attempts).
                throw new Error('permanent write rejected')
            })
        }

        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(0)) as never,
            setIntervalImpl: ((() => 1) as never),
            clearIntervalImpl: (() => undefined) as never,
            sleepImpl: async () => undefined
        })

        expect(exitCode).toBe(1)
        expect(http.patch).toHaveBeenCalledTimes(3)
        expect(err).toHaveBeenCalledWith(expect.stringMatching(/failed to mark job completed/i))
        err.mockRestore()
    })

    it('exits 1 when hub stays unreachable past the terminal hub-down deadline', async () => {
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
            patch: vi.fn(async () => {
                throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3006'), {
                    code: 'ECONNREFUSED'
                })
            })
        }

        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        let nowMs = 0
        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(0)) as never,
            setIntervalImpl: ((() => 1) as never),
            clearIntervalImpl: (() => undefined) as never,
            sleepImpl: async (ms) => { nowMs += ms },
            nowImpl: () => nowMs,
            terminalHubDownDeadlineMs: 8_000
        })

        expect(exitCode).toBe(1)
        expect(http.patch.mock.calls.length).toBeGreaterThan(3)
        expect(err).toHaveBeenCalledWith(expect.stringMatching(/hub unreachable after child exit/i))
        expect(err).toHaveBeenCalledWith(expect.stringMatching(/failed to mark job completed/i))
        err.mockRestore()
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

    it('re-exchanges JWT on heartbeat 401 and still marks completed (hub 4h expiry)', async () => {
        let jwtIssue = 0
        let patchCalls = 0
        const http = {
            post: vi.fn(async () => {
                jwtIssue += 1
                return { status: 200, data: { token: `jwt-${jwtIssue}` } }
            }),
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
            patch: vi.fn(async (_url: string, body: { status?: string }, cfg?: { headers?: Record<string, string> }) => {
                patchCalls += 1
                const auth = cfg?.headers?.Authorization ?? ''
                // First heartbeat still carries jwt-1 after hub expiry → 401.
                if (patchCalls === 1 && auth.includes('jwt-1')) {
                    return { status: 401, data: { error: 'expired' } }
                }
                return {
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
                }
            })
        }

        const timers: Array<() => void> = []
        const child = fakeChild(0, true)
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
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

        timers[0]!()
        await vi.waitFor(() => expect(http.post).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(http.patch.mock.calls.length).toBeGreaterThanOrEqual(2))
        // Session list not re-fetched — only JWT refresh.
        expect(http.get).toHaveBeenCalledTimes(1)

        child.exit()
        const exitCode = await running
        expect(exitCode).toBe(0)
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as { status?: string }
        expect(lastPatch.status).toBe('completed')
        errSpy.mockRestore()
    })

    it('proactively re-exchanges JWT after 3h without re-listing sessions', async () => {
        let jwtIssue = 0
        const http = {
            post: vi.fn(async () => {
                jwtIssue += 1
                return { status: 200, data: { token: `jwt-${jwtIssue}` } }
            }),
            get: vi.fn(async () => ({
                status: 200,
                data: { sessions: [{ id: 'aaaaaaaa-1111-1111-1111-111111111111' }] }
            })),
            patch: vi.fn(async (_url: string, _body: unknown, cfg?: { headers?: Record<string, string> }) => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: 'running',
                        heartbeatAt: 2,
                        startedAt: 1,
                        updatedAt: 2
                    },
                    _auth: cfg?.headers?.Authorization
                }
            }))
        }

        const resolved = await resolveSessionJobClient({
            sessionIdPrefix: 'aaaa',
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never
        })
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.get).toHaveBeenCalledTimes(1)

        // Inside the window: no second exchange.
        await updateSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            body: { remaining: 9 },
            resolved,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never
        })
        expect(http.post).toHaveBeenCalledTimes(1)

        // Past proactive refresh threshold: exchange once, keep session id.
        resolved.jwtIssuedAtMs = Date.now() - SESSION_JOB_JWT_REFRESH_AFTER_MS - 1
        await updateSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            body: { remaining: 8 },
            resolved,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never
        })
        expect(http.post).toHaveBeenCalledTimes(2)
        expect(http.get).toHaveBeenCalledTimes(1)
        expect(resolved.jwt).toBe('jwt-2')
        const auth = (http.patch.mock.calls.at(-1)?.[2] as { headers?: Record<string, string> } | undefined)
            ?.headers?.Authorization
        expect(auth).toContain('jwt-2')

        // Next tick inside the new window: no exchange storm.
        await updateSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            body: { remaining: 7 },
            resolved,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never
        })
        expect(http.post).toHaveBeenCalledTimes(2)
        expect(http.get).toHaveBeenCalledTimes(1)
    })

    it('forwards SIGINT/SIGTERM via tree-kill so grandchildren cannot outlive the job', async () => {
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
                        runId: 'run-1',
                        heartbeatAt: 1,
                        startedAt: 1,
                        updatedAt: 1
                    }
                }
            })),
            patch: vi.fn(async () => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: 'completed',
                        runId: 'run-1',
                        heartbeatAt: 2,
                        startedAt: 1,
                        updatedAt: 2
                    }
                }
            }))
        }

        const child = fakeChild(0, true)
        const killChild = vi.fn(async () => true)
        const running = runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['sleep', '30'],
            heartbeatMs: 60_000,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => child) as never,
            setIntervalImpl: (() => 1 as unknown as NodeJS.Timeout) as never,
            clearIntervalImpl: (() => undefined) as never,
            killChildImpl: killChild
        })

        await vi.waitFor(() => expect(http.put).toHaveBeenCalled())
        process.emit('SIGINT')
        expect(killChild).toHaveBeenCalledWith(child, 'SIGINT')
        child.exit()
        await running
    })

    it('awaits verified tree-kill before writing terminal job state', async () => {
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
                        runId: 'run-1',
                        heartbeatAt: 1,
                        startedAt: 1,
                        updatedAt: 1
                    }
                }
            })),
            patch: vi.fn(async (
                _url: string,
                body: { status?: string; detail?: string }
            ) => ({
                status: 200,
                data: {
                    job: {
                        key: 'drain',
                        label: 'drain',
                        status: body.status ?? 'failed',
                        runId: 'run-1',
                        heartbeatAt: 2,
                        startedAt: 1,
                        updatedAt: 2,
                        ...(body.detail !== undefined ? { detail: body.detail } : {}),
                    }
                }
            }))
        }

        let resolveKill: ((ok: boolean) => void) | undefined
        const killChild = vi.fn(() => new Promise<boolean>((resolve) => {
            resolveKill = resolve
        }))
        const child = fakeChild(0, true)
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const running = runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['sleep', '30'],
            heartbeatMs: 60_000,
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => child) as never,
            setIntervalImpl: (() => 1 as unknown as NodeJS.Timeout) as never,
            clearIntervalImpl: (() => undefined) as never,
            killChildImpl: killChild
        })

        await vi.waitFor(() => expect(http.put).toHaveBeenCalled())
        process.emit('SIGTERM')
        expect(killChild).toHaveBeenCalledWith(child, 'SIGTERM')
        child.exit()

        // Child exited, but tree-kill still pending → no terminal write yet.
        await Promise.resolve()
        expect(http.patch).not.toHaveBeenCalled()

        resolveKill?.(false)
        const exitCode = await running
        expect(exitCode).toBe(1)
        const lastPatch = http.patch.mock.calls.at(-1)?.[1]
        expect(lastPatch?.status).toBe('failed')
        expect(lastPatch?.detail).toMatch(/complete child process tree/i)
        expect(err).toHaveBeenCalledWith(expect.stringMatching(/complete child process tree/i))
        err.mockRestore()
    })

    it('keeps retrying terminal completed after ECONNREFUSED until hub returns (hub restart)', async () => {
        let patchCalls = 0
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
                        key: 'restart-hub',
                        label: 'restart',
                        status: 'running',
                        heartbeatAt: 1,
                        startedAt: 1,
                        updatedAt: 1
                    }
                }
            })),
            patch: vi.fn(async (_url: string, body: { status?: string }) => {
                patchCalls += 1
                if (body.status === 'completed' && patchCalls < 6) {
                    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3006'), {
                        code: 'ECONNREFUSED'
                    })
                }
                return {
                    status: 200,
                    data: {
                        job: {
                            key: 'restart-hub',
                            label: 'restart',
                            status: body.status ?? 'running',
                            heartbeatAt: 2,
                            startedAt: 1,
                            updatedAt: 2
                        }
                    }
                }
            })
        }

        const sleeps: number[] = []
        let nowMs = 0
        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'restart-hub',
            label: 'restart',
            command: ['true'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(0)) as never,
            setIntervalImpl: ((() => 1) as never),
            clearIntervalImpl: (() => undefined) as never,
            sleepImpl: async (ms) => {
                sleeps.push(ms)
                nowMs += ms
            },
            nowImpl: () => nowMs,
            terminalHubDownDeadlineMs: 60_000
        })

        expect(exitCode).toBe(0)
        expect(patchCalls).toBe(6)
        expect(sleeps.length).toBeGreaterThanOrEqual(5)
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as { status?: string }
        expect(lastPatch.status).toBe('completed')
    })

    it('treats structured HTTP 503 as hub-down for the long terminal retry window', async () => {
        let patchCalls = 0
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
            patch: vi.fn(async (_url: string, body: { status?: string }) => {
                patchCalls += 1
                if (body.status === 'completed' && patchCalls < 5) {
                    // Hub returns JSON error text without "HTTP 503" in the message —
                    // classification must use the numeric status, not the detail string.
                    return { status: 503, data: { error: 'Not connected' } }
                }
                return {
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
                }
            })
        }

        let nowMs = 0
        const exitCode = await runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'drain',
            label: 'drain',
            command: ['true'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never,
            spawnImpl: (() => fakeChild(0)) as never,
            setIntervalImpl: ((() => 1) as never),
            clearIntervalImpl: (() => undefined) as never,
            sleepImpl: async (ms) => { nowMs += ms },
            nowImpl: () => nowMs,
            terminalHubDownDeadlineMs: 60_000
        })

        expect(exitCode).toBe(0)
        expect(patchCalls).toBe(5)
        const lastPatch = http.patch.mock.calls.at(-1)?.[1] as { status?: string }
        expect(lastPatch.status).toBe('completed')
    })

    it('refuses wrapping hapi-restart-hub in job run before creating a meter', async () => {
        const http = {
            post: vi.fn(async () => ({ status: 200, data: { token: 'jwt' } })),
            get: vi.fn(async () => ({
                status: 200,
                data: { sessions: [{ id: 'aaaaaaaa-1111-1111-1111-111111111111' }] }
            })),
            put: vi.fn(),
            patch: vi.fn()
        }

        await expect(runSessionJob({
            sessionIdPrefix: 'aaaa',
            jobKey: 'restart-hub',
            label: 'Patient hub restart',
            command: ['env', 'HAPI_AGENT_LABEL=x', 'hapi-restart-hub'],
            accessToken: 'token',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never
        })).rejects.toMatchObject({
            code: 'bad_args',
            message: expect.stringMatching(/hapi-restart-hub|outside the job|hub restart/i)
        })
        expect(http.put).not.toHaveBeenCalled()
        expect(http.patch).not.toHaveBeenCalled()
    })
})
