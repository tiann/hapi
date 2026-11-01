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
    it('routes context usage and permission mode responses independently', async () => {
        const { Query } = await import('./query')
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const query = new Query(stdin, stdout, Promise.resolve())

        const contextUsage = query.getContextUsage()
        const contextRequest = JSON.parse(stdin.read().toString())
        const permissionMode = query.setPermissionMode('auto')
        const permissionRequest = JSON.parse(stdin.read().toString())

        expect(contextRequest.request).toEqual({ subtype: 'get_context_usage' })
        expect(permissionRequest.request).toEqual({ subtype: 'set_permission_mode', mode: 'auto' })

        const usage = { model: 'claude-fable-5-1', maxTokens: 200_000 }
        for (const response of [
            { subtype: 'success', request_id: permissionRequest.request_id },
            { subtype: 'success', request_id: contextRequest.request_id, response: usage }
        ]) {
            stdout.write(JSON.stringify({ type: 'control_response', response }) + '\n')
        }

        await expect(permissionMode).resolves.toBeUndefined()
        await expect(contextUsage).resolves.toEqual(usage)
        stdout.end()
    })

    it('rejects unsupported context usage requests without ending the message stream', async () => {
        const { Query } = await import('./query')
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const query = new Query(stdin, stdout, Promise.resolve())

        const contextUsage = query.getContextUsage()
        const request = JSON.parse(stdin.read().toString())
        const rejected = expect(contextUsage).rejects.toThrow('Unsupported request')
        stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'error', request_id: request.request_id, error: 'Unsupported request' }
        }) + '\n')
        await rejected

        const message = { type: 'system', subtype: 'init', model: 'claude-fable-5-1', session_id: 'test-session' }
        stdout.end(JSON.stringify(message) + '\n')
        await expect(query.next()).resolves.toEqual({ value: message, done: false })
        await expect(query.next()).resolves.toEqual({ value: undefined, done: true })
    })

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
