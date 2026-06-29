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

    it('passes --resume and --fork-session to the spawned claude process', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const sessionId = '6f0c4551-1111-4222-8333-444455556666'
        query({ prompt: 'ping', options: { resume: sessionId, forkSession: true } })

        expect(spawnMock).toHaveBeenCalledTimes(1)
        const args = spawnMock.mock.calls[0][1] as string[]
        expect(args).toContain('--resume')
        expect(args[args.indexOf('--resume') + 1]).toBe(sessionId)
        expect(args).toContain('--fork-session')
        // --fork-session must come after --resume so claude treats it as a branch
        expect(args.indexOf('--fork-session')).toBeGreaterThan(args.indexOf('--resume'))
    })

    it('omits --fork-session when forkSession is not set', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        query({ prompt: 'ping', options: { resume: 'some-session-id' } })

        expect(spawnMock).toHaveBeenCalledTimes(1)
        const args = spawnMock.mock.calls[0][1] as string[]
        expect(args).toContain('--resume')
        expect(args).not.toContain('--fork-session')
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
})
