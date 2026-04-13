import { describe, expect, it } from 'bun:test'
import { normalizeAssistantTranscriptEvent } from './transcriptEvents'

describe('normalizeAssistantTranscriptEvent', () => {
    it('normalizes real assistant transcript text blocks into HAPI replace messages', () => {
        const event = normalizeAssistantTranscriptEvent({
            sessionKey: 'agent:main:hapi-openclaw:default:debug-user',
            messageId: '8acfd988',
            message: {
                role: 'assistant',
                content: [{
                    type: 'text',
                    text: '[[reply_to_current]] Hello, real openclaw.'
                }],
                timestamp: 1775961785178,
                responseId: 'resp_123'
            }
        })

        expect(event).toMatchObject({
            type: 'message',
            occurredAt: 1775961785178,
            namespace: 'default',
            conversationId: 'agent:main:hapi-openclaw:default:debug-user',
            externalMessageId: '8acfd988',
            role: 'assistant',
            content: {
                mode: 'replace',
                text: 'Hello, real openclaw.'
            },
            createdAt: 1775961785178,
            status: 'completed'
        })
        expect(event?.eventId).toMatch(/^message:8acfd988:[0-9a-f]{12}$/)
    })

    it('generates distinct event ids for successive updates to the same assistant message', () => {
        const first = normalizeAssistantTranscriptEvent({
            sessionKey: 'agent:main:hapi-openclaw:default:debug-user',
            messageId: 'assistant-1',
            message: {
                role: 'assistant',
                content: 'partial',
                timestamp: 100
            }
        })
        const second = normalizeAssistantTranscriptEvent({
            sessionKey: 'agent:main:hapi-openclaw:default:debug-user',
            messageId: 'assistant-1',
            message: {
                role: 'assistant',
                content: 'partial and more',
                timestamp: 100
            }
        })

        expect(first?.externalMessageId).toBe(second?.externalMessageId)
        expect(first?.eventId).not.toBe(second?.eventId)
    })

    it('ignores tool-only assistant transcript entries', () => {
        expect(normalizeAssistantTranscriptEvent({
            sessionKey: 'agent:main:hapi-openclaw:default:debug-user',
            messageId: 'ccd5d142',
            message: {
                role: 'assistant',
                content: [{
                    type: 'toolCall',
                    id: 'call_1',
                    name: 'exec',
                    arguments: { command: 'ps' }
                }],
                timestamp: 1775961838792
            }
        })).toBeNull()
    })

    it('preserves encoded namespaces when normalizing transcript events', () => {
        const event = normalizeAssistantTranscriptEvent({
            sessionKey: 'agent:main:hapi-openclaw:team%3Ablue:debug-user',
            messageId: 'assistant-2',
            message: {
                role: 'assistant',
                content: 'hello',
                timestamp: 2
            }
        })

        expect(event?.namespace).toBe('team:blue')
    })

    it('ignores non-assistant and non-HAPI transcript entries', () => {
        expect(normalizeAssistantTranscriptEvent({
            sessionKey: 'agent:main:hapi-openclaw:default:debug-user',
            messageId: 'user-1',
            message: {
                role: 'user',
                content: 'hello',
                timestamp: 1
            }
        })).toBeNull()

        expect(normalizeAssistantTranscriptEvent({
            sessionKey: 'agent:main:other-plugin:default:debug-user',
            messageId: 'assistant-1',
            message: {
                role: 'assistant',
                content: 'hello',
                timestamp: 1
            }
        })).toBeNull()
    })
})
