import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readRunnerStateMock, isProcessAliveMock, identityMock, killProcessMock } = vi.hoisted(() => ({
    readRunnerStateMock: vi.fn(),
    isProcessAliveMock: vi.fn(),
    identityMock: vi.fn(),
    killProcessMock: vi.fn(),
}))

vi.mock('@/persistence', () => ({
    readRunnerState: readRunnerStateMock,
    readSettings: vi.fn(),
    clearRunnerState: vi.fn(),
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: isProcessAliveMock,
    getHapiRunnerProcessIdentity: identityMock,
    killProcess: killProcessMock,
}))

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { stopRunner, stopRunnerSession } from './controlClient'

describe('runner control client stop-session contract', () => {
    beforeEach(() => {
        readRunnerStateMock.mockResolvedValue({ pid: 42, httpPort: 3210 })
        isProcessAliveMock.mockReturnValue(true)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.clearAllMocks()
    })

    it.each(['stopped', 'already_gone', 'still_alive'] as const)(
        'returns the runner %s status',
        async (status) => {
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })))

            await expect(stopRunnerSession('session-1')).resolves.toBe(status)
        }
    )

    it('fails closed when the runner returns a malformed response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })))

        await expect(stopRunnerSession('session-1')).resolves.toBe('still_alive')
    })
})

describe('stopRunner identity gate', () => {
    beforeEach(() => {
        readRunnerStateMock.mockResolvedValue({ pid: 42, httpPort: 3210 })
        isProcessAliveMock.mockReturnValue(true)
        killProcessMock.mockResolvedValue(true)
        // Graceful HTTP stop always fails here so every case reaches the force-kill decision.
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('connection refused')
        }))
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.clearAllMocks()
    })

    it('stops a confirmed runner', async () => {
        identityMock.mockReturnValue('runner')

        await stopRunner()

        expect(globalThis.fetch).toHaveBeenCalled()
        expect(killProcessMock).toHaveBeenCalledWith(42, true)
    })

    it.each(['foreign', 'unknown', 'dead'] as const)(
        'sends neither the http stop nor a signal when the identity is %s',
        async (identity) => {
            identityMock.mockReturnValue(identity)

            await stopRunner()

            expect(globalThis.fetch).not.toHaveBeenCalled()
            expect(killProcessMock).not.toHaveBeenCalled()
        }
    )
})
