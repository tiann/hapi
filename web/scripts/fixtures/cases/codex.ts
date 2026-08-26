import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * Generic agent family: content.type === 'codex' (AGENT_MESSAGE_PAYLOAD_TYPE,
 * used by Codex/Cursor/OpenCode/Pi/…). Text and reasoning arrive as cumulative
 * stream snapshots keyed by data.id.
 */
export const codexCases: FixtureCase[] = [
    {
        name: 'codex-message-stream-snapshot',
        description: 'Codex family: two message payloads sharing a stream id (data.id) are cumulative snapshots. Expects a single agent-text block keyed by the first message, carrying the final snapshot text.',
        messages: [
            wireMessage({
                id: 'msg-codex-051',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            id: 'item_7',
                            message: 'Tracking down the failing pagination'
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-codex-052',
                seq: 2,
                createdAt: T0 + 900,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            id: 'item_7',
                            message: 'Tracking down the failing pagination test: the cursor math drops the epoch check when seq wraps.'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-reasoning',
        description: 'Codex family: reasoning payload becomes an agent-reasoning block (stream id kept internal — not part of the projection).',
        messages: [
            wireMessage({
                id: 'msg-codex-061',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'reasoning',
                            id: 'rs_0af3d219',
                            message: '**Weighing pagination approaches**\n\nThe epoch guard only fires when the server resets, so the client must drop its window on mismatch.'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-error-event',
        description: 'Codex family: an error payload becomes an agent-event block with {type: error, message} carried verbatim.',
        messages: [
            wireMessage({
                id: 'msg-user-501',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Continue the review.' }
                }
            }),
            wireMessage({
                id: 'msg-codex-502',
                seq: 2,
                createdAt: T0 + 2_700,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'error',
                            message: 'Codex backend disconnected: stream closed before the turn completed'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-context-compacted',
        description: 'Codex family: context_compacted maps to an agent-event of type compact with trigger and preTokens (accepting the snake_case pre_tokens wire key).',
        messages: [
            wireMessage({
                id: 'msg-user-511',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Carry on.' }
                }
            }),
            wireMessage({
                id: 'msg-codex-512',
                seq: 2,
                createdAt: T0 + 3_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'context_compacted',
                            trigger: 'auto',
                            pre_tokens: 186211,
                            thread_id: 'thread-42'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-generated-image',
        description: 'Codex family: generated-image becomes a generated-image block keeping {imageId, fileName, mimeType}; the wire source (inline media provenance) and sourceImageId are web rendering concerns and are dropped by the projection.',
        messages: [
            wireMessage({
                id: 'msg-codex-521',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'generated-image',
                            imageId: 'img-01J9ZD8KM4TQ',
                            sourceImageId: 'ig_58210',
                            fileName: 'latency-chart.png',
                            mimeType: 'image/png',
                            id: 'aed0f1b2-5fb6-4c2d-8e9d-e2f3a4b5c521',
                            source: {
                                ingress: 'tool_result',
                                flavor: 'codex',
                                toolCallId: 'call_img_58210'
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-review-verdict',
        description: 'Codex family: a message whose text is codex review JSON (findings + overall_correctness/…) parses into a codex-review block with the normalized review object (camelCase fields, code_location flattened to filePath/lineStart/lineEnd).',
        messages: [
            wireMessage({
                id: 'msg-codex-531',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            id: '550e8400-e29b-41d4-a716-446655440531',
                            message: '{"findings":[{"title":"[P2] Remove retained sessions when sockets disconnect","body":"Retained sockets survive disconnects.","confidence_score":0.82,"priority":2,"code_location":{"absolute_file_path":"/repo/hub/src/pairing/manager.ts","line_range":{"start":1614,"end":1619}}}],"overall_correctness":"patch is incorrect","overall_explanation":"The message-sending feature retains long-lived sockets but does not fully manage their lifecycle.","overall_confidence_score":0.8}'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-thread-goal-updated',
        description: 'Codex family: thread_goal_updated normalizes to a thread-goal-updated event which is SILENT in the timeline (filtered as a goal-state signal) — expected blocks contain only the user text. latestGoal is derived state outside the normative projection.',
        messages: [
            wireMessage({
                id: 'msg-user-541',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: '/goal Ship the pagination fix' }
                }
            }),
            wireMessage({
                id: 'msg-codex-542',
                seq: 2,
                createdAt: T0 + 1_300,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'thread_goal_updated',
                            thread_id: 'thread-42',
                            turn_id: 'turn-7',
                            goal: {
                                threadId: 'thread-42',
                                objective: 'Ship the pagination fix',
                                status: 'active',
                                tokenBudget: 200000,
                                tokensUsed: 8016,
                                timeUsedSeconds: 42,
                                createdAt: 1755000001300,
                                updatedAt: 1755000001300
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-thread-goal-cleared',
        description: 'Codex family: thread_goal_cleared normalizes to a thread-goal-cleared event which is SILENT in the timeline — expected blocks contain only the user text.',
        messages: [
            wireMessage({
                id: 'msg-user-551',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: '/goal clear' }
                }
            }),
            wireMessage({
                id: 'msg-codex-552',
                seq: 2,
                createdAt: T0 + 1_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'thread_goal_cleared',
                            thread_id: 'thread-42'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-tool-call-result-pair',
        description: 'Codex family: a tool-call (callId + name + structured input) paired with its tool-call-result (output object) merges into one completed tool-call block; input and output are carried verbatim (command as argv array, output as {exit_code, stdout, …}).',
        messages: [
            wireMessage({
                id: 'msg-user-561',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Run the test suite.' }
                }
            }),
            wireMessage({
                id: 'msg-codex-562',
                seq: 2,
                createdAt: T0 + 1_800,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            name: 'CodexBash',
                            callId: 'call_9f2d81aa04',
                            input: {
                                command: ['bash', '-lc', 'bun test'],
                                cwd: '/repo'
                            },
                            id: 'bfe1a2c3-6ac7-4d3e-9fae-f3a4b5c6d562'
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-codex-563',
                seq: 3,
                createdAt: T0 + 9_400,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'call_9f2d81aa04',
                            output: {
                                exit_code: 0,
                                stdout: '420 pass\n0 fail\nRan 420 tests across 37 files. [4.21s]',
                                duration_seconds: 4.21
                            },
                            is_error: false,
                            id: 'c0f2b3d4-7bd8-4e4f-8ab0-a4b5c6d7e563'
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'codex-exploration-tool-group',
        description: 'Codex exploration grouping family: consecutive CodexBash calls whose command_actions are all read/listFiles/search (and command_source is not userShell) collapse into one tool-group in visibleBlocks — a family boundary distinct from the default read/search grouping.',
        messages: [
            wireMessage({
                id: 'msg-user-571',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Where is the pagination cursor built?' }
                }
            }),
            wireMessage({
                id: 'msg-codex-572',
                seq: 2,
                createdAt: T0 + 1_500,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            name: 'CodexBash',
                            callId: 'call_expl_read01',
                            input: {
                                command: ['bash', '-lc', 'cat package.json'],
                                cwd: '/repo',
                                command_source: 'agent',
                                command_actions: [
                                    {
                                        type: 'read',
                                        command: 'cat package.json',
                                        name: 'package.json',
                                        path: '/repo/package.json'
                                    }
                                ]
                            },
                            id: 'd1a3c4e5-8ce9-4f5a-9bc1-b5c6d7e8f572'
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-codex-573',
                seq: 3,
                createdAt: T0 + 2_400,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'call_expl_read01',
                            output: {
                                exit_code: 0,
                                stdout: '{\n  "name": "hapi",\n  "workspaces": ["cli", "hub", "web", "shared"]\n}'
                            },
                            is_error: false,
                            id: 'e2b4d5f6-9dfa-4a6b-8cd2-c6d7e8f9a573'
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-codex-574',
                seq: 4,
                createdAt: T0 + 3_300,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            name: 'CodexBash',
                            callId: 'call_expl_search01',
                            input: {
                                command: ['bash', '-lc', 'rg buildCursor web/src'],
                                cwd: '/repo',
                                command_source: 'agent',
                                command_actions: [
                                    {
                                        type: 'search',
                                        command: 'rg buildCursor web/src',
                                        query: 'buildCursor',
                                        path: 'web/src'
                                    }
                                ]
                            },
                            id: 'f3c5e6a7-0eab-4b7c-9de3-d7e8f9a0b574'
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-codex-575',
                seq: 5,
                createdAt: T0 + 4_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'call_expl_search01',
                            output: {
                                exit_code: 0,
                                stdout: 'web/src/lib/message-window-store.ts:412:function buildCursor(page) {'
                            },
                            is_error: false,
                            id: 'a4d6f7b8-1fbc-4c8d-8ef4-e8f9a0b1c575'
                        }
                    }
                }
            })
        ]
    }
]
