import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

const { listClaudeModelsMock } = vi.hoisted(() => ({
    listClaudeModelsMock: vi.fn(),
}))

vi.mock('../claudeModels', () => ({
    listClaudeModels: listClaudeModelsMock,
}))

import { registerClaudeModelHandlers } from './claudeModels'

describe('listClaudeModels machine RPC handler', () => {
    let rpc: RpcHandlerManager

    beforeEach(() => {
        listClaudeModelsMock.mockReset()
        rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerClaudeModelHandlers(rpc)
    })

    async function listViaRpc(): Promise<unknown> {
        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.ListClaudeModels}`,
            params: '{}'
        })
        return JSON.parse(raw)
    }

    it('returns the discovered catalog', async () => {
        listClaudeModelsMock.mockResolvedValue({
            success: true,
            availableModels: [{ value: 'opus' }]
        })

        await expect(listViaRpc()).resolves.toEqual({
            success: true,
            availableModels: [{ value: 'opus' }]
        })
    })

    it('answers a failed probe with an error response instead of throwing', async () => {
        listClaudeModelsMock.mockRejectedValue(new Error('Claude model discovery timed out'))

        await expect(listViaRpc()).resolves.toEqual({
            success: false,
            error: 'Claude model discovery timed out'
        })
    })
})
