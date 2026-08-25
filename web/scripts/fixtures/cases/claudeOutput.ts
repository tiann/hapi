import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * Claude SDK passthrough family: content.type === 'output', data mirrors the
 * SDK transcript entry ('assistant' / 'user' / 'system' + subtype).
 */
export const claudeOutputCases: FixtureCase[] = [
    {
        name: 'claude-assistant-text',
        description: 'Claude output family: plain assistant text with usage. Expects user-text + agent-text blocks and latestUsage derived from message.usage (contextSize = cache_creation + cache_read + input_tokens).',
        messages: [
            wireMessage({
                id: 'msg-user-001',
                seq: 1,
                createdAt: T0,
                localId: 'local-9e1c2b6a',
                invokedAt: T0 + 350,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Summarize what the hub process does.' },
                    meta: { sentFrom: 'webapp' }
                }
            }),
            wireMessage({
                id: 'msg-agent-002',
                seq: 2,
                createdAt: T0 + 5_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '6d1a9f30-4b2e-4c26-9d1c-a0f4c1e6b001',
                            parentUuid: '41b7a9d2-8f05-4f7e-b6d3-9c2e5a7f4d10',
                            timestamp: '2025-08-12T11:20:05.173Z',
                            isSidechain: false,
                            message: {
                                id: 'msg_01Xw2VuNqYrD8fKp',
                                type: 'message',
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'text',
                                        text: 'The hub is the always-on relay: it stores sessions and messages, fans out SSE events to clients, and forwards permission decisions back to the CLI.'
                                    }
                                ],
                                stop_reason: 'end_turn',
                                usage: {
                                    input_tokens: 2413,
                                    output_tokens: 187,
                                    cache_creation_input_tokens: 1204,
                                    cache_read_input_tokens: 88113,
                                    service_tier: 'standard'
                                }
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-thinking-block',
        description: 'Claude output family: assistant message carrying a thinking block followed by text. Expects agent-reasoning + agent-text blocks from the same message (ids <messageId>:<blockIndex>).',
        messages: [
            wireMessage({
                id: 'msg-user-011',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Why does the reconnect use jitter?' }
                }
            }),
            wireMessage({
                id: 'msg-agent-012',
                seq: 2,
                createdAt: T0 + 4_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '7f2b8c41-5d3f-4e37-8a2d-b1e5d2f7c012',
                            parentUuid: null,
                            timestamp: '2025-08-12T11:20:04.021Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'thinking',
                                        thinking: 'Reconnect stampedes: if every client retries at the same delay, the hub gets a synchronized burst. Adding jitter spreads the retries.',
                                        signature: 'EqQBCkgIBBACGAIiQL5'
                                    },
                                    {
                                        type: 'text',
                                        text: 'Jitter desynchronizes clients so a hub restart does not trigger a thundering-herd of simultaneous reconnects.'
                                    }
                                ],
                                usage: {
                                    input_tokens: 1810,
                                    output_tokens: 96,
                                    cache_creation_input_tokens: 0,
                                    cache_read_input_tokens: 74250
                                }
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-tool-use-result-pair',
        description: 'Claude output family: assistant tool_use (Bash) paired with the tool_result delivered in a later user-typed output entry. Expects one completed tool-call block with the result attached, framed by agent text.',
        messages: [
            wireMessage({
                id: 'msg-user-021',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Run the unit tests.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-022',
                seq: 2,
                createdAt: T0 + 3_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '9a4c1e72-6b0d-4f19-bc3e-d2f6a8b4c022',
                            parentUuid: null,
                            timestamp: '2025-08-12T11:20:03.310Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    { type: 'text', text: 'Running the suite now.' },
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01VqSg8Q3rTests',
                                        name: 'Bash',
                                        input: { command: 'bun test', description: 'Run unit tests' }
                                    }
                                ],
                                usage: {
                                    input_tokens: 1975,
                                    output_tokens: 64,
                                    cache_creation_input_tokens: 310,
                                    cache_read_input_tokens: 70112
                                }
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-023',
                seq: 3,
                createdAt: T0 + 21_400,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'b5d2f803-7c1e-4a2b-8d4f-e3a7b9c5d023',
                            parentUuid: '9a4c1e72-6b0d-4f19-bc3e-d2f6a8b4c022',
                            timestamp: '2025-08-12T11:20:21.702Z',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01VqSg8Q3rTests',
                                        content: '420 pass\n0 fail\nRan 420 tests across 37 files. [4.21s]',
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-024',
                seq: 4,
                createdAt: T0 + 24_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'c6e3a914-8d2f-4b3c-9e5a-f4b8c0d6e024',
                            parentUuid: 'b5d2f803-7c1e-4a2b-8d4f-e3a7b9c5d023',
                            timestamp: '2025-08-12T11:20:24.155Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [{ type: 'text', text: 'All 420 tests pass.' }],
                                usage: {
                                    input_tokens: 2120,
                                    output_tokens: 18,
                                    cache_creation_input_tokens: 145,
                                    cache_read_input_tokens: 70422
                                }
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-system-api-error',
        description: 'Claude output family: system subtype api_error becomes an agent-event block with type api-error (retryAttempt/maxRetries/error carried through).',
        messages: [
            wireMessage({
                id: 'msg-user-031',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Continue with the refactor.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-032',
                seq: 2,
                createdAt: T0 + 2_500,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'api_error',
                            uuid: 'd7f4b025-9e3a-4c4d-8f6b-a5c9d1e7f032',
                            retryAttempt: 2,
                            maxRetries: 10,
                            error: { status: 529, message: 'Overloaded' }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-system-away-summary',
        description: 'Claude output family: system subtype away_summary (auto recap written by the local TUI on blur/focus) becomes an agent-event block with type recap; text comes from data.content.',
        messages: [
            wireMessage({
                id: 'msg-user-201',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Continue where we left off.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-202',
                seq: 2,
                createdAt: T0 + 1_500,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'away_summary',
                            uuid: 'a2b3c4d5-1e2f-4a3b-8c4d-e5f6a7b8c202',
                            content: 'Was refactoring the SSE reconnect loop; next step is wiring the jittered backoff into useSSE.'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-system-microcompact-boundary',
        description: 'Claude output family: system subtype microcompact_boundary becomes an agent-event block with type microcompact; trigger/preTokens/tokensSaved come from data.microcompactMetadata.',
        messages: [
            wireMessage({
                id: 'msg-user-211',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Keep going with the audit.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-212',
                seq: 2,
                createdAt: T0 + 2_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'microcompact_boundary',
                            uuid: 'b3c4d5e6-2f3a-4b4c-9d5e-f6a7b8c9d212',
                            microcompactMetadata: {
                                trigger: 'auto',
                                preTokens: 145200,
                                tokensSaved: 38700
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-system-compact-boundary',
        description: 'Claude output family: system subtype compact_boundary becomes an agent-event block with type compact; trigger/preTokens come from data.compactMetadata.',
        messages: [
            wireMessage({
                id: 'msg-user-221',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: '/compact' }
                }
            }),
            wireMessage({
                id: 'msg-agent-222',
                seq: 2,
                createdAt: T0 + 3_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'compact_boundary',
                            uuid: 'c4d5e6f7-3a4b-4c5d-8e6f-a7b8c9d0e222',
                            compactMetadata: {
                                trigger: 'manual',
                                preTokens: 167189
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-task-notification',
        description: 'Claude output family: a user-typed entry whose string content is a <task-notification> envelope normalizes as sidechain; the reducer extracts the <summary> as an agent-event of type message (no parentUuid on the wire keeps it in the root lane).',
        messages: [
            wireMessage({
                id: 'msg-user-231',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Run the dev server in the background.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-232',
                seq: 2,
                createdAt: T0 + 9_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'd5e6f7a8-4b5c-4d6e-9f7a-b8c9d0e1f232',
                            message: {
                                content: '<task-notification><task-id>bash_1</task-id><summary>Background command "bun run dev" exited with code 0</summary></task-notification>'
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-multi-block-image-result',
        description: 'Claude output family: one assistant message carrying multiple blocks (text + tool_use) yields agent-text + tool-call from the same message; the tool_result arrives with array-of-parts content (text part + base64 image part) which is attached to tool.result verbatim.',
        messages: [
            wireMessage({
                id: 'msg-user-241',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Take a screenshot of the failing test run.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-242',
                seq: 2,
                createdAt: T0 + 2_800,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'e6f7a8b9-5c6d-4e7f-8a8b-c9d0e1f2a242',
                            parentUuid: null,
                            timestamp: '2025-08-12T11:20:02.744Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    { type: 'text', text: 'Grabbing the screenshot now.' },
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01ShotFailRun1',
                                        name: 'mcp__playwright__screenshot',
                                        input: { selector: '#test-run-4' }
                                    }
                                ],
                                usage: {
                                    input_tokens: 1620,
                                    output_tokens: 41,
                                    cache_creation_input_tokens: 220,
                                    cache_read_input_tokens: 64080
                                }
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-243',
                seq: 3,
                createdAt: T0 + 5_600,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'f7a8b9c0-6d7e-4f8a-9b9c-d0e1f2a3b243',
                            parentUuid: 'e6f7a8b9-5c6d-4e7f-8a8b-c9d0e1f2a242',
                            timestamp: '2025-08-12T11:20:05.512Z',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01ShotFailRun1',
                                        content: [
                                            { type: 'text', text: 'Screenshot captured.' },
                                            {
                                                type: 'image',
                                                source: {
                                                    type: 'base64',
                                                    media_type: 'image/png',
                                                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
                                                }
                                            }
                                        ],
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'claude-system-turn-duration',
        description: 'Claude output family: system subtype turn_duration is consumed by the reducer (folded into the preceding block, no visible event row). Expects only user-text + agent-text blocks; durationMs itself is advisory and outside the normative projection.',
        messages: [
            wireMessage({
                id: 'msg-user-041',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Rename the flag and push.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-042',
                seq: 2,
                createdAt: T0 + 5_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'e8a5c136-0f4b-4d5e-9a7c-b6d0e2f8a042',
                            parentUuid: null,
                            timestamp: '2025-08-12T11:20:05.006Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [{ type: 'text', text: 'Done — renamed the flag and pushed the branch.' }]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-043',
                seq: 3,
                createdAt: T0 + 5_450,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'turn_duration',
                            uuid: 'f9b6d247-1a5c-4e6f-8b8d-c7e1f3a9b043',
                            durationMs: 5417,
                            messageId: 'msg-agent-042'
                        }
                    }
                }
            })
        ]
    }
]
