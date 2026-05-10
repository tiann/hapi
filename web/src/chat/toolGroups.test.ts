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

describe('getToolGroupActionKind', () => {
    it('classifies common execution tools', () => {
        expect(getToolGroupActionKind(makeToolBlock('read-1', 'Read'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('grep-1', 'Grep'))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('bash-1', 'Bash'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('edit-1', 'Edit'))).toBe('mutation')
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
                description: null,
                permission: {
                    id: 'perm-1',
                    status: 'pending'
                }
            }
        }))).toBe(false)
    })

    it('keeps completed permissioned execution cards eligible for grouping', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('approved-1', 'Bash', {}, {
            tool: {
                id: 'approved-1',
                name: 'Bash',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
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
                description: null,
                permission: {
                    id: 'denied-1',
                    status: 'denied',
                    reason: 'blocked'
                }
            }
        }))).toBe(true)
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
                description: null,
                permission: {
                    id: 'codex-perm-1',
                    status: 'approved'
                }
            }
        }))).toBe(false)
    })
})

describe('buildVisibleChatBlocks', () => {
    it('groups contiguous eligible root tool cards', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false })

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

    it('splits groups on assistant text boundaries', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-1', 'located the issue'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2])).toBe(true)
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

    it('keeps interactive cards standalone and uses them as hard boundaries', () => {
        const interactive = makeToolBlock('ask-1', 'request_user_input')
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            interactive,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(interactive)
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('keeps completed Codex permission cards as standalone grouping boundaries', () => {
        const permission = makeToolBlock('perm-1', 'CodexPermission', { tool: 'shell_command' }, {
            tool: {
                id: 'perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
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
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(permission)
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('marks only the oldest visible grouped run as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true })

        expect(isToolGroupBlock(visible[0]) && visible[0].needsOlderHistory).toBe(true)
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after leading non-tool blocks as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeTextBlock('text-1', 'prepended assistant note'),
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-2', 'next section'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true })

        expect(visible[0].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
        expect(isToolGroupBlock(visible[3]) && visible[3].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after a leading standalone tool as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('single-1', 'Read', { file_path: 'src/solo.ts' }),
            makeTextBlock('text-1', 'boundary'),
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        expect(visible[0].kind).toBe('tool-call')
        expect(visible[1].kind).toBe('agent-text')
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
        ], { hasMoreMessages: true })

        expect(visible[0]).toBe(permission)
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
    })

    it('reuses a previous group id when the first tool changes after prepend', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        const next = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })

    it('reuses a previous group id when the last tool changes after append', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: false })

        const next = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })
})
