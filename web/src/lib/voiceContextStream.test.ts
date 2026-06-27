import { describe, expect, test, vi } from 'vitest'
import { deliverVoiceSessionContextAfterConnect } from './voiceContextStream'

describe('deliverVoiceSessionContextAfterConnect', () => {
    test('streams older chunks then bootstrap context', async () => {
        const sent: string[] = []
        const sendChunk = vi.fn((chunk: string) => {
            sent.push(chunk)
        })

        await deliverVoiceSessionContextAfterConnect({
            streamContextChunks: ['older-a', 'older-b'],
            initialContext: 'bootstrap recent',
            sendChunk
        })

        expect(sent).toEqual(['older-a', 'older-b', 'bootstrap recent'])
    })

    test('sends bootstrap even when there are no stream chunks', async () => {
        const sent: string[] = []

        await deliverVoiceSessionContextAfterConnect({
            initialContext: '  session header only  ',
            sendChunk: (chunk) => sent.push(chunk)
        })

        expect(sent).toEqual(['session header only'])
    })

    test('skips empty bootstrap', async () => {
        const sent: string[] = []

        await deliverVoiceSessionContextAfterConnect({
            streamContextChunks: ['chunk'],
            initialContext: '   ',
            sendChunk: (chunk) => sent.push(chunk)
        })

        expect(sent).toEqual(['chunk'])
    })
})
