import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, killMock, claudePathMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    killMock: vi.fn(),
    claudePathMock: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return { ...actual, spawn: spawnMock }
})

vi.mock('../../utils/process', () => ({
    killProcessByChildProcess: killMock,
}))

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: claudePathMock,
}))

import {
    _resetClaudeModelsCacheForTests,
    listClaudeModels,
    parseClaudeModelsProbeLine,
} from './claudeModels'

const PROBE_REQUEST_ID = 'hapi-claude-models-probe'

class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn() })
    pid: number | undefined = 4242

    respond(models: unknown): void {
        this.stdout.emit('data', `${JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: PROBE_REQUEST_ID, response: { models } },
        })}\n`)
    }
}

function successLine(models: unknown, requestId = PROBE_REQUEST_ID): string {
    return JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { models } },
    })
}

const OPUS_ROW = {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
    supportsFastMode: true,
}

let children: FakeChild[]

function lastChild(): FakeChild {
    const child = children.at(-1)
    if (!child) throw new Error('probe was not spawned')
    return child
}

beforeEach(() => {
    _resetClaudeModelsCacheForTests()
    children = []
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
        const child = new FakeChild()
        children.push(child)
        return child
    })
    killMock.mockReset()
    killMock.mockResolvedValue(true)
    claudePathMock.mockReset()
    claudePathMock.mockReturnValue('/usr/local/bin/claude')
})

afterEach(() => {
    vi.useRealTimers()
})

describe('parseClaudeModelsProbeLine', () => {
    it('keeps only the fields HAPI uses and folds effort support into levels', () => {
        const result = parseClaudeModelsProbeLine(successLine([
            OPUS_ROW,
            { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
            { value: 'legacy', supportsEffort: null },
        ]))

        expect(result).toEqual({
            kind: 'models',
            models: [
                { value: 'opus', displayName: 'Opus 5.5', effortLevels: ['low', 'high'] },
                { value: 'haiku', displayName: 'Haiku 4.5', effortLevels: [] },
                { value: 'legacy', effortLevels: [] },
            ],
        })
    })

    it('leaves effort support unknown when the CLI reports it for no model at all', () => {
        const result = parseClaudeModelsProbeLine(successLine([
            { value: 'opus', resolvedModel: 'claude-opus-5-5' },
        ]))

        expect(result).toEqual({ kind: 'models', models: [{ value: 'opus' }] })
    })

    it('leaves the levels unknown when the CLI supports effort but lists no levels', () => {
        const result = parseClaudeModelsProbeLine(successLine([
            { value: 'opus', supportsEffort: true },
        ]))

        expect(result).toEqual({ kind: 'models', models: [{ value: 'opus' }] })
    })

    it('trusts supportsEffort over a level list the row still carries', () => {
        const result = parseClaudeModelsProbeLine(successLine([
            { value: 'haiku', supportsEffort: false, supportedEffortLevels: ['low'] },
        ]))

        expect(result).toEqual({ kind: 'models', models: [{ value: 'haiku', effortLevels: [] }] })
    })

    it('drops rows without a usable value and non-string fields', () => {
        const result = parseClaudeModelsProbeLine(successLine([
            { value: '' },
            { displayName: 'No value' },
            'opus',
            { value: 'sonnet', displayName: 42, supportsEffort: true, supportedEffortLevels: ['low', 7] },
        ]))

        expect(result).toEqual({ kind: 'models', models: [{ value: 'sonnet', effortLevels: ['low'] }] })
    })

    it('reports an explicit control error with the CLI message', () => {
        const line = JSON.stringify({
            type: 'control_response',
            response: { subtype: 'error', request_id: PROBE_REQUEST_ID, error: 'Not logged in' },
        })

        expect(parseClaudeModelsProbeLine(line)).toEqual({ kind: 'error', error: 'Not logged in' })
    })

    it('ignores hook events, other requests and non-JSON output', () => {
        expect(parseClaudeModelsProbeLine(JSON.stringify({ type: 'system', subtype: 'hook_started' }))).toBeNull()
        expect(parseClaudeModelsProbeLine(successLine([OPUS_ROW], 'someone-else'))).toBeNull()
        expect(parseClaudeModelsProbeLine('Welcome to Claude Code')).toBeNull()
    })
})

describe('listClaudeModels', () => {
    it('spawns the session executable isolated from project settings, hooks and MCP servers', async () => {
        const pending = listClaudeModels()
        lastChild().respond([OPUS_ROW])
        await pending

        const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], { cwd: string }]
        expect(command).toBe('/usr/local/bin/claude')
        expect(args).toEqual(expect.arrayContaining(['--print', '--strict-mcp-config']))
        expect(args[args.indexOf('--setting-sources') + 1]).toBe('user')
        expect(JSON.parse(args[args.indexOf('--settings') + 1] ?? 'null')).toEqual({ disableAllHooks: true })
        expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json')
        expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
        expect(options.cwd).toBe(homedir())
    })

    it('asks for the catalog with an initialize control request and no prompt', async () => {
        const pending = listClaudeModels()
        const child = lastChild()
        child.respond([OPUS_ROW])
        await pending

        expect(child.stdin.write).toHaveBeenCalledTimes(1)
        expect(JSON.parse(String(child.stdin.write.mock.calls[0]?.[0]))).toEqual({
            type: 'control_request',
            request_id: PROBE_REQUEST_ID,
            request: { subtype: 'initialize' },
        })
    })

    it('returns the catalog and stops the probe process', async () => {
        const pending = listClaudeModels()
        lastChild().respond([OPUS_ROW])

        await expect(pending).resolves.toMatchObject({
            success: true,
            availableModels: [{ value: 'opus', displayName: 'Opus 5.5' }],
        })
        expect(killMock).toHaveBeenCalledTimes(1)
    })

    it('shares one probe between concurrent requests', async () => {
        const first = listClaudeModels()
        const second = listClaudeModels()
        lastChild().respond([OPUS_ROW])

        await expect(Promise.all([first, second])).resolves.toHaveLength(2)
        expect(spawnMock).toHaveBeenCalledTimes(1)
    })

    it('serves a cached catalog for five minutes, then probes again', async () => {
        vi.useFakeTimers()
        const first = listClaudeModels()
        lastChild().respond([OPUS_ROW])
        await first

        vi.advanceTimersByTime(5 * 60_000 - 1)
        await listClaudeModels()
        expect(spawnMock).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(1)
        const refreshed = listClaudeModels()
        lastChild().respond([OPUS_ROW])
        await refreshed
        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it('keeps a separate cache per claude executable', async () => {
        const first = listClaudeModels()
        lastChild().respond([OPUS_ROW])
        await first

        claudePathMock.mockReturnValue('/opt/other/claude')
        const second = listClaudeModels()
        lastChild().respond([OPUS_ROW])
        await second

        expect(spawnMock).toHaveBeenCalledTimes(2)
        expect(spawnMock.mock.calls[1]?.[0]).toBe('/opt/other/claude')
    })

    it('does not cache a failure, so the next request probes again', async () => {
        const failed = listClaudeModels()
        lastChild().emit('error', new Error('spawn claude ENOENT'))
        await expect(failed).rejects.toThrow('spawn claude ENOENT')

        const retried = listClaudeModels()
        lastChild().respond([OPUS_ROW])
        await expect(retried).resolves.toMatchObject({ success: true })
        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it('rejects an empty catalog instead of caching it', async () => {
        const pending = listClaudeModels()
        lastChild().respond([])
        await expect(pending).rejects.toThrow('no models')

        const retried = listClaudeModels()
        lastChild().respond([OPUS_ROW])
        await retried
        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it('surfaces the CLI error and exit output when it quits before answering', async () => {
        const pending = listClaudeModels()
        const child = lastChild()
        child.stderr.emit('data', 'Invalid API key')
        child.emit('close', 1)

        await expect(pending).rejects.toThrow('Invalid API key')
    })

    it('times out a probe that never answers and stops it', async () => {
        vi.useFakeTimers()
        const pending = listClaudeModels()
        const assertion = expect(pending).rejects.toThrow('timed out')

        await vi.advanceTimersByTimeAsync(15_000)
        await assertion
        expect(killMock).toHaveBeenCalled()
    })

    it('reports a missing claude executable without spawning', async () => {
        claudePathMock.mockImplementation(() => {
            throw new Error('Claude Code CLI not found on PATH')
        })

        await expect(listClaudeModels()).rejects.toThrow('Claude Code CLI not found on PATH')
        expect(spawnMock).not.toHaveBeenCalled()
    })

    it('does not let a stdin write failure escape as an unhandled error', async () => {
        const pending = listClaudeModels()
        const child = lastChild()

        expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow()
        child.emit('close', null)
        await expect(pending).rejects.toThrow()
    })
})
