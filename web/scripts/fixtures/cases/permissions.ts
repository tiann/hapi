import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * Permission requests are NOT messages: they live in session.agentState
 * (requests → completedRequests). A pending request whose tool_use message is
 * not in the loaded window must still be answerable, so the reducer
 * synthesizes a pending tool-call block for it — but only when the request is
 * pending, has no tool call/result in the transcript, and is not older than
 * the oldest loaded message (web/src/chat/reducer.ts).
 */
export const permissionCases: FixtureCase[] = [
    {
        name: 'permission-synthesized-pending',
        description: 'A pending agentState request with no matching tool_use in the (older) message window synthesizes a pending tool-call block: state pending, permission.status pending, input from request.arguments.',
        messages: [
            wireMessage({
                id: 'msg-user-121',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Install the missing dependency.' }
                }
            })
        ],
        agentState: {
            requests: {
                'req-01J5XKQ8TZ3M': {
                    tool: 'Bash',
                    arguments: { command: 'bun add zod', description: 'Install zod' },
                    createdAt: T0 + 6_000
                }
            },
            completedRequests: {}
        }
    },
    {
        name: 'permission-approved-for-session',
        description: 'Completed request approved with decision approved_for_session + mode + allowTools: the permission (from agentState.completedRequests, keyed by the tool_use id) attaches to the tool-call block; wire key allowTools projects as permission.allowedTools; the paired tool_result completes the tool.',
        messages: [
            wireMessage({
                id: 'msg-user-401',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Install zod and use it for the config schema.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-402',
                seq: 2,
                createdAt: T0 + 2_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '2b0c1d3e-7d9e-4faa-8c1b-c4d5e6f7a402',
                            parentUuid: null,
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01PermBash0001',
                                        name: 'Bash',
                                        input: { command: 'bun add zod', description: 'Install zod' }
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-403',
                seq: 3,
                createdAt: T0 + 14_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: '3c1d2e4f-8eaf-4abb-9d2c-d5e6f7a8b403',
                            parentUuid: '2b0c1d3e-7d9e-4faa-8c1b-c4d5e6f7a402',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01PermBash0001',
                                        content: 'installed zod@4.2.1',
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            })
        ],
        agentState: {
            requests: {},
            completedRequests: {
                toolu_01PermBash0001: {
                    tool: 'Bash',
                    arguments: { command: 'bun add zod', description: 'Install zod' },
                    createdAt: T0 + 2_200,
                    completedAt: T0 + 6_500,
                    status: 'approved',
                    mode: 'acceptEdits',
                    decision: 'approved_for_session',
                    allowTools: ['Bash']
                }
            }
        }
    },
    {
        name: 'permission-denied-with-reason',
        description: 'Completed request denied with a reason and no tool_result: the tool-call block is created from the tool_use with the denied permission attached, so its state maps to error and permission carries {status: denied, decision, reason}.',
        messages: [
            wireMessage({
                id: 'msg-user-411',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Clean up the workspace.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-412',
                seq: 2,
                createdAt: T0 + 2_400,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '4d2e3f5a-9fb0-4bcc-8e3d-e6f7a8b9c412',
                            parentUuid: null,
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01PermDeny0001',
                                        name: 'Bash',
                                        input: { command: 'rm -rf /tmp/hapi-cache', description: 'Delete the cache directory' }
                                    }
                                ]
                            }
                        }
                    }
                }
            })
        ],
        agentState: {
            requests: {},
            completedRequests: {
                toolu_01PermDeny0001: {
                    tool: 'Bash',
                    arguments: { command: 'rm -rf /tmp/hapi-cache', description: 'Delete the cache directory' },
                    createdAt: T0 + 2_600,
                    completedAt: T0 + 9_100,
                    status: 'denied',
                    decision: 'denied',
                    reason: 'Do not delete the cache — inspect it instead.'
                }
            }
        }
    },
    {
        name: 'permission-canceled',
        description: 'Completed request canceled (request withdrawn/aborted before an answer): the tool-call block created from the tool_use maps to state error with permission {status: canceled} and no mode/decision/reason.',
        messages: [
            wireMessage({
                id: 'msg-user-421',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Write the migration file.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-422',
                seq: 2,
                createdAt: T0 + 1_900,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '5e3f4a6b-0ac1-4cdd-9f4e-f7a8b9c0d422',
                            parentUuid: null,
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01PermCancel001',
                                        name: 'Write',
                                        input: { file_path: '/repo/hub/migrations/0007_add_index.sql', content: 'CREATE INDEX idx_messages_seq ON messages(seq);' }
                                    }
                                ]
                            }
                        }
                    }
                }
            })
        ],
        agentState: {
            requests: {},
            completedRequests: {
                toolu_01PermCancel001: {
                    tool: 'Write',
                    arguments: { file_path: '/repo/hub/migrations/0007_add_index.sql', content: 'CREATE INDEX idx_messages_seq ON messages(seq);' },
                    createdAt: T0 + 2_100,
                    completedAt: T0 + 4_800,
                    status: 'canceled'
                }
            }
        }
    },
    {
        name: 'permission-ask-user-question-answered',
        description: 'AskUserQuestion completed with FLAT answers (Record<question-index, string[]>): the completed request attaches to the tool-call; permission.answers keeps the flat map verbatim and the tool_result completes the interactive card.',
        messages: [
            wireMessage({
                id: 'msg-user-431',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Set up persistence for the prototype.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-432',
                seq: 2,
                createdAt: T0 + 2_300,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: '6f4a5b7c-1bd2-4dee-8a5f-a8b9c0d1e432',
                            parentUuid: null,
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_01AskDbChoice01',
                                        name: 'AskUserQuestion',
                                        input: {
                                            questions: [
                                                {
                                                    question: 'Which database should the prototype use?',
                                                    header: 'Database',
                                                    options: [
                                                        { label: 'SQLite', description: 'Zero-config local file' },
                                                        { label: 'Postgres', description: 'Matches production' }
                                                    ],
                                                    multiSelect: false
                                                }
                                            ]
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-433',
                seq: 3,
                createdAt: T0 + 21_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: '7a5b6c8d-2ce3-4eff-9b6a-b9c0d1e2f433',
                            parentUuid: '6f4a5b7c-1bd2-4dee-8a5f-a8b9c0d1e432',
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_01AskDbChoice01',
                                        content: 'User selected "SQLite" for "Which database should the prototype use?"',
                                        is_error: false
                                    }
                                ]
                            }
                        }
                    }
                }
            })
        ],
        agentState: {
            requests: {},
            completedRequests: {
                toolu_01AskDbChoice01: {
                    tool: 'AskUserQuestion',
                    arguments: {
                        questions: [
                            {
                                question: 'Which database should the prototype use?',
                                header: 'Database',
                                options: [
                                    { label: 'SQLite', description: 'Zero-config local file' },
                                    { label: 'Postgres', description: 'Matches production' }
                                ],
                                multiSelect: false
                            }
                        ]
                    },
                    createdAt: T0 + 2_500,
                    completedAt: T0 + 20_400,
                    status: 'approved',
                    decision: 'approved',
                    answers: { '0': ['SQLite'] }
                }
            }
        }
    },
    {
        name: 'permission-request-user-input-answered',
        description: 'request_user_input (Pi, codex tool family) completed with NESTED answers (Record<questionId, {answers: string[]}>): the completed request attaches by callId; permission.answers keeps the nested map verbatim and the tool-call-result completes the card.',
        messages: [
            wireMessage({
                id: 'msg-user-441',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Deploy the latest build.' }
                }
            }),
            wireMessage({
                id: 'msg-agent-442',
                seq: 2,
                createdAt: T0 + 1_700,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId: 'rui-01J9ZC4QD2',
                            name: 'request_user_input',
                            input: {
                                questions: [
                                    {
                                        id: 'deploy_target',
                                        question: 'Which environment should I deploy to?',
                                        required: true,
                                        multiple: false,
                                        options: [
                                            { label: 'staging', description: 'Safe to test' },
                                            { label: 'production', description: 'Live traffic' }
                                        ]
                                    }
                                ]
                            },
                            id: '8b6c7d9e-3df4-4a0b-8c7b-c0d1e2f3a442'
                        }
                    }
                }
            }),
            wireMessage({
                id: 'msg-agent-443',
                seq: 3,
                createdAt: T0 + 16_800,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'rui-01J9ZC4QD2',
                            output: { answers: { deploy_target: { answers: ['staging'] } } },
                            is_error: false,
                            id: '9c7d8eaf-4ea5-4b1c-9d8c-d1e2f3a4b443'
                        }
                    }
                }
            })
        ],
        agentState: {
            requests: {},
            completedRequests: {
                'rui-01J9ZC4QD2': {
                    tool: 'request_user_input',
                    arguments: {
                        questions: [
                            {
                                id: 'deploy_target',
                                question: 'Which environment should I deploy to?',
                                required: true,
                                multiple: false,
                                options: [
                                    { label: 'staging', description: 'Safe to test' },
                                    { label: 'production', description: 'Live traffic' }
                                ]
                            }
                        ]
                    },
                    createdAt: T0 + 1_900,
                    completedAt: T0 + 16_200,
                    status: 'approved',
                    decision: 'approved',
                    answers: { deploy_target: { answers: ['staging'] } }
                }
            }
        }
    }
]
