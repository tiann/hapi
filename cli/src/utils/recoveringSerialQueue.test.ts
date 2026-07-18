import { describe, expect, it, vi } from 'vitest'
import { RecoveringSerialQueue } from './recoveringSerialQueue'

describe('RecoveringSerialQueue', () => {
    it('reports one failed task without poisoning later queued work', async () => {
        const onError = vi.fn()
        const serial = new RecoveringSerialQueue(onError)
        const calls: string[] = []

        const first = serial.enqueue(async () => {
            calls.push('first')
            throw new Error('durable invalidation failed')
        })
        const second = serial.enqueue(async () => {
            calls.push('second')
        })

        await expect(first).rejects.toThrow('durable invalidation failed')
        await expect(second).resolves.toBeUndefined()
        expect(calls).toEqual(['first', 'second'])
        expect(onError).toHaveBeenCalledOnce()
    })
})
