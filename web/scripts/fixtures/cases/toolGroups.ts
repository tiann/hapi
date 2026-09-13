import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

function claudeToolUse(init: {
    messageId: string
    seq: number
    createdAt: number
    uuid: string
    parentUuid: string | null
    toolUseId: string
    name: string
    input: Record<string, unknown>
}): ReturnType<typeof wireMessage> {
    return wireMessage({
        id: init.messageId,
        seq: init.seq,
        createdAt: init.createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: init.uuid,
                    parentUuid: init.parentUuid,
                    message: {
                        role: 'assistant',
                        model: 'claude-opus-4-1-20250805',
                        content: [{ type: 'tool_use', id: init.toolUseId, name: init.name, input: init.input }]
                    }
                }
            }
        }
    })
}

function claudeToolResult(init: {
    messageId: string
    seq: number
    createdAt: number
    uuid: string
    parentUuid: string
    toolUseId: string
    content: string
}): ReturnType<typeof wireMessage> {
    return wireMessage({
        id: init.messageId,
        seq: init.seq,
        createdAt: init.createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: init.uuid,
                    parentUuid: init.parentUuid,
                    message: {
                        role: 'user',
                        content: [
                            { type: 'tool_result', tool_use_id: init.toolUseId, content: init.content, is_error: false }
                        ]
                    }
                }
            }
        }
    })
}

/**
 * Consecutive groupable tool calls (read/search family) collapse into a
 * tool-group in visibleBlocks; the pre-grouping `blocks` keep the individual
 * tool-call blocks.
 */
export const toolGroupCases: FixtureCase[] = [
    {
        name: 'tool-group-codex-shared-commands',
        description: 'Shared Codex unknown/mixed command actions select the default group, not a grouping boundary. Keep commands, patches and legacy hook calls together, preserve live/error state, and keep exploration groups separate.',
        messages: [
            { type: 'tool-call', name: 'CodexBash', callId: 'explore-before', input: {
                command: 'cat README.md', command_source: 'agent',
                command_actions: [{ type: 'read', command: 'cat README.md', name: 'README.md', path: '/repo/README.md' }]
            } },
            { type: 'tool-call-result', callId: 'explore-before', output: 'Readme' },
            { type: 'tool-call', name: 'CodexBash', callId: 'shared-command', input: {
                type: 'exec_command_begin', call_id: 'shared-command', cwd: '/repo',
                command: '/bin/zsh -lc "git diff --stat"', command_source: 'unifiedExecStartup',
                command_actions: [{ type: 'unknown', command: 'git diff --stat' }]
            } },
            { type: 'tool-call-result', callId: 'shared-command', output: { stdout: '1 file changed', exit_code: 0 } },
            { type: 'tool-call', name: 'CodexPatch', callId: 'patch', input: {
                changes: { '/repo/main.ts': { type: 'update', unified_diff: '-old\n+new' } }
            } },
            { type: 'tool-call-result', callId: 'patch', output: { success: true } },
            { type: 'tool-call', name: 'CodexBash', callId: 'mixed-command', input: {
                command: 'cat package.json && bun test', commandSource: 'unifiedExecStartup',
                commandActions: [
                    { type: 'read', command: 'cat package.json', name: 'package.json', path: '/repo/package.json' },
                    { type: 'unknown', command: 'bun test' }
                ]
            } },
            { type: 'tool-call-result', callId: 'mixed-command', output: { stdout: 'Test failed', exit_code: 1 }, is_error: true },
            { type: 'tool-call', name: 'CodexBash', callId: 'legacy-command', input: { command: 'git status', source: 'codex-hook' } },
            { type: 'tool-call', name: 'CodexBash', callId: 'explore-after', input: {
                command: 'ls src', command_actions: [{ type: 'listFiles', command: 'ls src', path: '/repo/src' }]
            } },
            { type: 'tool-call-result', callId: 'explore-after', output: 'main.ts' }
        ].map((data, index) => wireMessage({
            id: `shared-group-${index}`, seq: index + 1, createdAt: T0 + index * 1000,
            content: { role: 'agent', content: { type: 'codex', data } }
        }))
    },
    {
        name: 'tool-group-codex-user-shell-boundaries',
        description: 'User shell remains standalone with unknown, exploration or absent command actions (including camelCase aliases); ordinary agent tools on either side cannot merge across it.',
        messages: [
            { type: 'tool-call', name: 'CodexBash', callId: 'agent-before', input: {
                command: 'bun test', command_actions: [{ type: 'unknown', command: 'bun test' }]
            } },
            { type: 'tool-call', name: 'CodexPatch', callId: 'patch-before', input: { changes: {} } },
            { type: 'tool-call', name: 'CodexBash', callId: 'user-unknown', input: {
                command: 'git status', command_source: 'userShell',
                command_actions: [{ type: 'unknown', command: 'git status' }]
            } },
            { type: 'tool-call', name: 'CodexBash', callId: 'user-read', input: {
                command: 'cat README.md', commandSource: 'userShell',
                commandActions: [{ type: 'read', command: 'cat README.md', name: 'README.md', path: '/repo/README.md' }]
            } },
            { type: 'tool-call', name: 'CodexBash', callId: 'user-unclassified', input: {
                command: 'pwd', command_source: 'userShell'
            } },
            { type: 'tool-call', name: 'CodexBash', callId: 'agent-after', input: {
                command: 'bun test', command_actions: [{ type: 'unknown', command: 'bun test' }]
            } },
            { type: 'tool-call', name: 'CodexPatch', callId: 'patch-after', input: { changes: {} } }
        ].flatMap((data) => [data, { type: 'tool-call-result', callId: data.callId, output: 'Done' }])
            .map((data, index) => wireMessage({
                id: `shell-boundary-${index}`, seq: index + 1, createdAt: T0 + index * 1000,
                content: { role: 'agent', content: { type: 'codex', data } }
            }))
    },
    {
        name: 'tool-group-consecutive-reads',
        description: 'Three consecutive groupable tool calls (Read, Grep, Glob) collapse into one tool-group in visibleBlocks (membership + order + boundary ids), while blocks keeps three individual tool-call blocks.',
        messages: [
            wireMessage({
                id: 'msg-user-131',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Find where the session store lives.' }
                }
            }),
            claudeToolUse({
                messageId: 'msg-agent-132',
                seq: 2,
                createdAt: T0 + 2_000,
                uuid: 'c3e0a571-4d8f-4b92-9e3a-f0b4c6d2e132',
                parentUuid: null,
                toolUseId: 'toolu_01GrpRead0001',
                name: 'Read',
                input: { file_path: '/repo/hub/src/store/index.ts' }
            }),
            claudeToolResult({
                messageId: 'msg-agent-133',
                seq: 3,
                createdAt: T0 + 2_600,
                uuid: 'd4f1b682-5e9a-4ca3-8f4b-a1c5d7e3f133',
                parentUuid: 'c3e0a571-4d8f-4b92-9e3a-f0b4c6d2e132',
                toolUseId: 'toolu_01GrpRead0001',
                content: 'export * from "./sessionStore"\nexport * from "./contentCodec"'
            }),
            claudeToolUse({
                messageId: 'msg-agent-134',
                seq: 4,
                createdAt: T0 + 3_400,
                uuid: 'e5a2c793-6f0b-4db4-9a5c-b2d6e8f4a134',
                parentUuid: 'd4f1b682-5e9a-4ca3-8f4b-a1c5d7e3f133',
                toolUseId: 'toolu_01GrpGrep0002',
                name: 'Grep',
                input: { pattern: 'class SessionStore', path: '/repo/hub/src' }
            }),
            claudeToolResult({
                messageId: 'msg-agent-135',
                seq: 5,
                createdAt: T0 + 4_000,
                uuid: 'f6b3d804-7a1c-4ec5-8b6d-c3e7f9a5b135',
                parentUuid: 'e5a2c793-6f0b-4db4-9a5c-b2d6e8f4a134',
                toolUseId: 'toolu_01GrpGrep0002',
                content: 'hub/src/store/sessionStore.ts:42:export class SessionStore {'
            }),
            claudeToolUse({
                messageId: 'msg-agent-136',
                seq: 6,
                createdAt: T0 + 4_700,
                uuid: 'a7c4e915-8b2d-4fd6-9c7e-d4f8a0b6c136',
                parentUuid: 'f6b3d804-7a1c-4ec5-8b6d-c3e7f9a5b135',
                toolUseId: 'toolu_01GrpGlob0003',
                name: 'Glob',
                input: { pattern: 'hub/src/store/**/*.test.ts' }
            }),
            claudeToolResult({
                messageId: 'msg-agent-137',
                seq: 7,
                createdAt: T0 + 5_200,
                uuid: 'b8d5f026-9c3e-4ae7-8d8f-e5a9b1c7d137',
                parentUuid: 'a7c4e915-8b2d-4fd6-9c7e-d4f8a0b6c136',
                toolUseId: 'toolu_01GrpGlob0003',
                content: 'hub/src/store/sessionStore.test.ts\nhub/src/store/contentCodec.test.ts'
            }),
            wireMessage({
                id: 'msg-agent-138',
                seq: 8,
                createdAt: T0 + 6_500,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'c9e6a137-0d4f-4bf8-9e9a-f6b0c2d8e138',
                            parentUuid: 'b8d5f026-9c3e-4ae7-8d8f-e5a9b1c7d137',
                            message: {
                                role: 'assistant',
                                model: 'claude-opus-4-1-20250805',
                                content: [
                                    { type: 'text', text: 'The session store is hub/src/store/sessionStore.ts, with tests alongside it.' }
                                ]
                            }
                        }
                    }
                }
            })
        ]
    }
]
