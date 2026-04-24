import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '../sync/syncEngine'
import { extractMessageEventType, extractTaskNotification } from './eventParsing'

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

describe('extractTaskNotification', () => {
    it('extracts task notification from system output payload', () => {
        const event: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-task-system',
                seq: 4,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'task_notification',
                            status: 'completed',
                            summary: 'Background command stopped'
                        }
                    }
                }
            }
        }

        expect(extractTaskNotification(event)).toEqual({
            status: 'completed',
            summary: 'Background command stopped'
        })
    })

    it('extracts task notification from sidechain user output payload', () => {
        const event: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-task-user',
                seq: 5,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            message: {
                                content: '<task-notification> <summary>Done</summary> <status>completed</status> </task-notification>'
                            }
                        }
                    }
                }
            }
        }

        expect(extractTaskNotification(event)).toEqual({
            status: 'completed',
            summary: 'Done'
        })
    })

    it('extracts task notification from direct user output content payload', () => {
        const event: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-task-user-direct',
                seq: 6,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            content: '<task-notification> <summary>Direct done</summary> <status>completed</status> </task-notification>'
                        }
                    }
                }
            }
        }

        expect(extractTaskNotification(event)).toEqual({
            status: 'completed',
            summary: 'Direct done'
        })
    })

    it('returns null when task notification summary is missing', () => {
        const event: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-task-user-empty',
                seq: 6,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            message: {
                                content: '<task-notification> <status>killed</status> </task-notification>'
                            }
                        }
                    }
                }
            }
        }

        expect(extractTaskNotification(event)).toBeNull()
    })
})
