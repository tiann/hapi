import { describe, expect, it } from 'vitest'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { buildSessionStatusData } from './sessionStatus'

function toolBlock(overrides: Omit<Partial<ToolCallBlock>, 'tool'> & {
    name: string
    tool?: Partial<ToolCallBlock['tool']>
}): ToolCallBlock {
    const { name, tool, ...blockOverrides } = overrides
    return {
        kind: 'tool-call',
        id: overrides.id ?? `block-${name}`,
        localId: null,
        createdAt: overrides.createdAt ?? 100,
        children: overrides.children ?? [],
        tool: {
            id: tool?.id ?? `tool-${name}`,
            name,
            state: tool?.state ?? 'running',
            input: tool?.input ?? {},
            createdAt: overrides.createdAt ?? 100,
            startedAt: tool?.startedAt ?? null,
            completedAt: tool?.completedAt ?? null,
            execStartedAt: null,
            execCompletedAt: null,
            description: tool?.description ?? null,
            result: tool?.result
        },
        ...blockOverrides
    }
}

function taskNotification(taskId?: string): NormalizedMessage {
    return {
        id: `notification-${taskId ?? 'anonymous'}`,
        localId: null,
        createdAt: 200,
        role: 'agent',
        isSidechain: true,
        content: [{
            type: 'sidechain',
            uuid: 'notification',
            parentUUID: null,
            prompt: `<task-notification>${taskId ? `<task-id>${taskId}</task-id>` : ''}<summary>Done</summary></task-notification>`
        }]
    }
}

describe('buildSessionStatusData', () => {
    it('returns null when the session has no hidden status', () => {
        expect(buildSessionStatusData({ goal: null, tasks: [], blocks: [], messages: [] })).toBeNull()
    })

    it('keeps goal and ordered task snapshots', () => {
        const goal = {
            threadId: 'thread-1',
            objective: 'Ship status panel',
            status: 'active' as const,
            tokenBudget: 50_000,
            tokensUsed: 10_000,
            timeUsedSeconds: 120,
            createdAt: 1,
            updatedAt: 2
        }
        const tasks = [
            { id: '1', content: 'Research', priority: 'medium' as const, status: 'completed' as const },
            { id: '2', content: 'Implement', priority: 'high' as const, status: 'in_progress' as const }
        ]

        expect(buildSessionStatusData({ goal, tasks, blocks: [], messages: [] })).toMatchObject({ goal, tasks })
    })

    it('lists only active or failed subagents', () => {
        const blocks: ChatBlock[] = [
            toolBlock({ name: 'CodexAgent', tool: { id: 'agent-1', state: 'running', input: { summary: 'Inspect API', activity: 'Reading files' } } }),
            toolBlock({ name: 'Agent', tool: { id: 'agent-2', state: 'error', input: { description: 'Review changes' } } }),
            toolBlock({ name: 'Agent', tool: { id: 'agent-pending', state: 'pending', input: { description: 'Needs permission' } } }),
            toolBlock({
                name: 'Task',
                tool: { id: 'agent-3', state: 'completed', input: { description: 'Done' } },
                children: [
                    toolBlock({ name: 'Agent', tool: { id: 'agent-4', input: { description: 'Nested work' } } })
                ]
            })
        ]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks, messages: [] })?.subagents).toEqual([
            expect.objectContaining({ id: 'agent-1', title: 'Inspect API', detail: 'Reading files', state: 'running', endedAt: null }),
            expect.objectContaining({ id: 'agent-2', title: 'Review changes', state: 'error', endedAt: 100 }),
            expect.objectContaining({ id: 'agent-pending', state: 'waiting', startedAt: null }),
            expect.objectContaining({ id: 'agent-4', title: 'Nested work', state: 'running' })
        ])
    })

    it('tracks Claude background terminals until their task notification arrives', () => {
        const blocks: ChatBlock[] = [toolBlock({
            name: 'Agent',
            tool: { state: 'completed' },
            children: [
                toolBlock({
                    name: 'Bash',
                    tool: {
                        id: 'bash-1',
                        state: 'completed',
                        input: { command: 'bun run dev', cwd: '/repo/web' },
                        result: 'Command running in background with ID: bg-1',
                        startedAt: 123
                    }
                }),
                toolBlock({
                    name: 'Bash',
                    tool: {
                        id: 'bash-2',
                        state: 'completed',
                        input: { command: 'bun test --watch' },
                        result: [{ type: 'text', text: 'Command running in background with ID: bg-2' }]
                    }
                }),
                toolBlock({
                    name: 'Read',
                    tool: { result: 'Command running in background with ID: not-a-terminal' }
                })
            ]
        })]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks, messages: [taskNotification('bg-1')] })?.terminals).toEqual([
            { id: 'bg-2', command: 'bun test --watch', cwd: null, startedAt: 100 }
        ])
        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks,
            messages: [],
            backgroundTaskCount: 0
        })).toBeNull()
        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks: [],
            messages: [],
            backgroundTaskCount: 2
        })).toMatchObject({ terminals: [], undiscoveredTerminalCount: 2 })
        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks,
            messages: [taskNotification()],
            backgroundTaskCount: 1
        })).toMatchObject({
            terminals: [],
            undiscoveredTerminalCount: 1,
            possibleTerminalCommands: ['bun run dev', 'bun test --watch']
        })
    })
})
