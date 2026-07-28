import { describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import {
    registerSessionConfigRpc,
    resolveNullableSessionModel,
    resolveSessionConfigPermissionMode
} from './sessionConfigRpc'

function createRpcHarness() {
    const registerHandler = vi.fn()
    return {
        rpcHandlerManager: { registerHandler } as never,
        getHandler: () => {
            const call = registerHandler.mock.calls.find((args) => args[0] === RPC_METHODS.SetSessionConfig)
            expect(call).toBeDefined()
            return call![1] as (payload: unknown) => Promise<unknown>
        }
    }
}

describe('sessionConfigRpc', () => {
    it('rejects permission modes that are not allowed for the agent flavor', () => {
        expect(() => resolveSessionConfigPermissionMode('bypassPermissions', 'gemini')).toThrow('Invalid permission mode')
    })

    it('accepts OpenCode plan permission mode', () => {
        expect(resolveSessionConfigPermissionMode('plan', 'opencode')).toBe('plan')
    })

    it('accepts null model for agents that support model config', () => {
        expect(resolveNullableSessionModel(null)).toBeNull()
    })

    it('rejects empty and non-string models', () => {
        expect(() => resolveNullableSessionModel('')).toThrow('Invalid model')
        expect(() => resolveNullableSessionModel('   ')).toThrow('Invalid model')
        expect(() => resolveNullableSessionModel(123)).toThrow('Invalid model')
    })

    it('applies model null when model config is supported', async () => {
        const harness = createRpcHarness()
        const onApply = vi.fn()

        registerSessionConfigRpc({
            rpcHandlerManager: harness.rpcHandlerManager,
            flavor: 'opencode',
            modelMode: 'nullable',
            onApply
        })

        const result = await harness.getHandler()({ model: null }) as { applied: Record<string, unknown> }

        expect(result.applied.model).toBeNull()
        expect(onApply).toHaveBeenCalledWith({ model: null })
    })

    it('ignores model config for agents that do not support model changes when configured to ignore', async () => {
        const harness = createRpcHarness()
        const onApply = vi.fn()

        registerSessionConfigRpc({
            rpcHandlerManager: harness.rpcHandlerManager,
            flavor: 'cursor',
            modelMode: 'ignore',
            appliedFallback: () => ({ permissionMode: 'default' }),
            onApply
        })

        const result = await harness.getHandler()({ model: null }) as { applied: Record<string, unknown> }

        expect(result.applied).toEqual({ permissionMode: 'default' })
        expect(onApply).toHaveBeenCalledWith({})
    })



    it('applies nullable model reasoning effort when supported', async () => {
        const harness = createRpcHarness()
        const onApply = vi.fn()

        registerSessionConfigRpc({
            rpcHandlerManager: harness.rpcHandlerManager,
            flavor: 'opencode',
            modelReasoningEffortMode: 'nullable',
            onApply
        })

        const result = await harness.getHandler()({ modelReasoningEffort: 'high' }) as { applied: Record<string, unknown> }

        expect(result.applied.modelReasoningEffort).toBe('high')
        expect(onApply).toHaveBeenCalledWith({ modelReasoningEffort: 'high' })
    })

    it('applies nullable launch effort for Grok runtime switching', async () => {
        const harness = createRpcHarness()
        const onApply = vi.fn()

        registerSessionConfigRpc({
            rpcHandlerManager: harness.rpcHandlerManager,
            flavor: 'grok',
            effortMode: 'nullable',
            onApply
        })

        const result = await harness.getHandler()({ effort: 'low' }) as { applied: Record<string, unknown> }

        expect(result.applied.effort).toBe('low')
        expect(onApply).toHaveBeenCalledWith({ effort: 'low' })
    })

    it('rejects model config for agents configured to reject model changes', async () => {
        const harness = createRpcHarness()

        registerSessionConfigRpc({
            rpcHandlerManager: harness.rpcHandlerManager,
            flavor: 'cursor',
            onApply: vi.fn()
        })

        await expect(harness.getHandler()({ model: null })).rejects.toThrow('Invalid model')
    })
})
