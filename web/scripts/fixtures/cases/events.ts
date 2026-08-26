import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * Event family: content.type === 'event', data is the AgentEvent union.
 */
export const eventCases: FixtureCase[] = [
    {
        name: 'event-ready',
        description: 'Event family: a ready event sets top-level hasReadyEvent and is consumed — it must NOT surface as a chat block.',
        messages: [
            wireMessage({
                id: 'msg-user-071',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'hi' }
                }
            }),
            wireMessage({
                id: 'msg-event-072',
                seq: 2,
                createdAt: T0 + 1_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'event',
                        data: { type: 'ready' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-limit-reached',
        description: 'Event family: limit-reached renders as an agent-event block with the event payload carried verbatim (endsAt is unix seconds).',
        messages: [
            wireMessage({
                id: 'msg-user-081',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Keep going with the migration.' }
                }
            }),
            wireMessage({
                id: 'msg-event-082',
                seq: 2,
                createdAt: T0 + 2_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'event',
                        data: { type: 'limit-reached', endsAt: 1755010800, limitType: 'five_hour' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-switch',
        description: 'Event family: switch (local/remote takeover) renders as an agent-event block with the payload carried verbatim.',
        messages: [
            wireMessage({
                id: 'msg-event-301',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        id: '0f4b6a1c-91d2-4e37-8b5a-c6d7e8f9a301',
                        type: 'event',
                        data: { type: 'switch', mode: 'remote' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-message',
        description: 'Event family: a status message event renders as an agent-event block with {type: message, message} carried verbatim.',
        messages: [
            wireMessage({
                id: 'msg-event-311',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        id: '1a5c7b2d-02e3-4f48-9c6b-d7e8f9a0b311',
                        type: 'event',
                        data: { type: 'message', message: 'Model changed to gpt-5.2-codex' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-error',
        description: 'Event family: an error event renders as an agent-event block with {type: error, message} carried verbatim.',
        messages: [
            wireMessage({
                id: 'msg-user-321',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Try resuming the run.' }
                }
            }),
            wireMessage({
                id: 'msg-event-322',
                seq: 2,
                createdAt: T0 + 1_400,
                content: {
                    role: 'agent',
                    content: {
                        id: '2b6d8c3e-13f4-4a59-8d7c-e8f9a0b1c322',
                        type: 'event',
                        data: { type: 'error', message: 'Claude Code process exited unexpectedly (code 1)' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-title-changed-dedupe',
        description: 'title-changed is synthesized from a mcp__hapi__change_title tool_use (no tool card, one event even though tool_use and tool_result both mention it). dedupeAgentEvents then drops a message event echoing the exact title and folds consecutive identical message events into one.',
        messages: [
            wireMessage({
                id: 'msg-user-331',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Rename this session appropriately.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-332',
                seq: 2,
                createdAt: T0 + 2_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '3c7e9d4f-24a5-4b6a-9e8d-f9a0b1c2d332',
                            parentUuid: null,
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01TitleChange01',
                                        name: 'mcp__hapi__change_title',
                                        input: { title: 'Fix pagination cursor math' }
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-333',
                seq: 3,
                createdAt: T0 + 2_600,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: '4d8fae50-35b6-4c7b-8f9e-a0b1c2d3e333',
                            parentUuid: '3c7e9d4f-24a5-4b6a-9e8d-f9a0b1c2d332',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01TitleChange01',
                                        content: 'Successfully changed chat title to: "Fix pagination cursor math"',
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-event-334',
                seq: 4,
                createdAt: T0 + 3_000,
                content: {
                    role: 'agent',
                    content: {
                        id: '5e9fbf61-46c7-4d8c-9a0f-b1c2d3e4f334',
                        type: 'event',
                        data: { type: 'message', message: 'Fix pagination cursor math' }
                    }
                }
            }),
            wireMessage({
                id: 'msg-event-335',
                seq: 5,
                createdAt: T0 + 3_500,
                content: {
                    role: 'agent',
                    content: {
                        id: '6fa0c072-57d8-4e9d-8b1a-c2d3e4f5a335',
                        type: 'event',
                        data: { type: 'message', message: 'Compacting conversation.' }
                    }
                }
            }),
            wireMessage({
                id: 'msg-event-336',
                seq: 6,
                createdAt: T0 + 3_900,
                content: {
                    role: 'agent',
                    content: {
                        id: '70b1d183-68e9-4fae-9c2b-d3e4f5a6b336',
                        type: 'event',
                        data: { type: 'message', message: 'Compacting conversation.' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-limit-warning-from-text',
        description: 'limit-warning has no dedicated wire event: the CLI writes an assistant text in the pipe format "Claude AI usage limit warning|<unixSeconds>|<percentInt>|<limitType>", which the reducer parses into an agent-event {type: limit-warning, utilization (0-1), endsAt, limitType} instead of a text block.',
        messages: [
            wireMessage({
                id: 'msg-user-341',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Keep working through the checklist.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-342',
                seq: 2,
                createdAt: T0 + 1_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '81c2e294-79fa-4b0f-8d3c-e4f5a6b7c342',
                            parentUuid: null,
                            timestamp: '2025-08-12T11:20:01.088Z',
                            message: {
                                role: 'assistant',
                                content: [
                                    { type: 'text', text: 'Claude AI usage limit warning|1755010800|90|weekly' }
                                ]
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'event-api-error-folding',
        description: 'foldApiErrorEvents: three consecutive api_error system entries (retry 1, 2, 3) fold into a single agent-event carrying the LATEST api-error state; a following assistant text ends the run.',
        messages: [
            wireMessage({
                id: 'msg-user-351',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Summarize the diff.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-352',
                seq: 2,
                createdAt: T0 + 2_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'api_error',
                            uuid: '92d3f3a5-8a0b-4c1a-9e4d-f5a6b7c8d352',
                            retryAttempt: 1,
                            maxRetries: 10,
                            error: { status: 529, message: 'Overloaded' }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-353',
                seq: 3,
                createdAt: T0 + 4_500,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'api_error',
                            uuid: 'a3e4a4b6-9b1c-4d2b-8f5e-a6b7c8d9e353',
                            retryAttempt: 2,
                            maxRetries: 10,
                            error: { status: 529, message: 'Overloaded' }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-354',
                seq: 4,
                createdAt: T0 + 8_900,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'api_error',
                            uuid: 'b4f5b5c7-0c2d-4e3c-9a6f-b7c8d9e0f354',
                            retryAttempt: 3,
                            maxRetries: 10,
                            error: { status: 529, message: 'Overloaded' }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-355',
                seq: 5,
                createdAt: T0 + 15_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'c5a6c6d8-1d3e-4f4d-8b7a-c8d9e0f1a355',
                            parentUuid: null,
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [{ type: 'text', text: 'The diff renames the retry flag and threads it through the upload path.' }]
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'event-turn-duration',
        description: 'Event family: a turn-duration event (durationMs + targetMessageId) is consumed by the reducer — folded into the targeted block, never surfacing as a chat block; durationMs itself is advisory and outside the normative projection.',
        messages: [
            wireMessage({
                id: 'msg-user-361',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Give me a one-line status.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-362',
                seq: 2,
                createdAt: T0 + 2_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'd6b7d7e9-2e4f-4a5e-9c8b-d9e0f1a2b362',
                            parentUuid: null,
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [{ type: 'text', text: 'Migration is applied; tests are green.' }]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-event-363',
                seq: 3,
                createdAt: T0 + 2_450,
                content: {
                    role: 'agent',
                    content: {
                        id: 'e7c8e8fa-3f5a-4b6f-8d9c-e0f1a2b3c363',
                        type: 'event',
                        data: { type: 'turn-duration', durationMs: 2214, targetMessageId: 'msg-agent-362' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-compact-summary',
        description: 'Event family: compact-summary (structured result of Pi\'s compact RPC) renders as an agent-event block with summary/tokensBefore/estimatedTokensAfter carried verbatim.',
        messages: [
            wireMessage({
                id: 'msg-event-371',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        id: 'f8d9f90b-4a6b-4c7a-9ead-f1a2b3c4d371',
                        type: 'event',
                        data: {
                            type: 'compact-summary',
                            summary: '## Context\n- Refactoring the SSE reconnect backoff.\n- Next: wire jitter into the retry delay.',
                            tokensBefore: 145000,
                            estimatedTokensAfter: 12000
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'event-abort-restore',
        description: 'Event family: abort-restore (composer side-effect carrying the aborted prompt text) is consumed by the reducer and must NOT surface as a chat block.',
        messages: [
            wireMessage({
                id: 'msg-user-381',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Refactor the reconnect loop.' }
                }
            }),
            wireMessage({
                id: 'msg-event-382',
                seq: 2,
                createdAt: T0 + 900,
                content: {
                    role: 'agent',
                    content: {
                        id: '09eafa1c-5b7c-4d8b-8fae-a2b3c4d5e382',
                        type: 'event',
                        data: { type: 'abort-restore', text: 'Refactor the reconnect loop.' }
                    }
                }
            })
        ]
    },
    {
        name: 'event-unknown-type',
        description: 'Event family open catch-all: an event whose type is not a known AgentEvent member passes through the pipeline untouched and renders as an agent-event block with every payload field carried verbatim (forward compatibility).',
        messages: [
            wireMessage({
                id: 'msg-event-391',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        id: '1afb0b2d-6c8d-4e9c-9b0f-b3c4d5e6f391',
                        type: 'event',
                        data: {
                            type: 'quota-sync',
                            quota: { used: 123456, limit: 500000 },
                            note: 'clients must pass unknown event types through verbatim'
                        }
                    }
                }
            })
        ]
    }
]
