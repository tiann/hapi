import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRequestMock = vi.fn()
const closeMock = vi.fn().mockResolvedValue(undefined)
const transportConstructor = vi.fn()

vi.mock('@/agent/backends/acp/AcpStdioTransport', () => ({
    AcpStdioTransport: class {
        sendRequest = sendRequestMock
        close = closeMock
        constructor(opts: { command: string; args?: string[] }) {
            transportConstructor(opts)
        }
    }
}))

import { listOpencodeModelsForCwd, _resetOpencodeModelsCacheForTests } from './opencodeModels'

describe('listOpencodeModelsForCwd', () => {
    beforeEach(() => {
        _resetOpencodeModelsCacheForTests()
        sendRequestMock.mockReset()
        closeMock.mockClear()
        transportConstructor.mockClear()
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

        expect(transportConstructor).toHaveBeenCalledWith(
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

    it('returns empty availableModels when session/new omits the models block', async () => {
        sendRequestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: 'sess-2' })

        const result = await listOpencodeModelsForCwd('/tmp/proj')

        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual([])
        expect(result.currentModelId).toBeNull()
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

        expect(transportConstructor).toHaveBeenCalledTimes(1)
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

        expect(transportConstructor).toHaveBeenCalledTimes(1)
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
