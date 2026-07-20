import { describe, expect, it } from 'bun:test'
import type { Session } from './schemas'
import {
    PENDING_REQUEST_SUMMARY_CAP,
    getPendingRequestKinds,
    getPendingRequests,
    toSessionSummary
} from './sessionSummary'

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        active: true,
        activeAt: 1000,
        updatedAt: 2000,
        metadata: { path: '/proj', host: 'local' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        ...overrides
    }
}

describe('getPendingRequestKinds', () => {
    it('classifies ask-user tools as input', () => {
        const kinds = getPendingRequestKinds(makeSession({
            agentState: {
                requests: {
                    req1: { tool: 'AskUserQuestion', arguments: {} }
                }
            }
        }))
        expect(kinds).toEqual(['input'])
    })

    it('classifies other pending tools as permission', () => {
        const kinds = getPendingRequestKinds(makeSession({
            agentState: {
                requests: {
                    req1: { tool: 'Bash', arguments: {} }
                }
            }
        }))
        expect(kinds).toEqual(['permission'])
    })

    it('returns both kinds when mixed requests are pending', () => {
        const kinds = getPendingRequestKinds(makeSession({
            agentState: {
                requests: {
                    req1: { tool: 'Bash', arguments: {} },
                    req2: { tool: 'ask_user_question', arguments: {} }
                }
            }
        }))
        expect(kinds).toEqual(['permission', 'input'])
    })
})

describe('toSessionSummary', () => {
    it('uses grokSessionId as the native resume token', () => {
        const summary = toSessionSummary(makeSession({
            metadata: {
                path: '/proj',
                host: 'local',
                flavor: 'grok',
                grokSessionId: 'grok-session-1'
            }
        }))
        expect(summary.metadata?.agentSessionId).toBe('grok-session-1')
    })

    it('includes pending request kinds and background task count', () => {
        const summary = toSessionSummary(makeSession({
            backgroundTaskCount: 2,
            agentState: {
                requests: {
                    req1: { tool: 'ExitPlanMode', arguments: {} }
                }
            }
        }))

        expect(summary.pendingRequestKinds).toEqual(['input'])
        expect(summary.pendingRequestsCount).toBe(1)
        expect(summary.backgroundTaskCount).toBe(2)
        expect(summary.futureScheduledMessageCount).toBe(0)
    })

    it('includes lifecycleState in summary metadata', () => {
        const summary = toSessionSummary(makeSession({
            metadata: {
                path: '/proj',
                host: 'local',
                lifecycleState: 'archived'
            }
        }))

        expect(summary.metadata?.lifecycleState).toBe('archived')
    })

    it('includes structured pendingRequests for hover-tooltip copy', () => {
        const summary = toSessionSummary(makeSession({
            updatedAt: 5000,
            agentState: {
                requests: {
                    req1: { tool: 'Bash', arguments: {}, createdAt: 100 },
                    req2: { tool: 'AskUserQuestion', arguments: {}, createdAt: 50 },
                    req3: { tool: 'Edit', arguments: {} }
                }
            }
        }))

        expect(summary.pendingRequestsCount).toBe(3)
        expect(summary.pendingRequestKinds).toEqual(['permission', 'input'])
        expect(summary.pendingRequests).toHaveLength(3)
        expect(summary.pendingRequests[0]).toEqual({
            id: 'req2',
            kind: 'input',
            tool: 'AskUserQuestion',
            since: 50
        })
        expect(summary.pendingRequests[1]).toEqual({
            id: 'req1',
            kind: 'permission',
            tool: 'Bash',
            since: 100
        })
        expect(summary.pendingRequests[2]).toEqual({
            id: 'req3',
            kind: 'permission',
            tool: 'Edit',
            since: 5000
        })
    })

    it('returns empty pendingRequests when agentState has no requests', () => {
        const summary = toSessionSummary(makeSession({ agentState: null }))
        expect(summary.pendingRequests).toEqual([])
    })
})

describe('getPendingRequests', () => {
    it('caps the array length while leaving pendingRequestsCount untouched', () => {
        const requests: Record<string, { tool: string; arguments: unknown; createdAt: number }> = {}
        for (let i = 0; i < PENDING_REQUEST_SUMMARY_CAP + 3; i += 1) {
            requests[`req-${i.toString().padStart(2, '0')}`] = {
                tool: 'Bash',
                arguments: {},
                createdAt: i
            }
        }
        const session = makeSession({ agentState: { requests } })

        const slice = getPendingRequests(session)
        expect(slice).toHaveLength(PENDING_REQUEST_SUMMARY_CAP)
        // Oldest-first → the first `cap` items by createdAt should win.
        expect(slice.map(r => r.id)).toEqual(
            Array.from({ length: PENDING_REQUEST_SUMMARY_CAP }, (_, i) => `req-${i.toString().padStart(2, '0')}`)
        )

        const summary = toSessionSummary(session)
        expect(summary.pendingRequestsCount).toBe(PENDING_REQUEST_SUMMARY_CAP + 3)
        expect(summary.pendingRequests).toHaveLength(PENDING_REQUEST_SUMMARY_CAP)
    })

    it('breaks ties on createdAt by id (stable across hub restarts)', () => {
        const session = makeSession({
            agentState: {
                requests: {
                    'req-b': { tool: 'Bash', arguments: {}, createdAt: 100 },
                    'req-a': { tool: 'Edit', arguments: {}, createdAt: 100 }
                }
            }
        })
        const slice = getPendingRequests(session)
        expect(slice.map(r => r.id)).toEqual(['req-a', 'req-b'])
    })
})

describe('getPendingRequestKinds', () => {
    it('reads from the FULL request set (not the capped pendingRequests slice)', () => {
        const requests: Record<string, { tool: string; arguments: unknown; createdAt: number }> = {}
        // First CAP requests are all permission, last one is input — must still
        // surface 'input' even though it would fall outside the capped slice.
        for (let i = 0; i < PENDING_REQUEST_SUMMARY_CAP; i += 1) {
            requests[`perm-${i}`] = { tool: 'Bash', arguments: {}, createdAt: i }
        }
        requests['ask'] = {
            tool: 'AskUserQuestion',
            arguments: {},
            createdAt: PENDING_REQUEST_SUMMARY_CAP + 100
        }

        const kinds = getPendingRequestKinds(makeSession({ agentState: { requests } }))
        expect(kinds).toEqual(['permission', 'input'])
    })
})
