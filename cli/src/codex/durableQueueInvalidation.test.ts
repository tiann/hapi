import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { invalidateCodexQueueDurably } from './durableQueueInvalidation'

describe('invalidateCodexQueueDurably', () => {
    it('keeps the local queue and marks delivery ambiguous when durable terminalization fails', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        queue.push('first', 'mode', { messageId: 'message-1', seq: 1 })
        queue.push('second', 'mode', { messageId: 'message-2', seq: 2 })
        const recordTerminal = vi.fn().mockResolvedValue(false)
        const onAmbiguous = vi.fn()

        await expect(invalidateCodexQueueDurably({
            queue,
            reason: 'codex-abort',
            state: 'canceled',
            attemptId: 'attempt-1',
            recordTerminal,
            onAmbiguous
        })).rejects.toThrow('durably canceled')
        expect(queue.size()).toBe(2)
        expect(onAmbiguous).toHaveBeenCalledOnce()
        expect(recordTerminal).toHaveBeenCalledWith([
            { messageId: 'message-1', sequence: 1 },
            { messageId: 'message-2', sequence: 2 }
        ], 'attempt-1', 'canceled')
    })

    it('clears the queue only after the whole durable terminal batch succeeds', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        queue.push('first', 'mode', { messageId: 'message-1', seq: 1 })

        await expect(invalidateCodexQueueDurably({
            queue,
            reason: 'codex-abort',
            state: 'canceled',
            attemptId: 'attempt-1',
            recordTerminal: async () => true
        })).resolves.toBeUndefined()
        expect(queue.size()).toBe(0)
    })

    it('durably terminalizes messages that arrive while the first batch is in flight before clearing them', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        queue.push('first', 'mode', { messageId: 'message-1', seq: 1 })
        const recordTerminal = vi.fn(async (items: Array<{ messageId: string; sequence: number }>) => {
            if (items.some((item) => item.messageId === 'message-1')) {
                queue.push('concurrent', 'mode', { messageId: 'message-2', seq: 2 })
            }
            return true
        })

        await expect(invalidateCodexQueueDurably({
            queue,
            reason: 'codex-abort',
            state: 'canceled',
            attemptId: 'attempt-1',
            recordTerminal
        })).resolves.toBeUndefined()

        expect(recordTerminal).toHaveBeenNthCalledWith(1, [
            { messageId: 'message-1', sequence: 1 }
        ], 'attempt-1', 'canceled')
        expect(recordTerminal).toHaveBeenNthCalledWith(2, [
            { messageId: 'message-2', sequence: 2 }
        ], 'attempt-1', 'canceled')
        expect(queue.size()).toBe(0)
    })

    it('retains every local message if terminalizing a concurrent arrival fails', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        queue.push('first', 'mode', { messageId: 'message-1', seq: 1 })
        const onAmbiguous = vi.fn()
        let call = 0

        await expect(invalidateCodexQueueDurably({
            queue,
            reason: 'codex-abort',
            state: 'canceled',
            attemptId: 'attempt-1',
            recordTerminal: async () => {
                call += 1
                if (call === 1) {
                    queue.push('concurrent', 'mode', { messageId: 'message-2', seq: 2 })
                    return true
                }
                return false
            },
            onAmbiguous
        })).rejects.toThrow('durably canceled')

        expect(queue.snapshotAll().map((item) => item.messageId)).toEqual(['message-1', 'message-2'])
        expect(onAmbiguous).toHaveBeenCalledOnce()
    })
})
