import { describe, expect, test } from 'bun:test'
import { toSessionSummary } from './sessionSummary'
import type { Session } from './schemas'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: null,
        modelReasoningEffort: null,
        serviceTier: null,
        effort: null,
        ...overrides
    }
}

describe('toSessionSummary', () => {
    test('carries Codex service tier into session summaries', () => {
        expect(toSessionSummary(createSession({ serviceTier: 'fast' })).serviceTier).toBe('fast')
        expect(toSessionSummary(createSession({ serviceTier: null })).serviceTier).toBeNull()
    })

    test('uses Hermes session id as the generic agent session id', () => {
        const summary = toSessionSummary(createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'hermes-moa',
                hermesSessionId: 'hermes-runtime-1'
            }
        }))

        expect(summary.metadata?.agentSessionId).toBe('hermes-runtime-1')
    })
})
