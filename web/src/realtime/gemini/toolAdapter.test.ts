import { describe, test, expect } from 'bun:test'
import { handleGeminiFunctionCall, handleGeminiFunctionCalls } from './toolAdapter'
import type { GeminiFunctionCall } from './toolAdapter'

describe('toolAdapter', () => {
    test('returns error for unknown tool', async () => {
        const call: GeminiFunctionCall = {
            name: 'unknownTool',
            args: {},
            id: 'call-1'
        }
        const resp = await handleGeminiFunctionCall(call)
        expect(resp.name).toBe('unknownTool')
        expect(resp.id).toBe('call-1')
        expect(resp.response.result).toContain('unknown tool')
    })

    test('handles multiple calls in parallel', async () => {
        const calls: GeminiFunctionCall[] = [
            { name: 'unknownA', args: {}, id: 'a' },
            { name: 'unknownB', args: {}, id: 'b' }
        ]
        const responses = await handleGeminiFunctionCalls(calls)
        expect(responses.length).toBe(2)
        expect(responses[0].id).toBe('a')
        expect(responses[1].id).toBe('b')
    })
})
