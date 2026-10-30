import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sendRequestMock = vi.fn()
const closeMock = vi.fn().mockResolvedValue(undefined)
const transportCreate = vi.fn()

vi.mock('@/agent/backends/acp/AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        sendRequest = sendRequestMock
        close = closeMock
        static async create(opts: { command: string; args?: string[] }) {
            transportCreate(opts)
            return new MockAcpStdioTransport()
        }
    }
    return { AcpStdioTransport: MockAcpStdioTransport }
})

import {
    applyOpencodeModelFilter,
    listOpencodeModelsForCwd,
    loadOpencodeModelFilter,
    parseOpencodeModelFilter,
    OPENCODE_MODEL_FILTER_FILE_ENV,
    _resetOpencodeModelsCacheForTests
} from './opencodeModels'

describe('listOpencodeModelsForCwd', () => {
    beforeEach(() => {
        _resetOpencodeModelsCacheForTests()
        sendRequestMock.mockReset()
        closeMock.mockClear()
        transportCreate.mockClear()
    })

    afterEach(() => {
        _resetOpencodeModelsCacheForTests()
    })

    it('returns success false when cwd is empty', async () => {
        const result = await listOpencodeModelsForCwd('')
        expect(result).toEqual({ success: false, error: 'cwd is required' })
        expect(sendRequestMock).not.toHaveBeenCalled()
    })

    it('spawns opencode acp, runs initialize and session/new, returns availableModels', async () => {
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({
                sessionId: 'sess-1',
                models: {
                    availableModels: [
                        { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama/EXAONE 4.5 33B Q8' },
                        { modelId: 'mlx/qwen3:32b', name: 'MLX/Qwen 3.6 32B Q8' }
                    ],
                    currentModelId: 'ollama/exaone:4.5-33b-q8'
                }
            })

        const result = await listOpencodeModelsForCwd('/home/user/project')

        expect(transportCreate).toHaveBeenCalledWith(
            expect.objectContaining({ command: 'opencode', args: ['acp'] })
        )
        expect(sendRequestMock).toHaveBeenNthCalledWith(
            1,
            'initialize',
            expect.objectContaining({ protocolVersion: 1 }),
            expect.any(Object)
        )
        expect(sendRequestMock).toHaveBeenNthCalledWith(
            2,
            'session/new',
            expect.objectContaining({ cwd: '/home/user/project', mcpServers: [] }),
            expect.any(Object)
        )
        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual([
            { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama/EXAONE 4.5 33B Q8' },
            { modelId: 'mlx/qwen3:32b', name: 'MLX/Qwen 3.6 32B Q8' }
        ])
        expect(result.currentModelId).toBe('ollama/exaone:4.5-33b-q8')
        expect(closeMock).toHaveBeenCalled()
    })

    it('reads availableModels from configOptions when session/new omits the models block', async () => {
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({
                sessionId: 'sess-2',
                configOptions: [
                    {
                        id: 'model',
                        category: 'model',
                        currentValue: 'opencode/big-pickle',
                        options: [
                            { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
                            { value: 'deepseek/deepseek-chat', name: 'DeepSeek/DeepSeek Chat' }
                        ]
                    }
                ]
            })

        const result = await listOpencodeModelsForCwd('/tmp/proj')

        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual([
            { modelId: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
            { modelId: 'deepseek/deepseek-chat', name: 'DeepSeek/DeepSeek Chat' }
        ])
        expect(result.currentModelId).toBe('opencode/big-pickle')
    })

    it('reads availableModels from top-level fields too (alternate response shape)', async () => {
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({
                sessionId: 'sess-3',
                availableModels: [
                    { modelId: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' }
                ],
                currentModelId: 'opencode/big-pickle'
            })

        const result = await listOpencodeModelsForCwd('/p/another')

        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual([
            { modelId: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' }
        ])
    })

    it('caches the result for the same cwd within the TTL', async () => {
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({
                models: { availableModels: [{ modelId: 'a/b', name: 'A/B' }], currentModelId: 'a/b' }
            })

        await listOpencodeModelsForCwd('/cache/cwd')
        await listOpencodeModelsForCwd('/cache/cwd')

        expect(transportCreate).toHaveBeenCalledTimes(1)
        expect(sendRequestMock).toHaveBeenCalledTimes(2)
    })

    it('coalesces concurrent probes for the same cwd into a single transport spawn', async () => {
        let resolveSecond: (value: unknown) => void = () => undefined
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res }))

        const inflight1 = listOpencodeModelsForCwd('/inflight/cwd')
        const inflight2 = listOpencodeModelsForCwd('/inflight/cwd')

        // Allow microtasks to schedule the second sendRequest
        await new Promise((resolve) => setImmediate(resolve))
        resolveSecond({
            models: { availableModels: [{ modelId: 'a/b' }], currentModelId: 'a/b' }
        })

        const [r1, r2] = await Promise.all([inflight1, inflight2])

        expect(transportCreate).toHaveBeenCalledTimes(1)
        expect(r1).toEqual(r2)
        expect(r1.success).toBe(true)
    })

    it('reports a failure when the spawn rejects', async () => {
        sendRequestMock.mockRejectedValueOnce(new Error('Failed to spawn opencode: ENOENT'))

        const result = await listOpencodeModelsForCwd('/missing/binary')

        expect(result.success).toBe(false)
        expect(result.error).toContain('Failed to spawn opencode')
        expect(closeMock).toHaveBeenCalled()
    })
})

describe('parseOpencodeModelFilter', () => {
    it('degrades malformed documents to off', () => {
        expect(parseOpencodeModelFilter(null).mode).toBe('off')
        expect(parseOpencodeModelFilter('nope').mode).toBe('off')
        expect(parseOpencodeModelFilter({ mode: 'bogus', models: ['a/b'] }).mode).toBe('off')
        expect(parseOpencodeModelFilter({ mode: 'allowlist', models: 'a/b' }).models.size).toBe(0)
    })

    it('keeps valid modes and trims/dedupes model ids', () => {
        const filter = parseOpencodeModelFilter({
            mode: 'blocklist',
            models: ['openrouter/x', ' openrouter/x ', '', 'cpa/gpt-5.4', null]
        })
        expect(filter.mode).toBe('blocklist')
        expect([...filter.models]).toEqual(['openrouter/x', 'cpa/gpt-5.4'])
    })
})

describe('applyOpencodeModelFilter', () => {
    const models = [
        { modelId: 'cpa/gpt-5.4' },
        { modelId: 'openrouter/anthropic/claude', name: 'Anthropic/Claude' },
        { modelId: 'ark/ark-code-latest' }
    ]

    it('returns the list unchanged when off or when the model set is empty', () => {
        expect(applyOpencodeModelFilter(models, { mode: 'off', models: new Set(['cpa/gpt-5.4']) })).toEqual(models)
        expect(applyOpencodeModelFilter(models, { mode: 'allowlist', models: new Set() })).toEqual(models)
        expect(applyOpencodeModelFilter(models, { mode: 'blocklist', models: new Set() })).toEqual(models)
    })

    it('allowlist keeps only listed models and blocklist drops them', () => {
        expect(applyOpencodeModelFilter(models, {
            mode: 'allowlist',
            models: new Set(['cpa/gpt-5.4', 'ark/ark-code-latest'])
        })).toEqual([{ modelId: 'cpa/gpt-5.4' }, { modelId: 'ark/ark-code-latest' }])

        expect(applyOpencodeModelFilter(models, {
            mode: 'blocklist',
            models: new Set(['openrouter/anthropic/claude'])
        })).toEqual([{ modelId: 'cpa/gpt-5.4' }, { modelId: 'ark/ark-code-latest' }])
    })

    it('preserves name metadata of surviving entries', () => {
        expect(applyOpencodeModelFilter(models, {
            mode: 'allowlist',
            models: new Set(['openrouter/anthropic/claude'])
        })).toEqual([{ modelId: 'openrouter/anthropic/claude', name: 'Anthropic/Claude' }])
    })
})

describe('loadOpencodeModelFilter', () => {
    let tmpDir: string
    const previousEnv = process.env[OPENCODE_MODEL_FILTER_FILE_ENV]

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'hapi-opencode-filter-'))
        process.env[OPENCODE_MODEL_FILTER_FILE_ENV] = join(tmpDir, 'missing.json')
    })

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true })
        if (previousEnv === undefined) {
            delete process.env[OPENCODE_MODEL_FILTER_FILE_ENV]
        } else {
            process.env[OPENCODE_MODEL_FILTER_FILE_ENV] = previousEnv
        }
    })

    it('returns off when the file does not exist', () => {
        expect(loadOpencodeModelFilter()).toEqual({ mode: 'off', models: new Set() })
    })

    it('returns off when the file is not valid JSON', () => {
        const file = join(tmpDir, 'broken.json')
        writeFileSync(file, '{not json')
        expect(loadOpencodeModelFilter(file).mode).toBe('off')
    })

    it('reads mode and models from the file', () => {
        const file = join(tmpDir, 'filter.json')
        writeFileSync(file, JSON.stringify({ mode: 'allowlist', models: ['cpa/gpt-5.4'] }))
        const filter = loadOpencodeModelFilter(file)
        expect(filter.mode).toBe('allowlist')
        expect([...filter.models]).toEqual(['cpa/gpt-5.4'])
    })
})

describe('listOpencodeModelsForCwd with filter file', () => {
    let tmpDir: string
    const previousEnv = process.env[OPENCODE_MODEL_FILTER_FILE_ENV]

    beforeEach(() => {
        _resetOpencodeModelsCacheForTests()
        sendRequestMock.mockReset()
        tmpDir = mkdtempSync(join(tmpdir(), 'hapi-opencode-filter-'))
    })

    afterEach(() => {
        _resetOpencodeModelsCacheForTests()
        rmSync(tmpDir, { recursive: true, force: true })
        if (previousEnv === undefined) {
            delete process.env[OPENCODE_MODEL_FILTER_FILE_ENV]
        } else {
            process.env[OPENCODE_MODEL_FILTER_FILE_ENV] = previousEnv
        }
    })

    it('applies the allowlist from the filter file to discovered models', async () => {
        process.env[OPENCODE_MODEL_FILTER_FILE_ENV] = join(tmpDir, 'filter.json')
        writeFileSync(join(tmpDir, 'filter.json'), JSON.stringify({
            mode: 'allowlist',
            models: ['cpa/gpt-5.4']
        }))
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({
                models: {
                    availableModels: [
                        { modelId: 'cpa/gpt-5.4' },
                        { modelId: 'openrouter/anthropic/claude' },
                        { modelId: 'ark/ark-code-latest' }
                    ],
                    currentModelId: 'openrouter/anthropic/claude'
                }
            })

        const result = await listOpencodeModelsForCwd('/filtered/cwd')

        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual([{ modelId: 'cpa/gpt-5.4' }])
        expect(result.currentModelId).toBe('openrouter/anthropic/claude')
    })

    it('leaves discovery unfiltered when no filter file exists', async () => {
        process.env[OPENCODE_MODEL_FILTER_FILE_ENV] = join(tmpDir, 'missing.json')
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({
                models: {
                    availableModels: [{ modelId: 'cpa/gpt-5.4' }],
                    currentModelId: 'cpa/gpt-5.4'
                }
            })

        const result = await listOpencodeModelsForCwd('/unfiltered/cwd')

        expect(result.availableModels).toEqual([{ modelId: 'cpa/gpt-5.4' }])
    })
})
