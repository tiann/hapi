import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '../sync/syncEngine'
import { extractMessageEventType } from './eventParsing'

describe('extractMessageEventType', () => {
    it('returns the event type from a role-wrapped envelope', () => {
        const event: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-1',
                seq: 1,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        id: 'event-1',
                        type: 'event',
                        data: { type: 'ready' }
                    },
                }
            }
        }

        expect(extractMessageEventType(event)).toBe('ready')
    })

    it('returns the event type from a direct envelope', () => {
        const event: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-2',
                seq: 2,
                localId: null,
                createdAt: 0,
                content: {
                    type: 'event',
                    data: { type: 'ready' }
                }
            }
        }

        expect(extractMessageEventType(event)).toBe('ready')
    })

    it('returns null when the envelope is missing', () => {
        const event: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-3',
                seq: 3,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'text',
                        text: 'hello'
                    }
                }
            }
        }

        expect(extractMessageEventType(event)).toBeNull()
    })

    it('returns null for non-message events', () => {
        const event: SyncEvent = {
            type: 'session-updated',
            sessionId: 'session-1'
        }

        expect(extractMessageEventType(event)).toBeNull()
    })
})
