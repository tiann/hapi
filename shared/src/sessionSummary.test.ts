import { describe, expect, it } from 'bun:test'
import type { Session } from './schemas'
import { getPendingRequestKinds, toSessionSummary } from './sessionSummary'

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
})
