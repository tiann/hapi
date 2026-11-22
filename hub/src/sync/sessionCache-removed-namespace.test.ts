import { describe, expect, it } from 'bun:test'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'
import type { SyncEvent } from '@hapi/protocol'
import type { Store } from '../store'

describe('refreshSession session-removed namespace', () => {
    it('carries the namespace so shouldSend does not drop the event', () => {
        const emitted: Array<SyncEvent & { namespace?: string }> = []
        const publisher: EventPublisher = {
            emit: (event: SyncEvent & { namespace?: string }) => {
                emitted.push(event)
            },
            subscribe: () => () => {},
            resolveNamespace: () => null
        } as unknown as EventPublisher

        // Minimal fake store: getOrCreateSession returns a stored session;
        // getSession returns null on the second call to trigger removal.
        let callCount = 0
        const store = {
            sessions: {
                getOrCreateSession: () => ({
                    id: 's1',
                    tag: 't1',
                    metadata: null,
                    agentState: null,
                    namespace: 'default',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    active: false,
                    activeAt: Date.now(),
                    thinking: false,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    todosUpdatedAt: 0,
                    contentRevision: 0,
                    pendingRequestsCount: 0,
                    pendingRequestKinds: [],
                    backgroundTaskCount: 0,
                    futureScheduledMessageCount: 0,
                    nextScheduledAt: null,
                    attachedJob: null,
                    attachedJobUpdatedAt: 0,
                    model: null,
                    effort: null
                }),
                getSession: () => {
                    callCount += 1
                    return callCount === 1
                        ? { id: 's1', tag: 't1', metadata: null, agentState: null, namespace: 'default', createdAt: Date.now(), updatedAt: Date.now(), active: false, activeAt: Date.now(), thinking: false, metadataVersion: 1, agentStateVersion: 1, todosUpdatedAt: 0, contentRevision: 0, pendingRequestsCount: 0, pendingRequestKinds: [], backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null, attachedJob: null, attachedJobUpdatedAt: 0, model: null, effort: null }
                        : null
                }
            }
            ,
            messages: {
                hasConversationContent: () => false,
                getMessages: () => [],
                getMessagesByPosition: () => []
            }
        } as unknown as Store

        const cache = new SessionCache(store as never, publisher as never, { getMachine: () => null } as never)

        // First refresh populates the in-memory map
        cache.getOrCreateSession('t1', null, null, 'default')

        // Second refresh: store session is gone → in-memory entry is removed
        // and a session-removed event fires. The namespace must ride along.
        const result = cache.refreshSession('s1')

        expect(result).toBeNull()
        const removedEvent = emitted.find(e => e.type === 'session-removed')
        expect(removedEvent).toBeDefined()
        expect((removedEvent as { namespace?: string }).namespace).toBe('default')
    })
})
