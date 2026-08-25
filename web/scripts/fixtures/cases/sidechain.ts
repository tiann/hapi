import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * Subagent (sidechain) grouping: every sidechain message carries the SDK's
 * parent_tool_use_id (wire key parentToolUseId), and the tracer groups the
 * whole subtree under the Task/Agent tool_use whose id it names
 * (web/src/chat/tracer.ts). The grouped messages reduce recursively into the
 * Task tool-call block's `children`.
 */
export const sidechainCases: FixtureCase[] = [
    {
        name: 'sidechain-task-nested-children',
        description: 'A Task tool_use with sidechain messages grouped under it via parentToolUseId: the prompt-root sidechain entry is consumed (not rendered), the subagent turns reduce into children [agent-text, completed tool-call, agent-text], the parent tool_result completes the Task card, and sidechain usage never feeds latestUsage (the closing root message does).',
        messages: [
            wireMessage({
                id: 'msg-user-601',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Find where the upload retry logic lives.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-602',
                seq: 2,
                createdAt: T0 + 2_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'b5e7a8c9-2acd-4d9e-9fa5-f9a0b1c2d602',
                            parentUuid: null,
                            timestamp: '2025-08-12T11:20:02.005Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    { type: 'text', text: 'Delegating the search to a subagent.' },
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01TaskExplore01',
                                        name: 'Task',
                                        input: {
                                            prompt: 'Locate the retry/backoff implementation for uploads and summarize it.',
                                            subagent_type: 'Explore',
                                            description: 'Find upload retry logic'
                                        }
                                    }
                                ],
                                usage: {
                                    input_tokens: 1740,
                                    output_tokens: 88,
                                    cache_creation_input_tokens: 130,
                                    cache_read_input_tokens: 60110
                                }
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-603',
                seq: 3,
                createdAt: T0 + 2_600,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'c6f8b9d0-3bde-4eaf-8ab6-a0b1c2d3e603',
                            parentUuid: null,
                            isSidechain: true,
                            parentToolUseId: 'toolu_01TaskExplore01',
                            message: {
                                content: 'Locate the retry/backoff implementation for uploads and summarize it.'
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-604',
                seq: 4,
                createdAt: T0 + 4_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'd7a9c0e1-4cef-4fb0-9bc7-b1c2d3e4f604',
                            parentUuid: 'c6f8b9d0-3bde-4eaf-8ab6-a0b1c2d3e603',
                            isSidechain: true,
                            parentToolUseId: 'toolu_01TaskExplore01',
                            timestamp: '2025-08-12T11:20:04.171Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [{ type: 'text', text: 'Scanning the upload path for retry logic.' }],
                                usage: {
                                    input_tokens: 910,
                                    output_tokens: 22,
                                    cache_creation_input_tokens: 0,
                                    cache_read_input_tokens: 8050
                                }
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-605',
                seq: 5,
                createdAt: T0 + 5_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'e8b0d1f2-5dfa-4ac1-8cd8-c2d3e4f5a605',
                            parentUuid: 'd7a9c0e1-4cef-4fb0-9bc7-b1c2d3e4f604',
                            isSidechain: true,
                            parentToolUseId: 'toolu_01TaskExplore01',
                            timestamp: '2025-08-12T11:20:05.044Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01ScGrepRetry01',
                                        name: 'Grep',
                                        input: { pattern: 'withRetry', path: '/repo/web/src/lib' }
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-606',
                seq: 6,
                createdAt: T0 + 5_800,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'f9c1e2a3-6eab-4bd2-9de9-d3e4f5a6b606',
                            parentUuid: 'e8b0d1f2-5dfa-4ac1-8cd8-c2d3e4f5a605',
                            isSidechain: true,
                            parentToolUseId: 'toolu_01TaskExplore01',
                            timestamp: '2025-08-12T11:20:05.702Z',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01ScGrepRetry01',
                                        content: 'web/src/lib/upload.ts:88: return withRetry(uploadChunk, { attempts: 3 })',
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-607',
                seq: 7,
                createdAt: T0 + 7_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'a0d2f3b4-7fbc-4ce3-8efa-e4f5a6b7c607',
                            parentUuid: 'f9c1e2a3-6eab-4bd2-9de9-d3e4f5a6b606',
                            isSidechain: true,
                            parentToolUseId: 'toolu_01TaskExplore01',
                            timestamp: '2025-08-12T11:20:06.911Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [{ type: 'text', text: 'Retry logic lives in web/src/lib/upload.ts: withRetry wraps uploadChunk with 3 attempts.' }]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-608',
                seq: 8,
                createdAt: T0 + 8_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'b1e3a4c5-8acd-4df4-9fab-f5a6b7c8d608',
                            parentUuid: 'b5e7a8c9-2acd-4d9e-9fa5-f9a0b1c2d602',
                            timestamp: '2025-08-12T11:20:08.144Z',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01TaskExplore01',
                                        content: 'Retry logic lives in web/src/lib/upload.ts (withRetry, 3 attempts).',
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-609',
                seq: 9,
                createdAt: T0 + 9_500,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'c2f4b5d6-9bde-4ea5-8abc-a6b7c8d9e609',
                            parentUuid: 'b1e3a4c5-8acd-4df4-9fab-f5a6b7c8d608',
                            timestamp: '2025-08-12T11:20:09.377Z',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [{ type: 'text', text: 'The upload retry logic is in web/src/lib/upload.ts — withRetry with 3 attempts.' }],
                                usage: {
                                    input_tokens: 1930,
                                    output_tokens: 31,
                                    cache_creation_input_tokens: 95,
                                    cache_read_input_tokens: 60340
                                }
                            }
                        }
                    }
                }
            })
        ]
    }
]
