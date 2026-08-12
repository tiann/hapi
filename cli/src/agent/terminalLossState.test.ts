import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Writable } from 'node:stream'

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}))

import {
    markTerminalLost,
    isTerminalLost,
    installTerminalOutputGuard,
    __resetTerminalLossStateForTests
} from './terminalLossState'
import { logger } from '@/ui/logger'

// A real Writable whose _write always fails with the given error — this
// drives errors through Node's actual Writable/EventEmitter machinery
// (write() -> internal write callback -> stream.destroy(err) ->
// emit('error') on next tick), the same path a real stdout/stderr pipe
// takes when the reader (the terminal) is gone. Unlike a hand-rolled
// {on, emitError} stub, nothing here bypasses real stream/event dispatch.
function createErroringWritable(error: NodeJS.ErrnoException): Writable {
    return new Writable({
        write(_chunk, _encoding, callback) {
            callback(error)
        }
    })
}

// Writable's deferred error emission (see above) needs a couple of event
// loop turns to actually fire before we can assert on the outcome.
async function flushMicrotasksAndTicks(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
}

describe('terminalLossState', () => {
    beforeEach(() => {
        __resetTerminalLossStateForTests()
        vi.clearAllMocks()
    })

    afterEach(() => {
        __resetTerminalLossStateForTests()
    })

    it('starts with terminalLost=false', () => {
        expect(isTerminalLost()).toBe(false)
    })

    it('flips to true once markTerminalLost is called and stays true', () => {
        markTerminalLost()
        expect(isTerminalLost()).toBe(true)
        markTerminalLost()
        expect(isTerminalLost()).toBe(true)
    })

    it('swallows an EPIPE raised by a real write() without it escaping as an uncaughtException', async () => {
        const escaped: unknown[] = []
        const onUncaught = (error: unknown) => escaped.push(error)
        process.once('uncaughtException', onUncaught)

        try {
            const stdout = createErroringWritable(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
            const stderr = createErroringWritable(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
            installTerminalOutputGuard({ stdout, stderr })

            stdout.write('hello')
            stderr.write('hello')
            await flushMicrotasksAndTicks()
        } finally {
            process.removeListener('uncaughtException', onUncaught)
        }

        expect(escaped).toEqual([])
    })

    it('swallows an EIO raised by a real write() without it escaping as an uncaughtException', async () => {
        const escaped: unknown[] = []
        const onUncaught = (error: unknown) => escaped.push(error)
        process.once('uncaughtException', onUncaught)

        try {
            const stdout = createErroringWritable(Object.assign(new Error('io error'), { code: 'EIO' }))
            installTerminalOutputGuard({ stdout, stderr: createErroringWritable(Object.assign(new Error('io error'), { code: 'EIO' })) })

            stdout.write('hello')
            await flushMicrotasksAndTicks()
        } finally {
            process.removeListener('uncaughtException', onUncaught)
        }

        expect(escaped).toEqual([])
    })

    it('logs (but does not throw or escape) unexpected stream error codes from a real write()', async () => {
        const escaped: unknown[] = []
        const onUncaught = (error: unknown) => escaped.push(error)
        process.once('uncaughtException', onUncaught)

        try {
            const weirdError = Object.assign(new Error('weird'), { code: 'ENOTCONN' })
            const stdout = createErroringWritable(weirdError)
            installTerminalOutputGuard({ stdout, stderr: createErroringWritable(weirdError) })

            stdout.write('hello')
            await flushMicrotasksAndTicks()
        } finally {
            process.removeListener('uncaughtException', onUncaught)
        }

        expect(escaped).toEqual([])
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining('unexpected stdout stream error'),
            expect.objectContaining({ code: 'ENOTCONN' })
        )
    })

    it('guards the stdin stream when provided, swallowing its errors the same way as stdout/stderr', async () => {
        const escaped: unknown[] = []
        const onUncaught = (error: unknown) => escaped.push(error)
        process.once('uncaughtException', onUncaught)

        try {
            const stdin = createErroringWritable(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
            installTerminalOutputGuard({
                stdout: createErroringWritable(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })),
                stderr: createErroringWritable(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })),
                stdin
            })

            stdin.write('hello')
            await flushMicrotasksAndTicks()
        } finally {
            process.removeListener('uncaughtException', onUncaught)
        }

        expect(escaped).toEqual([])
    })

    it('logs (but does not throw or escape) an unexpected stdin stream error code', async () => {
        const escaped: unknown[] = []
        const onUncaught = (error: unknown) => escaped.push(error)
        process.once('uncaughtException', onUncaught)

        try {
            const weirdError = Object.assign(new Error('weird'), { code: 'ENOTCONN' })
            const stdin = createErroringWritable(weirdError)
            installTerminalOutputGuard({
                stdout: createErroringWritable(weirdError),
                stderr: createErroringWritable(weirdError),
                stdin
            })

            stdin.write('hello')
            await flushMicrotasksAndTicks()
        } finally {
            process.removeListener('uncaughtException', onUncaught)
        }

        expect(escaped).toEqual([])
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining('unexpected stdin stream error'),
            expect.objectContaining({ code: 'ENOTCONN' })
        )
    })

    it('does not double-attach a stdin error listener when installTerminalOutputGuard is called twice with the same explicit streams (idempotent against repeated calls)', () => {
        const stdout = createErroringWritable(new Error('unused'))
        const stderr = createErroringWritable(new Error('unused'))
        const stdin = createErroringWritable(new Error('unused'))

        installTerminalOutputGuard({ stdout, stderr, stdin })
        installTerminalOutputGuard({ stdout, stderr, stdin })

        // Repeated calls with the SAME explicit stream objects must not
        // stack a second listener per stream — that would double-log (or,
        // for a listener that isn't idempotent itself, double-react to)
        // every subsequent stream error.
        expect(stdout.listeners('error')).toHaveLength(1)
        expect(stderr.listeners('error')).toHaveLength(1)
        expect(stdin.listeners('error')).toHaveLength(1)
    })

    it('is idempotent against real process streams (no duplicate-install crash)', () => {
        // installTerminalOutputGuard() with no args attaches to the real,
        // shared process.stdout/stderr — capture the pre-existing listener
        // set so we can remove exactly what this test adds and leave those
        // streams as we found them for every other test file sharing this
        // process.
        const stdoutListenersBefore = process.stdout.listeners('error')
        const stderrListenersBefore = process.stderr.listeners('error')

        try {
            expect(() => {
                installTerminalOutputGuard()
                installTerminalOutputGuard()
            }).not.toThrow()
        } finally {
            for (const listener of process.stdout.listeners('error')) {
                if (!stdoutListenersBefore.includes(listener)) {
                    process.stdout.removeListener('error', listener as (error: NodeJS.ErrnoException) => void)
                }
            }
            for (const listener of process.stderr.listeners('error')) {
                if (!stderrListenersBefore.includes(listener)) {
                    process.stderr.removeListener('error', listener as (error: NodeJS.ErrnoException) => void)
                }
            }
        }
    })
})
