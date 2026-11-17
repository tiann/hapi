import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
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

describe('buildSessionStatusData', () => {
    it('returns null when the session has no hidden status', () => {
        expect(buildSessionStatusData({ goal: null, tasks: [], blocks: [] })).toBeNull()
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

        expect(buildSessionStatusData({ goal, tasks, blocks: [] })).toMatchObject({ goal, tasks })
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

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks })?.subagents).toEqual([
            expect.objectContaining({ id: 'agent-1', blockId: 'block-CodexAgent', title: 'Inspect API', detail: 'Reading files', state: 'running', endedAt: null }),
            expect.objectContaining({ id: 'agent-2', blockId: 'block-Agent', title: 'Review changes', state: 'error', endedAt: 100 }),
            expect.objectContaining({ id: 'agent-pending', blockId: 'block-Agent', state: 'waiting', startedAt: null }),
            expect.objectContaining({ id: 'agent-4', blockId: 'block-Agent', title: 'Nested work', state: 'running' })
        ])
    })

    it('tracks running or failed spawn_peer calls with linkedSessionId when available', () => {
        const blocks: ChatBlock[] = [
            toolBlock({
                id: 'block-peer-running',
                name: 'mcp__hapi__spawn_peer',
                tool: {
                    id: 'call-peer-1',
                    state: 'running',
                    input: { name: 'Build peer', directory: '/work/app' },
                }
            }),
            toolBlock({
                id: 'block-peer-done',
                name: 'mcp__hapi__spawn_peer',
                tool: {
                    id: 'call-peer-2',
                    state: 'completed',
                    input: { name: 'Done peer', directory: '/work/app' },
                    result: 'Spawned 44444444-4444-4444-8444-444444444444 (Done peer)'
                }
            })
        ]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks })?.subagents).toEqual([
            expect.objectContaining({
                id: 'call-peer-1',
                blockId: 'block-peer-running',
                title: 'Build peer',
                detail: '/work/app',
                state: 'running'
            })
        ])
    })

    it('tracks active codeagent-wrapper Bash invocations under subagents without duplicating terminals', () => {
        const blocks: ChatBlock[] = [
            toolBlock({
                id: 'block-wrapper-running',
                name: 'Bash',
                tool: {
                    id: 'call-wrapper-1',
                    state: 'running',
                    input: {
                        command: '~/.claude/bin/codeagent-wrapper --backend codex - "/work/app" <<\'EOF\'\nROLE_FILE: ~/.claude/.ccg/prompts/codex/reviewer.md\nReview diff\nEOF',
                        description: 'Codex security review',
                    },
                    result: 'Command running in background with ID: bg-wrapper',
                }
            })
        ]

        const status = buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks,
            backgroundTasks: [
                { id: 'bg-wrapper', type: 'local_bash', description: 'Codex security review' },
                { id: 'bg-shell', type: 'local_bash', description: 'Run dev server' },
            ]
        })

        expect(status?.subagents).toEqual([
            expect.objectContaining({
                id: 'call-wrapper-1',
                blockId: 'block-wrapper-running',
                title: 'codex · reviewer',
                detail: 'Codex security review',
                state: 'running',
            })
        ])
        expect(status?.terminals).toEqual([
            { id: 'bg-shell', command: 'Run dev server', cwd: null, startedAt: null }
        ])
    })

    it('lists Claude background tasks with the command that started them', () => {
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
                        id: 'bash-ls',
                        state: 'completed',
                        input: { command: 'ls tasks' },
                        result: 'bg-2.output\nbg-3.output'
                    }
                }),
                toolBlock({
                    name: 'Bash',
                    tool: {
                        id: 'bash-2',
                        state: 'completed',
                        input: { command: 'bun test --watch' },
                        result: [{ type: 'text', text: 'Command was moved to the background (ID: bg-2).' }]
                    }
                })
            ]
        })]

        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks,
            backgroundTasks: [
                { id: 'bg-2', type: 'local_bash', description: 'Watch tests' },
                { id: 'bg-3', type: 'local_bash', description: 'Start server' },
                { id: 'm-1', type: 'monitor_mcp', description: 'Watch deploy' }
            ]
        })?.terminals).toEqual([
            { id: 'bg-2', command: 'bun test --watch', cwd: null, startedAt: 100 },
            { id: 'bg-3', command: 'Start server', cwd: null, startedAt: null },
            { id: 'm-1', command: 'Watch deploy', cwd: null, startedAt: null }
        ])
        expect(buildSessionStatusData({ goal: null, tasks: [], blocks, backgroundTasks: [] })).toBeNull()
    })
})
