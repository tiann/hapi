import { describe, expect, it } from 'vitest'
import { convertDshEvent, convertDshHistoryEntry } from './dshEvents'
import type { DshSessionEvent } from './dshWebClient'

function event(type: string, data: unknown, seq = 1): DshSessionEvent {
    return { type, data, seq, time: 1_786_000_000_000 + seq }
}

describe('DeepSeek Harness event conversion', () => {
    it('imports only human-authored user messages', () => {
        const human = convertDshEvent(event('user/message', {
            source: { kind: 'user', rpcId: 'rpc-1' },
            content: [{ type: 'text', text: 'hello' }]
        }))
        const internal = convertDshEvent(event('user/message', {
            source: { kind: 'reminder' },
            content: [{ type: 'text', text: 'internal context' }]
        }))

        expect(human.humanText).toBe('hello')
        expect(internal).toEqual({ messages: [] })
    })

    it('preserves reasoning, text, model, and cache token accounting', () => {
        const converted = convertDshEvent(event('assistant/message', {
            message: {
                id: 'assistant-1',
                source: { kind: 'model', model: 'deepseek-v4-pro' },
                content: [
                    { type: 'reasoning', text: 'think' },
                    { type: 'text', text: 'answer' }
                ]
            },
            usage: {
                inputTokens: 100,
                outputTokens: 20,
                cacheReadTokens: 900,
                cacheWriteTokens: 5,
                reasoningTokens: 12
            }
        }))

        expect(converted.model).toBe('deepseek-v4-pro')
        expect(converted.messages).toEqual([
            { type: 'reasoning', text: 'think', id: 'assistant-1:reasoning' },
            { type: 'text', text: 'answer', id: 'assistant-1:text' },
            {
                type: 'usage',
                inputTokens: 100,
                outputTokens: 20,
                thoughtTokens: 12,
                cacheReadTokens: 900,
                cacheCreationTokens: 5
            }
        ])
    })

    it('builds stable local ids from native event sequence numbers', () => {
        const entry = {
            event: event('user/message', {
                source: { kind: 'user' },
                content: [{ type: 'text', text: 'hello' }]
            }, 42)
        }
        expect(convertDshHistoryEntry('session-1', entry)[0]).toMatchObject({
            localId: 'dsh:session-1:42:user',
            eventSeq: 42,
            content: { role: 'user' }
        })
    })
})
