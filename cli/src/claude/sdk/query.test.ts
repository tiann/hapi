import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const killProcessMock = vi.fn(async (child: any) => {
    child.killed = true
    child.stdout.end()
    child.emit('close', 0)
})

vi.mock('node:child_process', () => ({
    ...require('node:child_process'),
    spawn: spawnMock
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: () => false,
    isWindows: () => false,
    killProcess: async () => true,
    killProcessByChildProcess: killProcessMock
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

vi.mock('../utils/mcpConfig', () => ({
    appendMcpConfigArg: () => null
}))

function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        killed: boolean
    }

    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    return child
}

afterEach(() => {
    vi.clearAllMocks()
    delete process.env.HAPI_CLAUDE_PATH
})

describe('Query', () => {
    it('preserves externally set errors even if the process exits cleanly', async () => {
        const { Query } = await import('./query')
        const stdout = new PassThrough()
        const query = new Query(null, stdout, Promise.resolve())

        query.setError(new Error('prompt failed'))
        stdout.end()

        await expect(query.next()).rejects.toThrow('prompt failed')
    })

    describe('getContextUsage', () => {
        it('sends a get_context_usage control request and resolves with maxTokens/model', async () => {
            const { Query } = await import('./query')
            const stdin = new PassThrough()
            const stdout = new PassThrough()
            const query = new Query(stdin, stdout, new Promise(() => {}))

            let written = ''
            stdin.on('data', (chunk) => { written += chunk.toString() })

            const resultPromise = query.getContextUsage()
            await new Promise((resolve) => setImmediate(resolve))
            const request = JSON.parse(written.trim())
            expect(request.type).toBe('control_request')
            expect(request.request).toEqual({ subtype: 'get_context_usage' })

            stdout.write(JSON.stringify({
                type: 'control_response',
                response: {
                    request_id: request.request_id,
                    subtype: 'success',
                    response: {
                        maxTokens: 967_000,
                        rawMaxTokens: 1_000_000,
                        model: 'claude-sonnet-5',
                        autoCompactThreshold: 934_000
                    }
                }
            }) + '\n')

            await expect(resultPromise).resolves.toEqual({ maxTokens: 967_000, model: 'claude-sonnet-5' })
        })

        it('resolves null when the prompt is a string (no stdin available)', async () => {
            const { Query } = await import('./query')
            const stdout = new PassThrough()
            const query = new Query(null, stdout, new Promise(() => {}))

            await expect(query.getContextUsage()).resolves.toBeNull()
        })

        it('resolves null (not a rejection) when Claude answers with a control error', async () => {
            const { Query } = await import('./query')
            const stdin = new PassThrough()
            const stdout = new PassThrough()
            const query = new Query(stdin, stdout, new Promise(() => {}))

            let written = ''
            stdin.on('data', (chunk) => { written += chunk.toString() })
            const resultPromise = query.getContextUsage()
            await new Promise((resolve) => setImmediate(resolve))
            const request = JSON.parse(written.trim())

            stdout.write(JSON.stringify({
                type: 'control_response',
                response: { request_id: request.request_id, subtype: 'error', error: 'not supported' }
            }) + '\n')

            await expect(resultPromise).resolves.toBeNull()
        })

        it('resolves null when the response omits maxTokens', async () => {
            const { Query } = await import('./query')
            const stdin = new PassThrough()
            const stdout = new PassThrough()
            const query = new Query(stdin, stdout, new Promise(() => {}))

            let written = ''
            stdin.on('data', (chunk) => { written += chunk.toString() })
            const resultPromise = query.getContextUsage()
            await new Promise((resolve) => setImmediate(resolve))
            const request = JSON.parse(written.trim())

            stdout.write(JSON.stringify({
                type: 'control_response',
                response: { request_id: request.request_id, subtype: 'success', response: {} }
            }) + '\n')

            await expect(resultPromise).resolves.toBeNull()
        })

        it('resolves null (does not hang forever) when no response ever arrives within the timeout', async () => {
            vi.useFakeTimers()
            const { Query } = await import('./query')
            const stdin = new PassThrough()
            const stdout = new PassThrough()
            const query = new Query(stdin, stdout, new Promise(() => {}))

            const resultPromise = query.getContextUsage()
            const settled = vi.fn()
            void resultPromise.then(settled, settled)

            await vi.advanceTimersByTimeAsync(29_000)
            expect(settled).not.toHaveBeenCalled()

            await vi.advanceTimersByTimeAsync(1_000)
            await expect(resultPromise).resolves.toBeNull()
            vi.useRealTimers()
        })

        it('settles a pending getContextUsage() as soon as the message stream ends (process exit before any response)', async () => {
            const { Query } = await import('./query')
            const stdin = new PassThrough()
            const stdout = new PassThrough()
            const query = new Query(stdin, stdout, Promise.resolve())

            const resultPromise = query.getContextUsage()
            // No control_response is ever written -- simulate the process
            // exiting (stdout closes, processExitPromise resolves) before it
            // answered. readMessages()'s finally must settle this instead of
            // leaving it pending forever.
            stdout.end()

            await expect(resultPromise).resolves.toBeNull()
        })
    })

    it('propagates prompt stream failures through query()', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('fails fast after cleanup timeout when prompt cleanup hangs', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        killProcessMock.mockReturnValueOnce(new Promise<void>(() => {}))
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt, options: { promptFailureCleanupTimeoutMs: 10 } })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('registers an stdin error listener at spawn time, absorbing an async write failure instead of throwing', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = (async function* () {
            yield { type: 'user', message: { role: 'user', content: 'hello' } }
            // Keep the generator open so streamToStdin doesn't end child.stdin
            // on its own before this test gets to simulate the failure.
            await new Promise(() => {})
        })()

        const result = query({ prompt })

        // Node delivers stream errors (e.g. EPIPE from a write after the
        // child has already gone away, or ERR_STREAM_DESTROYED from cleanup()
        // having already destroyed stdin) asynchronously via
        // process.nextTick, never synchronously from inside write() itself.
        // Unhandled, that becomes an uncaughtException outside any promise
        // chain -- run.ts's global handler treats any uncaughtException as
        // fatal (requestShutdown) -- not a rejection any try/catch here
        // could mask.
        process.nextTick(() => {
            child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        })
        await new Promise((resolve) => setImmediate(resolve))

        // Reaching here without vitest reporting an Unhandled Error is the
        // assertion. Let the query settle so it doesn't leak into other tests.
        result.setError(new Error('test cleanup'))
        child.stdout.end()
        child.emit('close', 0)
    })

    it('places additional launch arguments before HAPI settings', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        query({
            prompt: 'hello',
            options: {
                additionalArgs: ['--plugin-dir', '/tmp/plugin'],
                settingsPath: '/tmp/hapi-settings.json'
            }
        })

        const args = spawnMock.mock.calls[0][1] as string[]
        expect(args.indexOf('--plugin-dir')).toBeLessThan(args.indexOf('--settings'))
        child.stdout.end()
        child.emit('close', 0)
    })
})
