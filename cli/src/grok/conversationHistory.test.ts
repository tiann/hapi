import { describe, expect, it, vi } from 'vitest'
import { GrokConversationHistory } from './conversationHistory'

describe('GrokConversationHistory', () => {
    it('probes fork independently from rewind support', async () => {
        const send = vi.fn(async (method: string) => {
            if (method === '_x.ai/session/fork') throw new Error('Method not found: -32601')
            return { points: [] }
        })
        const history = new GrokConversationHistory(() => ({ sendExtensionRequest: send }) as never)
        history.setSession('sess-1', '/tmp/proj')
        await history.probeCapabilities()
        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toEqual({
            rewindToMessage: true
        })
    })

    it('current fork omits targetPromptIndex', async () => {
        const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
            expect(method).toBe('_x.ai/session/fork')
            expect(params.targetPromptIndex).toBeUndefined()
            return { newSessionId: 'grok-fork-1' }
        })
        const history = new GrokConversationHistory(() => ({ sendExtensionRequest: send }) as never)
        history.setSession('sess-1', '/tmp/proj')
        const result = await history.fork()
        expect(result).toEqual({ nativeSessionId: 'grok-fork-1' })
    })

    it('historical fork passes targetPromptIndex from persisted mapping', async () => {
        const send = vi.fn(async (_method: string, params: Record<string, unknown>) => {
            expect(params.targetPromptIndex).toBe(2)
            return { newSessionId: 'grok-fork-2' }
        })
        const history = new GrokConversationHistory(() => ({ sendExtensionRequest: send }) as never)
        history.setSession('sess-1', '/tmp/proj')
        history.rememberPromptIndex('local-x', 2)
        await history.fork('local-x')
        expect(send).toHaveBeenCalled()
    })

    it('restores prompt indexes from durable metadata', async () => {
        const send = vi.fn(async (_method: string, params: Record<string, unknown>) => {
            expect(params.targetPromptIndex).toBe(4)
            return { newSessionId: 'grok-fork-restored' }
        })
        const history = new GrokConversationHistory(() => ({ sendExtensionRequest: send }) as never)
        history.setSession('sess-1', '/tmp/proj')
        history.restorePromptIndexes({ 'local-restored': 4 })
        await history.fork('local-restored')
        expect(history.getHistoryIndexes()).toEqual({ 'local-restored': 4 })
        expect(history.getHistoryPoints()).toEqual({ 'local-restored': true })
    })

    it('rewind always uses conversation_only and never all/files_only', async () => {
        const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
            expect(method).toBe('_x.ai/rewind/execute')
            expect(params.mode).toBe('conversation_only')
            expect(params.force).toBe(false)
            return { success: true }
        })
        const history = new GrokConversationHistory(() => ({ sendExtensionRequest: send }) as never)
        history.setSession('sess-1', '/tmp/proj')
        history.rememberPromptIndex('local-y', 1)
        const result = await history.rewind('local-y')
        expect(result.success).toBe(true)
        expect(result.success).toBe(true)
        if (!result.success) throw new Error(result.error)
        expect(result.truncateFromLocalId).toBe('local-y')
    })

    it('marks capability unsupported on method-not-found', async () => {
        const send = vi.fn(async () => {
            throw new Error('Method not found: -32601')
        })
        const history = new GrokConversationHistory(() => ({ sendExtensionRequest: send }) as never)
        history.setSession('sess-1', '/tmp/proj')
        history.rememberPromptIndex('local-z', 0)
        await expect(history.rewind('local-z')).rejects.toThrow(/Method not found/)
        expect(history.getCapabilitiesForMetadata()?.conversationHistory?.rewindToMessage).toBeUndefined()
    })
})
