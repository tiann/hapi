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

        const plan = buildSessionVoiceContextPlan(session, messages, 'Codex')

        expect(plan.bootstrap).toContain('sess-1')
        expect(plan.bootstrap).toContain('Auth refactor')
        expect(utf8ByteLength(plan.bootstrap)).toBeLessThanOrEqual(ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES)
        expect(plan.streamChunks.length).toBeGreaterThan(0)
        expect(plan.messagesInBootstrap).toBeLessThanOrEqual(2)
        expect(plan.bootstrap).not.toContain('Claude Code')
    })

    test('prefers metadata.name over a stale summary for the voice session header', () => {
        const session = {
            id: 'sess-named',
            metadata: {
                path: '/proj',
                name: 'Renamed triage peer',
                summary: { text: 'issue-triage-#54' }
            }
        } as Session

        const plan = buildSessionVoiceContextPlan(session, [], 'Codex')

        expect(plan.bootstrap).toContain('Renamed triage peer')
        expect(plan.bootstrap).not.toContain('issue-triage-#54')
    })

    test('uses metadata.name alone when no summary exists', () => {
        const session = {
            id: 'sess-name-only',
            metadata: {
                path: '/proj',
                name: 'spawned-peer'
            }
        } as Session

        const plan = buildSessionVoiceContextPlan(session, [], 'Codex')

        expect(plan.bootstrap).toContain('spawned-peer')
    })

    test('handles missing session', () => {
        const plan = buildSessionVoiceContextPlan(null, [], 'Claude')
        expect(plan.bootstrap).toBe('Session not available')
        expect(plan.streamChunks).toEqual([])
    })
})
