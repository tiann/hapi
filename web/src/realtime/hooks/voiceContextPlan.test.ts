import { describe, expect, test } from 'vitest'
import { ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES, utf8ByteLength } from '@hapi/protocol/voice-personality'
import { buildSessionVoiceContextPlan } from './voiceContextPlan'
import type { DecryptedMessage, Session } from '@/types/api'

function makeSession(id: string): Session {
    return {
        id,
        metadata: {
            path: '/proj',
            summary: { text: 'Auth refactor' }
        }
    } as Session
}

function makeMessage(seq: number, text: string): DecryptedMessage {
    return {
        seq,
        content: { type: 'output', data: { type: 'assistant', message: { content: text } } }
    } as DecryptedMessage
}

describe('buildSessionVoiceContextPlan', () => {
    test('bootstrap stays small and defers older messages', () => {
        const session = makeSession('sess-1')
        const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i + 1, `line ${i + 1}`))

        const plan = buildSessionVoiceContextPlan(session, messages)

        expect(plan.bootstrap).toContain('sess-1')
        expect(plan.bootstrap).toContain('Auth refactor')
        expect(utf8ByteLength(plan.bootstrap)).toBeLessThanOrEqual(ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES)
        expect(plan.streamChunks.length).toBeGreaterThan(0)
        expect(plan.messagesInBootstrap).toBeLessThanOrEqual(2)
    })

    test('handles missing session', () => {
        const plan = buildSessionVoiceContextPlan(null, [])
        expect(plan.bootstrap).toBe('Session not available')
        expect(plan.streamChunks).toEqual([])
    })
})
