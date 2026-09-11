import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const getDefaultClaudeCodePathMock = vi.hoisted(() => vi.fn(() => 'claude'))
vi.mock('@/claude/sdk/utils', () => ({ getDefaultClaudeCodePath: getDefaultClaudeCodePathMock }))

const killProcessByChildProcessMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/utils/process', () => ({ killProcessByChildProcess: killProcessByChildProcessMock }))

import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { _resetClaudeModelsCacheForTests, listClaudeModelsForCwd } from './claudeModels'

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        // A real Writable (like child.stdin) is an EventEmitter that can
        // itself emit 'error' -- distinct from the ChildProcess's own
        // 'error' event, which only covers spawn failures. Modeling stdin as
        // an EventEmitter (not a bare `{ write }` stub) lets tests reproduce
        // an EPIPE-style write-after-exit failure the way Node actually
        // delivers it.
        stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
    })
}

// The probe generates its own request_id (randomUUID()) at write time and
// now only resolves a control_response carrying that
// exact id -- so tests must read the id the source actually sent instead of
// hardcoding one, or every response line here would look like a stray
// unrelated response and every test would hang until the probe's own
// timeout.
function capturedRequestId(child: ReturnType<typeof fakeChild>): string {
    const written = child.stdin.write.mock.calls[0][0] as string
    return JSON.parse(written).request_id
}

function controlResponseLine(models: unknown[], requestId: string) {
    return JSON.stringify({
        type: 'control_response',
        response: {
            request_id: requestId,
            subtype: 'success',
            response: { models }
        }
    }) + '\n'
}

const SAMPLE_MODELS = [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', supportsFastMode: false, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportsFastMode: false }
]

beforeEach(() => {
    vi.useRealTimers()
    spawnMock.mockReset()
    getDefaultClaudeCodePathMock.mockReset()
    getDefaultClaudeCodePathMock.mockReturnValue('claude')
    killProcessByChildProcessMock.mockClear()
    _resetClaudeModelsCacheForTests()
})

describe('listClaudeModelsForCwd', () => {
    it('returns success false when cwd is empty', async () => {
        const result = await listClaudeModelsForCwd('')
        expect(result).toEqual({ success: false, error: 'cwd is required' })
        expect(spawnMock).not.toHaveBeenCalled()
    })

    it('spawns a headless claude probe scoped to cwd and parses list_models', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const resultPromise = listClaudeModelsForCwd('/home/user/project')

        expect(spawnMock).toHaveBeenCalledWith('claude', [
            '-p',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            '--strict-mcp-config',
            '--setting-sources', 'user'
        ], expect.objectContaining({
            cwd: '/home/user/project',
            // Matches every other claude spawn in this repo (query.ts,
            // claudeLocal.ts) -- without this, a stray BUN_BE_BUN inherited
            // from the parent HAPI process can make the claude binary itself
            // try to run under Bun's Node-compat shim.
            env: withBunRuntimeEnv(process.env, { allowBunBeBun: false })
        }))

        // No prompt is ever written -- only the control request.
        const written = child.stdin.write.mock.calls[0][0] as string
        const request = JSON.parse(written)
        expect(request.type).toBe('control_request')
        expect(request.request).toEqual({ subtype: 'list_models' })

        child.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, request.request_id)))

        const result = await resultPromise
        expect(result.success).toBe(true)
        expect(result.models).toEqual(SAMPLE_MODELS.map((model) => ({
            value: model.value,
            displayName: model.displayName,
            resolvedModel: model.resolvedModel,
            // supportsFastMode is deliberately absent from the parsed output:
            // it had zero readers anywhere in cli/hub/shared/web, so this PR
            // doesn't parse or expose it. A future
            // fast-mode-toggle PR adds it back alongside its consumer.
            ...(model.supportedEffortLevels ? { supportedEffortLevels: model.supportedEffortLevels } : {})
        })))
        // Kills the whole process tree (not a bare child.kill()) -- a `claude
        // -p` invocation can spawn its own subprocesses that would otherwise
        // be orphaned.
        expect(killProcessByChildProcessMock).toHaveBeenCalledWith(child, true)
    })

    it('excludes project .claude/settings*.json from the probe so a project SessionStart hook cannot run', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const resultPromise = listClaudeModelsForCwd('/home/user/project')

        const [, spawnArgs] = spawnMock.mock.calls[0] as [string, string[]]
        const flagIndex = spawnArgs.indexOf('--setting-sources')
        expect(flagIndex).toBeGreaterThanOrEqual(0)
        // 'user' (not '') -- the probe still needs user-level settings to
        // resolve a catalog in auth-dependent setups; only the project
        // scope, which an arbitrary un-trusted cwd controls, is excluded.
        expect(spawnArgs[flagIndex + 1]).toBe('user')

        child.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, capturedRequestId(child))))
        await resultPromise
    })

    it('caches a successful response for the cwd and does not spawn again within the TTL', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const firstPromise = listClaudeModelsForCwd('/home/user/project')
        child.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, capturedRequestId(child))))
        await firstPromise

        const second = await listClaudeModelsForCwd('/home/user/project')
        expect(second.success).toBe(true)
        expect(second.models).toHaveLength(SAMPLE_MODELS.length)
        expect(spawnMock).toHaveBeenCalledTimes(1)
    })

    it('coalesces concurrent requests for the same cwd into a single probe (single-flight)', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const first = listClaudeModelsForCwd('/home/user/project')
        const second = listClaudeModelsForCwd('/home/user/project')

        child.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, capturedRequestId(child))))

        const [firstResult, secondResult] = await Promise.all([first, second])
        expect(spawnMock).toHaveBeenCalledTimes(1)
        expect(firstResult.success).toBe(true)
        expect(secondResult.success).toBe(true)
    })

    it('does not cache a failed probe (spawn error)', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const firstPromise = listClaudeModelsForCwd('/home/user/project')
        child.emit('error', new Error('spawn ENOENT'))
        const first = await firstPromise
        expect(first.success).toBe(false)

        const child2 = fakeChild()
        spawnMock.mockReturnValue(child2)
        const secondPromise = listClaudeModelsForCwd('/home/user/project')
        child2.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, capturedRequestId(child2))))
        const second = await secondPromise

        expect(spawnMock).toHaveBeenCalledTimes(2)
        expect(second.success).toBe(true)
    })

    it('does not cache an empty model list', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const firstPromise = listClaudeModelsForCwd('/home/user/project')
        child.stdout.emit('data', Buffer.from(controlResponseLine([], capturedRequestId(child))))
        const first = await firstPromise
        expect(first.success).toBe(false)

        const child2 = fakeChild()
        spawnMock.mockReturnValue(child2)
        const secondPromise = listClaudeModelsForCwd('/home/user/project')
        child2.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, capturedRequestId(child2))))
        await secondPromise

        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it('ignores a control_response for a different request_id before its own reply arrives', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const resultPromise = listClaudeModelsForCwd('/home/user/project')

        const requestId = capturedRequestId(child)

        // A stray control_response for an unrelated request_id (this same
        // claude process can field other control requests, e.g. a
        // permission prompt) arrives first. Without request_id filtering,
        // this response's absent `models` field normalizes to `[]`, and the
        // probe fails with the misleading "Claude reported no models"
        // instead of waiting for the actual list_models reply -- and the
        // real reply below would then be silently dropped since the probe
        // already settled.
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            type: 'control_response',
            response: { request_id: 'unrelated-request-id', subtype: 'success', response: {} }
        }) + '\n'))

        child.stdout.emit('data', Buffer.from(JSON.stringify({
            type: 'control_response',
            response: { request_id: requestId, subtype: 'success', response: { models: SAMPLE_MODELS } }
        }) + '\n'))

        const result = await resultPromise
        expect(result.success).toBe(true)
        expect(result.models).toHaveLength(SAMPLE_MODELS.length)
    })

    it('does not throw when stdin write hits a dead pipe', async () => {
        const child = fakeChild()
        // Simulate a child that has already gone away by the time the probe
        // writes its control request: Node emits 'error' (e.g. EPIPE)
        // directly on the stdin stream in that case, separate from the
        // ChildProcess's own 'error' event (spawn failures only). Without a
        // listener, an unhandled 'error' event is a hard throw straight out
        // of listClaudeModelsForCwd -- which, in the real CLI process,
        // becomes an uncaughtException that takes the whole runner daemon
        // down (run.ts's global handler calls requestShutdown for any
        // uncaughtException).
        //
        // Node delivers stream errors via errorOrDestroy -> process.nextTick,
        // never synchronously from inside write() itself. Emitting
        // synchronously here would turn into a same-tick promise rejection
        // that the source's try/catch swallows whether or not the stdin
        // 'error' listener exists, so the test would stay green with the fix
        // removed and assert nothing. Scheduling via nextTick reproduces the
        // real delivery path: unhandled, it becomes an uncaughtException
        // outside any promise chain, which is the failure mode being guarded
        // against.
        child.stdin.write = vi.fn(() => {
            process.nextTick(() => {
                child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
            })
            return false
        })
        spawnMock.mockReturnValue(child)

        const resultPromise = listClaudeModelsForCwd('/home/user/project')

        // The dead child still exits shortly after the broken pipe in real
        // life; its 'exit' handler is what actually settles the probe here.
        child.emit('exit', 1)

        const result = await resultPromise
        expect(result.success).toBe(false)
    })

    it('kills the process and resolves failure on timeout', async () => {
        vi.useFakeTimers()
        const child = fakeChild()
        spawnMock.mockReturnValue(child)

        const resultPromise = listClaudeModelsForCwd('/home/user/project')
        await vi.advanceTimersByTimeAsync(30_000)
        const result = await resultPromise

        expect(result.success).toBe(false)
        expect(killProcessByChildProcessMock).toHaveBeenCalledWith(child, true)
    })

    it('caches per-cwd independently', async () => {
        const childA = fakeChild()
        spawnMock.mockReturnValueOnce(childA)
        const promiseA = listClaudeModelsForCwd('/home/user/project-a')
        childA.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, capturedRequestId(childA))))
        await promiseA

        const childB = fakeChild()
        spawnMock.mockReturnValueOnce(childB)
        const promiseB = listClaudeModelsForCwd('/home/user/project-b')
        childB.stdout.emit('data', Buffer.from(controlResponseLine(SAMPLE_MODELS, capturedRequestId(childB))))
        await promiseB

        expect(spawnMock).toHaveBeenCalledTimes(2)
    })
})
