import type { Session } from '@/types/api'
import { T0 } from '../cases/support'
import type { SseFixtureCase } from './types'

/**
 * Hand-authored versioned-patch scenarios. Every case pins how
 * `applySessionDetailPatch` treats a `session-updated` SessionPatch against a
 * cached detail Session: flat fields are last-write-wins, `updatedAt` is
 * max-monotonic, and the four versioned wrappers (metadata / agentState /
 * todos / teamState) apply only when strictly newer than the cached
 * watermark. Timestamps derive from the fixed T0 so output is deterministic.
 */

/** Baseline cached session; cases override the fields under test. All
 *  schema-defaulted fields are explicit so the stored document equals its own
 *  `SessionSchema.parse` (asserted by the generator). */
function baseSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'sess-sse-fixture',
        namespace: 'default',
        seq: 12,
        createdAt: T0 - 3_600_000,
        updatedAt: T0,
        active: true,
        activeAt: T0,
        metadata: {
            path: '/home/dev/project',
            host: 'devbox',
            name: 'project',
            flavor: 'claude'
        },
        metadataVersion: 3,
        agentState: null,
        agentStateVersion: 5,
        thinking: false,
        thinkingAt: 0,
        activeTurnStartedAt: null,
        model: 'claude-sonnet-4-6',
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        ...overrides
    }
}

export const sseFixtureCases: SseFixtureCase[] = [
    {
        name: 'metadata-newer-version-applied',
        description: 'A metadata wrapper with version strictly greater than the cached metadataVersion replaces the value and stores the version; the accompanying newer updatedAt advances.',
        initialSession: baseSession(),
        patches: [
            {
                updatedAt: T0 + 10_000,
                metadata: {
                    version: 4,
                    value: {
                        path: '/home/dev/project',
                        host: 'devbox',
                        name: 'project',
                        flavor: 'claude',
                        summary: { text: 'Add retry to upload path', updatedAt: T0 + 9_000 }
                    }
                }
            }
        ]
    },
    {
        name: 'metadata-equal-version-dropped',
        description: 'A metadata wrapper whose version equals the cached metadataVersion is dropped even though its value differs — the gate is strictly-greater on version, never a value comparison (dual SSE connections can replay the same version).',
        initialSession: baseSession(),
        patches: [
            {
                metadata: {
                    version: 3,
                    value: {
                        path: '/home/dev/project',
                        host: 'devbox',
                        name: 'renamed-should-not-apply',
                        flavor: 'claude'
                    }
                }
            }
        ]
    },
    {
        name: 'agent-state-stale-version-dropped',
        description: 'An agentState wrapper older than the cached agentStateVersion is rejected: applying it would resurrect a permission request that was already resolved into completedRequests.',
        initialSession: baseSession({
            agentState: {
                requests: null,
                completedRequests: {
                    'req-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm -rf build' },
                        createdAt: T0 - 30_000,
                        completedAt: T0 - 20_000,
                        status: 'approved',
                        decision: 'approved'
                    }
                }
            },
            agentStateVersion: 5
        }),
        patches: [
            {
                agentState: {
                    version: 4,
                    value: {
                        requests: {
                            'req-1': {
                                tool: 'Bash',
                                arguments: { command: 'rm -rf build' },
                                createdAt: T0 - 30_000
                            }
                        }
                    }
                }
            }
        ]
    },
    {
        name: 'agent-state-out-of-order-versions',
        description: 'Out-of-order arrival across the two SSE connections: version 7 lands first and applies; the older version 6 arrives second and is dropped. Final state is the v7 value.',
        initialSession: baseSession(),
        patches: [
            {
                agentState: {
                    version: 7,
                    value: {
                        requests: {
                            'req-2': {
                                tool: 'Write',
                                arguments: { file_path: '/home/dev/project/README.md' },
                                createdAt: T0 + 2_000
                            }
                        }
                    }
                }
            },
            {
                agentState: {
                    version: 6,
                    value: {
                        requests: {
                            'req-1': {
                                tool: 'Bash',
                                arguments: { command: 'ls' },
                                createdAt: T0 + 1_000
                            }
                        }
                    }
                }
            }
        ]
    },
    {
        name: 'todos-version-watermark-from-absent',
        description: 'todos wrappers gate on todosUpdatedAt with an absent watermark treated as 0: the first patch applies, then an older-versioned todos replay is dropped instead of resurrecting the pre-update list.',
        initialSession: baseSession(),
        patches: [
            {
                todos: {
                    version: T0 + 300_000,
                    value: [
                        { content: 'Wire the SSE reconnect backoff', status: 'completed', priority: 'high', id: 'todo-1' },
                        { content: 'Port the patch gate to native', status: 'in_progress', priority: 'medium', id: 'todo-2', activeForm: 'Porting the patch gate to native' }
                    ]
                }
            },
            {
                todos: {
                    version: T0 + 200_000,
                    value: [
                        { content: 'Wire the SSE reconnect backoff', status: 'in_progress', priority: 'high', id: 'todo-1', activeForm: 'Wiring the SSE reconnect backoff' }
                    ]
                }
            }
        ]
    },
    {
        name: 'team-state-null-clear',
        description: 'teamState with value null means "team deleted": a strictly newer version clears the field entirely (absent in the expected session) and stores the watermark so a lagged pre-delete patch cannot resurrect the team.',
        initialSession: baseSession({
            teamState: {
                teamName: 'hapi-dev',
                members: [
                    { name: 'lead', agentType: 'claude', status: 'active' },
                    { name: 'reviewer', agentType: 'claude', status: 'idle' }
                ],
                updatedAt: T0 - 100_000
            },
            teamStateUpdatedAt: T0 - 100_000
        }),
        patches: [
            {
                teamState: {
                    version: T0 + 200_000,
                    value: null
                }
            }
        ]
    },
    {
        name: 'updated-at-max-monotonic',
        description: 'updatedAt is max-monotonic: a patch carrying an older updatedAt applies its other fields without rewinding the clock; a newer updatedAt advances it; an older updatedAt alone is a no-op (unchanged).',
        initialSession: baseSession(),
        patches: [
            { updatedAt: T0 - 5_000, thinking: true },
            { updatedAt: T0 + 5_000 },
            { updatedAt: T0 - 2_000 }
        ]
    },
    {
        name: 'flat-fields-last-write-wins',
        description: 'Flat fields (active, thinking, model, modelReasoningEffort, effort, permissionMode) are last-write-wins assignments with no version gate; serviceTier additionally honors an explicit null (key present) as a clear.',
        initialSession: baseSession({ serviceTier: 'standard' }),
        patches: [
            {
                active: false,
                thinking: true,
                model: 'claude-opus-4-6',
                modelReasoningEffort: 'high',
                effort: 'high',
                permissionMode: 'acceptEdits'
            },
            { serviceTier: null }
        ]
    },
    {
        name: 'active-turn-started-at-not-applied',
        description: 'Pins actual web behavior: applySessionDetailPatch has no branch for activeTurnStartedAt, so a patch carrying only it is a no-op, and in a mixed patch the other fields apply while activeTurnStartedAt keeps its cached value. (Clients relying on this field must take it from full-session payloads.)',
        initialSession: baseSession(),
        patches: [
            { activeTurnStartedAt: T0 + 5_000 },
            { activeTurnStartedAt: T0 + 5_000, thinking: true }
        ]
    },
    {
        name: 'keepalive-subminute-active-at-dropped',
        description: 'Keep-alive noise gate: a patch whose only effective change is an activeAt delta below 60s is render-irrelevant and returns unchanged (the cached activeAt does NOT move); a delta of at least 60s applies.',
        initialSession: baseSession(),
        patches: [
            { active: true, thinking: false, activeAt: T0 + 10_000 },
            { active: true, thinking: false, activeAt: T0 + 60_000 }
        ]
    },
    {
        name: 'mixed-flat-and-versioned-patch',
        description: 'One patch carrying flat fields, a newer metadata wrapper, and a stale agentState wrapper: the flat fields and metadata apply, the stale agentState is rejected, and all of it happens in a single applied call.',
        initialSession: baseSession({
            agentState: { controlledByUser: false },
            agentStateVersion: 5
        }),
        patches: [
            {
                thinking: true,
                updatedAt: T0 + 30_000,
                metadata: {
                    version: 5,
                    value: {
                        path: '/home/dev/project',
                        host: 'devbox',
                        name: 'project-renamed',
                        flavor: 'claude'
                    }
                },
                agentState: {
                    version: 2,
                    value: {
                        requests: {
                            'req-stale': {
                                tool: 'Bash',
                                arguments: { command: 'echo stale' },
                                createdAt: T0 - 60_000
                            }
                        }
                    }
                }
            }
        ]
    },
    {
        name: 'scratchlist-updated-at-trigger-only',
        description: 'scratchlistUpdatedAt is a refetch trigger, not session state: the patch validates and is render-relevant, but applySessionDetailPatch stores nothing and reports unchanged. Clients react by refetching the scratchlist endpoint, never by mutating the session.',
        initialSession: baseSession(),
        patches: [
            { scratchlistUpdatedAt: T0 + 900_000 }
        ]
    }
]
