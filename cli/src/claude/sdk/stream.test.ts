import { describe, expect, it } from 'vitest'
import { Stream } from './stream'

describe('Stream', () => {
    it('keeps the first error sticky even if done is called later', async () => {
        const stream = new Stream<string>()
        const error = new Error('prompt failed')

        stream.error(error)
        stream.done()

        await expect(stream.next()).rejects.toThrow('prompt failed')
    })

    it('ignores enqueue after terminal error', async () => {
        const stream = new Stream<string>()
        const error = new Error('prompt failed')

        stream.error(error)
        stream.enqueue('late-message')

        await expect(stream.next()).rejects.toThrow('prompt failed')
    })

    it('rejects a pending consumer when error arrives asynchronously', async () => {
        const stream = new Stream<string>()
        const pending = stream.next()

        stream.error(new Error('prompt failed'))

        await expect(pending).rejects.toThrow('prompt failed')
    })
})
