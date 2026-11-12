import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

describe('SessionCache.cancelStalePermissionRequest (tiann/hapi#2414)', () => {
    it('moves a stale agentState.requests entry into completedRequests and emits session-updated', () => {
        const store = new Store(':memory:')
        const events: Array<{ type: string; data?: { agentState?: { value?: { requests?: Record<string, unknown> } } } }> = []
        try {
            store.machines.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '1', displayName: 'test' },
                null,
                'default'
            )
            const created = store.sessions.getOrCreateSession(
                'tag',
                { path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'claude' },
                null,
                'default'
            )
            store.sessions.updateSessionAgentState(
                created.id,
                {
                    requests: {
                        'toolu_stale': {
                            tool: 'AskUserQuestion',
                            arguments: { questions: [] },
                            createdAt: 1
                        }
                    },
                    completedRequests: {}
                },
                created.agentStateVersion,
                'default'
            )

            const publisher = {
                emit: (event: (typeof events)[number]) => {
                    events.push(event)
                }
            } as unknown as EventPublisher
            const cache = new SessionCache(store, publisher, {})
            cache.refreshSession(created.id)

            const cleared = cache.cancelStalePermissionRequest(
                created.id,
                'toolu_stale',
                'Permission request is no longer active: toolu_stale'
            )
            expect(cleared).toBe(true)

            const session = cache.getSession(created.id)
            expect(session?.agentState?.requests?.['toolu_stale']).toBeUndefined()
            expect(session?.agentState?.completedRequests?.['toolu_stale']).toMatchObject({
                status: 'canceled',
                decision: 'abort',
                reason: 'Permission request is no longer active: toolu_stale'
            })

            const agentEvents = events.filter((event) => event.type === 'session-updated' && event.data?.agentState)
            expect(agentEvents.length).toBeGreaterThanOrEqual(1)
            expect(agentEvents.at(-1)?.data?.agentState?.value?.requests?.['toolu_stale']).toBeUndefined()
        } finally {
            store.close()
        }
    })

    it('returns false when the request id is not pending', () => {
        const store = new Store(':memory:')
        try {
            store.machines.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '1', displayName: 'test' },
                null,
                'default'
            )
            const created = store.sessions.getOrCreateSession(
                'tag',
                { path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'claude' },
                null,
                'default'
            )
            const publisher = { emit: () => {} } as unknown as EventPublisher
            const cache = new SessionCache(store, publisher, {})
            cache.refreshSession(created.id)
            expect(cache.cancelStalePermissionRequest(created.id, 'missing')).toBe(false)
        } finally {
            store.close()
        }
    })
})
