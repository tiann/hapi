import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
    FOREGROUND_REPLACEMENT_READY,
    waitForForegroundReplacementReady,
    waitForOldRunnerThenStart
} from './foregroundReplacement'

describe('foreground replacement handoff', () => {
    it('does not accept spawn alone and waits for the helper readiness record', async () => {
        const stdout = new PassThrough()
        let resolveExit!: () => void
        const exited = new Promise<void>((resolve) => { resolveExit = resolve })
        const readiness = waitForForegroundReplacementReady({ stdout, exited, timeoutMs: 100 })

        stdout.write(`${FOREGROUND_REPLACEMENT_READY}\n`)
        await expect(readiness).resolves.toBe(true)
        resolveExit()
    })

    it('fails when the helper exits before its readiness record', async () => {
        const stdout = new PassThrough()
        const readiness = waitForForegroundReplacementReady({
            stdout,
            exited: Promise.resolve(),
            timeoutMs: 100
        })

        await expect(readiness).resolves.toBe(false)
    })

    it('starts only after the old runner exits and retries a failed start', async () => {
        const alive = [true, true, false]
        const startRunner = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
        const sleep = vi.fn(async () => undefined)

        await expect(waitForOldRunnerThenStart({
            oldPid: 123,
            isAlive: () => alive.shift() ?? false,
            startRunner,
            sleep,
            waitTimeoutMs: 1_000,
            maxStartAttempts: 2
        })).resolves.toBe(true)
        expect(startRunner).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalled()
    })
})
