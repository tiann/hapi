import { describe, expect, it, vi } from 'vitest'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerRipgrepHandlers } from './ripgrep'

const { runFileSearchMock } = vi.hoisted(() => ({ runFileSearchMock: vi.fn() }))

vi.mock('@/modules/ripgrep/index', () => ({
    run: vi.fn(),
    runFileSearch: runFileSearchMock
}))

describe('ripgrep RPC handlers', () => {
    it('passes AbortError through without logging it as a ripgrep failure', async () => {
        const logs: unknown[] = []
        const manager = new RpcHandlerManager({
            scopePrefix: 'session-test',
            logger: (...args) => logs.push(args)
        })
        registerRipgrepHandlers(manager, '/workspace')

        const abortError = new Error('Request aborted')
        abortError.name = 'AbortError'
        runFileSearchMock.mockRejectedValueOnce(abortError)

        const response = await manager.handleRequest({
            method: 'session-test:ripgrep',
            params: JSON.stringify({
                args: ['--files'],
                cwd: '/workspace',
                fileSearch: { query: 'src', limit: 1 }
            }),
            requestId: 'ripgrep-cancel'
        })

        expect(response).toBe(JSON.stringify({ error: 'Request aborted' }))
        expect(logs).toEqual([])
    })
})
