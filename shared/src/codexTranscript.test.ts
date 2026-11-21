import { describe, expect, it } from 'bun:test'
import {
    deduplicateCodexTranscriptMessages,
    shouldIgnoreInjectedResponseUserMessage,
    type CodexImportedMessageEntry,
    type CodexImportedMessageSource
} from './codexTranscript'

function userEntry(source: CodexImportedMessageSource, text: string): CodexImportedMessageEntry {
    return {
        source,
        message: {
            role: 'user',
            content: { type: 'text', text },
            meta: { sentFrom: 'cli' }
        }
    }
}

function agentEntry(source: CodexImportedMessageSource, text: string, id: string): CodexImportedMessageEntry {
    return {
        source,
        message: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: text, id }
            },
            meta: { sentFrom: 'cli' }
        }
    }
}

function toolCallEntry(source: CodexImportedMessageSource, callId: string): CodexImportedMessageEntry {
    return {
        source,
        message: {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'tool-call', name: 'read_file', callId, id: `tool-${callId}` }
            },
            meta: { sentFrom: 'cli' }
        }
    }
}

function userTexts(entries: CodexImportedMessageEntry[]): string[] {
    return deduplicateCodexTranscriptMessages(entries).map((message) => {
        if (message.role !== 'user') throw new Error('Expected a user message')
        return message.content.text
    })
}

describe('shouldIgnoreInjectedResponseUserMessage', () => {
    it('ignores injected AGENTS.md instruction blocks', () => {
        expect(shouldIgnoreInjectedResponseUserMessage('# AGENTS.md instructions for /repo\n<INSTRUCTIONS>ignore</INSTRUCTIONS>')).toBe(true)
        expect(shouldIgnoreInjectedResponseUserMessage('# agents.md instructions for /repo')).toBe(true)
    })

    it('ignores a closed environment context block', () => {
        expect(shouldIgnoreInjectedResponseUserMessage('<environment_context>\n<current_date>2026-07-07</current_date>\n</environment_context>')).toBe(true)
        expect(shouldIgnoreInjectedResponseUserMessage('<ENVIRONMENT_CONTEXT>\n</ENVIRONMENT_CONTEXT>')).toBe(true)
    })

    it('keeps real prompts that only mention the injected markers', () => {
        expect(shouldIgnoreInjectedResponseUserMessage('normal user message')).toBe(false)
        expect(shouldIgnoreInjectedResponseUserMessage('Please inspect this transcript block:\n<environment_context>\n</environment_context>\nThis is part of my prompt.')).toBe(false)
        expect(shouldIgnoreInjectedResponseUserMessage('<environment_context>\n<current_date>2026-07-07</current_date>')).toBe(false)
    })
})

describe('deduplicateCodexTranscriptMessages', () => {
    it('collapses a mirrored user pair regardless of the source order', () => {
        expect(userTexts([
            userEntry('event_msg', 'mirrored user message'),
            userEntry('response_item', 'mirrored user message\n')
        ])).toEqual(['mirrored user message'])

        expect(userTexts([
            userEntry('response_item', 'mirrored user message\n'),
            userEntry('event_msg', 'mirrored user message')
        ])).toEqual(['mirrored user message'])
    })

    it('collapses a mirrored agent pair even when the ids differ', () => {
        const messages = deduplicateCodexTranscriptMessages([
            agentEntry('event_msg', 'duplicated assistant message', 'event-id'),
            agentEntry('response_item', 'duplicated assistant message', 'response-id')
        ])
        expect(messages).toHaveLength(1)
        expect(messages[0]).toEqual({
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'duplicated assistant message', id: 'event-id' }
            },
            meta: { sentFrom: 'cli' }
        })
    })

    it('keeps adjacent duplicates that come from the same source', () => {
        expect(userTexts([
            userEntry('response_item', 'same source user message'),
            userEntry('response_item', 'same source user message')
        ])).toEqual(['same source user message', 'same source user message'])

        const messages = deduplicateCodexTranscriptMessages([
            agentEntry('response_item', 'same source assistant message', 'first-id'),
            agentEntry('response_item', 'same source assistant message', 'second-id')
        ])
        expect(messages).toHaveLength(2)
    })

    it('keeps a later response_item user turn that repeats earlier text', () => {
        const messages = deduplicateCodexTranscriptMessages([
            userEntry('event_msg', 'repeat user message'),
            userEntry('response_item', 'repeat user message'),
            agentEntry('response_item', 'assistant answer', 'assistant-id'),
            userEntry('response_item', 'repeat user message')
        ])
        expect(messages.map((message) => message.role)).toEqual(['user', 'agent', 'user'])
    })

    it('keeps distinct user turns while collapsing mirrored user events', () => {
        expect(userTexts([
            userEntry('event_msg', 'first user message'),
            userEntry('response_item', 'first user message'),
            userEntry('event_msg', 'second user message')
        ])).toEqual(['first user message', 'second user message'])
    })

    it('drops every response_item copy of the most recent event user message', () => {
        expect(userTexts([
            userEntry('event_msg', 'repeat user message'),
            userEntry('response_item', 'repeat user message'),
            userEntry('response_item', 'repeat user message')
        ])).toEqual(['repeat user message'])
    })

    it('keeps adjacent tool call messages because they are not assistant prose', () => {
        const messages = deduplicateCodexTranscriptMessages([
            toolCallEntry('response_item', 'call-1'),
            toolCallEntry('response_item', 'call-1')
        ])
        expect(messages).toHaveLength(2)
    })
})
