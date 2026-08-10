import { describe, expect, it } from 'vitest'
import type { ThreadAssistantMessagePart } from '@assistant-ui/react'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'

describe('getAssistantCopyText', () => {
    it('joins assistant text parts and ignores non-text parts', () => {
        const parts = [
            { type: 'text', text: 'First paragraph.' },
            { type: 'reasoning', text: 'Hidden chain of thought' },
            { type: 'tool-call', toolCallId: 'tool-1', toolName: 'search', args: {}, argsText: '{}' },
            { type: 'text', text: 'Second paragraph.' }
        ] satisfies ThreadAssistantMessagePart[]

        expect(getAssistantCopyText(parts)).toBe('First paragraph.\n\nSecond paragraph.')
    })

    it('returns empty string when no assistant text exists', () => {
        const parts = [
            { type: 'reasoning', text: 'Thinking' },
            { type: 'tool-call', toolCallId: 'tool-1', toolName: 'search', args: {}, argsText: '{}' }
        ] satisfies ThreadAssistantMessagePart[]

        expect(getAssistantCopyText(parts)).toBe('')
    })

    it('strips trailing AGENT_NOTIFY_SUMMARY when stripNotifySummary is on', () => {
        const parts = [
            {
                type: 'text',
                text: 'Did the work.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}'
            }
        ] satisfies ThreadAssistantMessagePart[]

        expect(getAssistantCopyText(parts, { stripNotifySummary: true })).toBe('Did the work.')
        expect(getAssistantCopyText(parts)).toContain('AGENT_NOTIFY_SUMMARY')
    })
})
