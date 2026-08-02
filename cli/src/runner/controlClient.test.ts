import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readRunnerStateMock, isProcessAliveMock } = vi.hoisted(() => ({
    readRunnerStateMock: vi.fn(),
    isProcessAliveMock: vi.fn(),
}))

vi.mock('@/persistence', () => ({
    readRunnerState: readRunnerStateMock,
    readSettings: vi.fn(),
    clearRunnerState: vi.fn(),
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: isProcessAliveMock,
    isHapiRunnerProcess: vi.fn(() => true),
    killProcess: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { stopRunnerSession } from './controlClient'

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
