import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { buildVisibleChatBlocks, getToolGroupActionKind, isEligibleForToolGrouping, isToolGroupBlock } from '@/chat/toolGroups'

function makeToolBlock(
    id: string,
    name: string,
    input: unknown = {},
    overrides: Partial<ToolCallBlock> = {}
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id,
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: null,
            permission: undefined,
        },
        children: [],
        ...overrides,
    }
}

function makeTextBlock(id: string, text = 'note'): ChatBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

function makeUserTextBlock(id: string, text = 'question'): ChatBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

describe('getToolGroupActionKind', () => {
    it('classifies common execution tools', () => {
        expect(getToolGroupActionKind(makeToolBlock('read-1', 'Read'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('grep-1', 'Grep'))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('bash-1', 'Bash'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('shell-1', 'run_shell_command'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('edit-1', 'Edit'))).toBe('mutation')
    })

    it('normalizes aliases used by non-Claude agents', () => {
        expect(getToolGroupActionKind(makeToolBlock('read-1', 'read_file'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('search-1', 'grep_search'))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('shell-1', 'Shell'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('edit-1', 'replace_file_content'))).toBe('mutation')
        expect(getToolGroupActionKind(makeToolBlock('web-1', 'FetchURL'))).toBe('web')
    })

    it('uses native kinds when an ACP agent exposes a title as the tool name', () => {
        const read = makeToolBlock('native-read', 'src/grok.ts')
        read.tool.nativeKind = 'read'
        const execute = makeToolBlock('native-execute', 'bun test grok')
        execute.tool.nativeKind = 'execute'
        const edit = makeToolBlock('native-edit', 'Writing to src/grok.ts')
        edit.tool.nativeKind = 'edit'

        expect(getToolGroupActionKind(read)).toBe('read')
        expect(getToolGroupActionKind(execute)).toBe('command')
        expect(getToolGroupActionKind(edit)).toBe('mutation')
    })

    it('classifies structured Codex exploration commands by their actions', () => {
        const read = makeToolBlock('codex-read', 'CodexBash', {
            command: 'cat package.json',
            command_actions: [{ type: 'read', command: 'cat package.json', name: 'package.json', path: '/repo/package.json' }]
        })
        const search = makeToolBlock('codex-search', 'CodexBash', {
            command: 'rg toolGroups web/src',
            command_actions: [{ type: 'search', command: 'rg toolGroups web/src', query: 'toolGroups', path: 'web/src' }]
        })
        const mixed = makeToolBlock('codex-mixed', 'CodexBash', {
            command: 'cat package.json && bun test',
            command_actions: [
                { type: 'read', command: 'cat package.json', name: 'package.json', path: '/repo/package.json' },
                { type: 'unknown', command: 'bun test' }
            ]
        })

        expect(getToolGroupActionKind(read)).toBe('read')
        expect(getToolGroupActionKind(search)).toBe('search')
        expect(getToolGroupActionKind(mixed)).toBe('command')
    })
})

describe('isEligibleForToolGrouping', () => {
    it('excludes interactive, subagent, and plan cards', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('read-1', 'Read'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('task-1', 'Task'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('plan-1', 'update_plan'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('ask-1', 'AskUserQuestion'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('perm-1', 'Bash', {}, {
            tool: {
                id: 'perm-1',
                name: 'Bash',
                state: 'pending',
                input: {},
                createdAt: 1,
                startedAt: null,
                completedAt: null,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'perm-1',
                    status: 'pending'
                }
            }
        }))).toBe(false)
    })

    it('excludes lowercase OpenCode plan and subagent aliases', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('task-1', 'task'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('task-2', 'task:explore'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('todo-1', 'todowrite'))).toBe(false)
    })

    it('keeps Antigravity lifecycle markers standalone', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('log-1', 'AgyTaskLog'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('task-1', 'AgyAsyncTask'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('error-1', 'AgyError'))).toBe(false)
    })

    it('keeps approved permissioned execution cards eligible while preserving denial reasons', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('approved-1', 'Bash', {}, {
            tool: {
                id: 'approved-1',
                name: 'Bash',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'approved-1',
                    status: 'approved'
                }
            }
        }))).toBe(true)

        expect(isEligibleForToolGrouping(makeToolBlock('denied-1', 'Edit', {}, {
            tool: {
                id: 'denied-1',
                name: 'Edit',
                state: 'error',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'denied-1',
                    status: 'denied',
                    reason: 'blocked'
                }
            }
        }))).toBe(false)
    })

    it('keeps Codex permission milestones standalone after completion', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('codex-perm-1', 'CodexPermission', {}, {
            tool: {
                id: 'codex-perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                permission: {
                    id: 'codex-perm-1',
                    status: 'approved'
                }
            }
        }))).toBe(false)
    })
})

describe('Codex activity headings', () => {
    it('associates only an immediately preceding reasoning heading', () => {
        const reasoning = makeToolBlock('reasoning-1', 'CodexReasoning', { title: 'Inspecting authentication' })
        const visible = buildVisibleChatBlocks([
            reasoning,
            makeToolBlock('read-1', 'Read', { file_path: 'auth.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'session.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(2)
        expect(isToolGroupBlock(visible[1])).toBe(true)
        expect(isToolGroupBlock(visible[1]) ? visible[1].activityTitle : null).toBe('Inspecting authentication')
    })

    it('does not carry a heading across a text boundary', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('reasoning-1', 'CodexReasoning', { title: 'Inspecting authentication' }),
            makeTextBlock('text-boundary'),
            makeToolBlock('read-1', 'Read', { file_path: 'auth.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'session.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        const group = visible.find(isToolGroupBlock)
        expect(group?.activityTitle).toBeNull()
    })
})

describe('buildVisibleChatBlocks', () => {
    it.each([
        ['canonical tools', [
            makeToolBlock('read-1', 'Read'),
            makeToolBlock('search-1', 'Grep'),
            makeToolBlock('command-1', 'Bash'),
            makeToolBlock('edit-1', 'Edit'),
        ]],
        ['lowercase and snake-case tools', [
            makeToolBlock('read-1', 'read_file'),
            makeToolBlock('search-1', 'grep_search'),
            makeToolBlock('command-1', 'bash'),
            makeToolBlock('edit-1', 'edit_file'),
            makeToolBlock('web-1', 'web_search'),
        ]],
        ['ACP title-as-name tools', (() => {
            const read = makeToolBlock('read-1', 'src/agent.ts')
            read.tool.nativeKind = 'read'
            const search = makeToolBlock('search-1', 'tool grouping')
            search.tool.nativeKind = 'search'
            const command = makeToolBlock('command-1', 'bun test')
            command.tool.nativeKind = 'execute'
            const edit = makeToolBlock('edit-1', 'Writing to src/agent.ts')
            edit.tool.nativeKind = 'edit'
            return [read, search, command, edit]
        })()],
    ])('keeps every %s card standalone in classified mode', (_label, tools) => {
        const visible = buildVisibleChatBlocks(tools, {
            hasMoreMessages: false,
            groupingMode: 'classified'
        })

        expect(visible).toEqual(tools)
        expect(visible.every((block) => !isToolGroupBlock(block))).toBe(true)
    })

    it('renders one or more structured Codex exploration commands as a collapsed exploration group', () => {
        const read = makeToolBlock('codex-read', 'CodexBash', {
            command: 'cat package.json',
            command_source: 'agent',
            command_actions: [{
                type: 'read',
                command: 'cat package.json',
                name: 'package.json',
                path: '/repo/package.json'
            }]
        })
        const search = makeToolBlock('codex-search', 'CodexBash', {
            command: 'rg nativeTitle web/src',
            command_source: 'agent',
            command_actions: [{
                type: 'search',
                command: 'rg nativeTitle web/src',
                query: 'nativeTitle',
                path: 'web/src'
            }]
        })

        const visible = buildVisibleChatBlocks([read, search], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) throw new Error('expected exploration group')
        expect(visible[0].presentationMode).toBe('codex-exploration')
        expect(visible[0].defaultOpen).toBe(false)
        expect(visible[0].tools.map((tool) => tool.id)).toEqual(['codex-read', 'codex-search'])
    })

    it('opens exploration groups when the collapse preference is disabled', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('codex-read', 'CodexBash', {
                command: 'cat package.json',
                command_actions: [{ type: 'read', command: 'cat package.json', name: 'package.json', path: '/repo/package.json' }]
            }),
            makeToolBlock('codex-search', 'CodexBash', {
                command: 'rg nativeTitle web/src',
                command_actions: [{ type: 'search', command: 'rg nativeTitle web/src', query: 'nativeTitle' }]
            })
        ], { hasMoreMessages: false, codexExplorationCollapsed: false })

        expect(isToolGroupBlock(visible[0]) && visible[0].defaultOpen).toBe(true)
    })

    it('keeps structured general Codex commands separate from exploration groups', () => {
        const read = makeToolBlock('codex-read', 'CodexBash', {
            command: 'cat package.json',
            command_actions: [{
                type: 'read',
                command: 'cat package.json',
                name: 'package.json',
                path: '/repo/package.json'
            }]
        })
        const test = makeToolBlock('codex-test', 'CodexBash', {
            command: 'bun test',
            command_actions: [{ type: 'unknown', command: 'bun test' }]
        })
        const nextRead = makeToolBlock('codex-read-2', 'CodexBash', {
            command: 'cat README.md',
            command_actions: [{
                type: 'read',
                command: 'cat README.md',
                name: 'README.md',
                path: '/repo/README.md'
            }]
        })

        const visible = buildVisibleChatBlocks([read, test, nextRead], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0]) && visible[0].presentationMode).toBe('codex-exploration')
        expect(visible[1]).toBe(test)
        expect(isToolGroupBlock(visible[2]) && visible[2].presentationMode).toBe('codex-exploration')
    })

    it('groups structured general Codex commands when grouped mode is selected', () => {
        const first = makeToolBlock('codex-test-1', 'CodexBash', {
            command: 'bun test',
            command_actions: [{ type: 'unknown', command: 'bun test' }]
        })
        const second = makeToolBlock('codex-test-2', 'CodexBash', {
            command: 'bun run typecheck',
            command_actions: [{ type: 'unknown', command: 'bun run typecheck' }]
        })

        const classified = buildVisibleChatBlocks([first, second], {
            hasMoreMessages: false,
            groupingMode: 'classified'
        })
        const grouped = buildVisibleChatBlocks([first, second], {
            hasMoreMessages: false,
            groupingMode: 'grouped'
        })

        expect(classified).toEqual([first, second])
        expect(grouped).toHaveLength(1)
        expect(isToolGroupBlock(grouped[0]) && grouped[0].presentationMode).toBe('default')
        expect(isToolGroupBlock(grouped[0]) && grouped[0].defaultOpen).toBe(false)
    })

    it('does not reuse grouped ids when switching to classified mode', () => {
        const firstRead = makeToolBlock('codex-read-1', 'CodexBash', {
            command: 'cat package.json',
            command_actions: [{
                type: 'read',
                command: 'cat package.json',
                name: 'package.json',
                path: '/repo/package.json'
            }]
        })
        const command = makeToolBlock('codex-test', 'CodexBash', {
            command: 'bun test',
            command_actions: [{ type: 'unknown', command: 'bun test' }]
        })
        const secondRead = makeToolBlock('codex-read-2', 'CodexBash', {
            command: 'cat README.md',
            command_actions: [{
                type: 'read',
                command: 'cat README.md',
                name: 'README.md',
                path: '/repo/README.md'
            }]
        })
        const blocks = [firstRead, command, secondRead]
        const grouped = buildVisibleChatBlocks(blocks, {
            hasMoreMessages: false,
            groupingMode: 'grouped'
        })
        const classified = buildVisibleChatBlocks(blocks, {
            hasMoreMessages: false,
            previousGroups: grouped.filter(isToolGroupBlock),
            previousGroupingMode: 'grouped',
            groupingMode: 'classified'
        })
        const classifiedGroups = classified.filter(isToolGroupBlock)

        expect(grouped.filter(isToolGroupBlock)).toHaveLength(1)
        expect(classifiedGroups).toHaveLength(2)
        expect(new Set(classifiedGroups.map((group) => group.id)).size).toBe(2)
        const groupedGroup = grouped.find(isToolGroupBlock)
        expect(groupedGroup).toBeDefined()
        expect(classifiedGroups.every((group) => group.id !== groupedGroup?.id)).toBe(true)
    })

    it('groups contiguous eligible root tool cards in grouped mode', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected tool group')
        }
        expect(visible[0].tools.map((tool) => tool.id)).toEqual(['read-1', 'bash-1', 'edit-1'])
        expect(visible[0].defaultOpen).toBe(false)
        expect(visible[0].summary.fileTargets).toEqual(['src/a.ts'])
        expect(visible[0].summary.commandTargets).toEqual(['bun test'])
    })

    it('keeps classified ordinary tools standalone across assistant text', () => {
        const blocks = [
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-1', 'located the issue'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ]
        const visible = buildVisibleChatBlocks(blocks, {
            hasMoreMessages: false,
            groupingMode: 'classified'
        })

        expect(visible).toEqual(blocks)
        expect(visible.every((block) => !isToolGroupBlock(block))).toBe(true)
    })

    it('keeps ordinary tools separated by assistant text in grouped mode', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'read_file', { path: 'src/a.ts' }),
            makeTextBlock('text-1', 'located the issue'),
            makeToolBlock('edit-1', 'edit_file', { path: 'src/a.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(3)
        expect(visible.map((block) => block.kind)).toEqual(['tool-call', 'agent-text', 'tool-call'])
    })

    it('keeps ordinary tools separated by standalone milestones in grouped mode', () => {
        const question = makeToolBlock('ask-1', 'request_user_input')
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            question,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(3)
        expect(visible.every((block) => !isToolGroupBlock(block))).toBe(true)
        expect(visible[1]).toBe(question)
    })

    it('does not group ordinary tools across user response boundaries', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeUserTextBlock('user-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(3)
        expect(visible.every((block) => !isToolGroupBlock(block))).toBe(true)
    })

    it('keeps single eligible tool cards standalone', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeTextBlock('text-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(visible.every((block) => !isToolGroupBlock(block))).toBe(true)
    })

    it('keeps interactive cards standalone and preserves grouped tool order', () => {
        const interactive = makeToolBlock('ask-1', 'request_user_input')
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            interactive,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(isToolGroupBlock(visible[0]) ? visible[0].tools.map((tool) => tool.id) : []).toEqual([
            'read-1',
            'bash-1'
        ])
        expect(visible[1]).toBe(interactive)
        expect(isToolGroupBlock(visible[2])).toBe(true)
        expect(isToolGroupBlock(visible[2]) ? visible[2].tools.map((tool) => tool.id) : []).toEqual([
            'edit-1',
            'write-1'
        ])
    })

    it('keeps completed Codex permission cards standalone in grouped mode', () => {
        const permission = makeToolBlock('perm-1', 'CodexPermission', { tool: 'shell_command' }, {
            tool: {
                id: 'perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                result: 'Approved',
                permission: {
                    id: 'perm-1',
                    status: 'approved',
                    decision: 'approved'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            permission,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(isToolGroupBlock(visible[0]) ? visible[0].tools.map((tool) => tool.id) : []).toEqual([
            'read-1',
            'bash-1'
        ])
        expect(visible[1]).toBe(permission)
        expect(isToolGroupBlock(visible[2])).toBe(true)
        expect(isToolGroupBlock(visible[2]) ? visible[2].tools.map((tool) => tool.id) : []).toEqual([
            'edit-1',
            'write-1'
        ])
    })

    it('keeps terminal permission reasons visible in grouped mode', () => {
        const denied = makeToolBlock('denied-1', 'Bash', { command: 'rm -rf build' }, {
            tool: {
                id: 'denied-1',
                name: 'Bash',
                state: 'completed',
                input: { command: 'rm -rf build' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                result: 'Denied',
                permission: {
                    id: 'denied-1',
                    status: 'denied',
                    reason: 'Command rejected by policy'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            denied,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('edit-2', 'Edit', { file_path: 'src/b.ts' })
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(denied)
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('marks only the oldest visible grouped run as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeUserTextBlock('user-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true, groupingMode: 'grouped' })

        expect(isToolGroupBlock(visible[0]) && visible[0].needsOlderHistory).toBe(true)
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after leading non-tool blocks as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeTextBlock('text-1', 'prepended assistant note'),
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true, groupingMode: 'grouped' })

        expect(visible[0].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after a leading standalone tool as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('single-1', 'Read', { file_path: 'src/solo.ts' }),
            makeUserTextBlock('user-1', 'boundary'),
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true, groupingMode: 'grouped' })

        expect(visible[0].kind).toBe('tool-call')
        expect(visible[1].kind).toBe('user-text')
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after a standalone permission boundary as needing older history', () => {
        const permission = makeToolBlock('perm-1', 'CodexPermission', { tool: 'shell_command' }, {
            tool: {
                id: 'perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                result: 'Approved',
                permission: {
                    id: 'perm-1',
                    status: 'approved'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            permission,
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true, groupingMode: 'grouped' })

        expect(visible[0]).toBe(permission)
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
    })

    it('reuses a previous group id when the first tool changes after prepend', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true, groupingMode: 'grouped' })

        const next = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], {
            hasMoreMessages: false,
            groupingMode: 'grouped',
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })

    it('reuses a previous group id when the last tool changes after append', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: false, groupingMode: 'grouped' })

        const next = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], {
            hasMoreMessages: false,
            groupingMode: 'grouped',
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })
})
