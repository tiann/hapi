import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import type { SessionSummary } from '@/types/api'
import { buildSessionStatusData } from './sessionStatus'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        ...overrides,
    }
}

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

    it('does not attach a linkedSessionId from bare UUIDs in failed spawn_peer error output', () => {
        const blocks: ChatBlock[] = [
            toolBlock({
                id: 'block-peer-failed',
                name: 'mcp__hapi__spawn_peer',
                tool: {
                    id: 'call-peer-failed',
                    state: 'error',
                    input: { name: 'Bad machine peer', directory: '/work/app' },
                    result: 'Failed to spawn peer: no hub machine matched machine=44444444-4444-4444-8444-444444444444'
                }
            })
        ]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks })?.subagents).toEqual([
            expect.objectContaining({
                id: 'call-peer-failed',
                blockId: 'block-peer-failed',
                state: 'error',
                linkedSessionId: null,
            })
        ])
    })

    it('keeps a completed spawn_peer block visible as error when its MCP result carries an error envelope', () => {
        const blocks: ChatBlock[] = [
            toolBlock({
                id: 'block-codex-peer-failed',
                name: 'mcp__hapi__spawn_peer',
                createdAt: 1000,
                tool: {
                    id: 'call-codex-peer-failed',
                    state: 'completed',
                    startedAt: 1000,
                    completedAt: 1500,
                    input: { name: 'Codex worker', directory: '/work/app' },
                    result: {
                        isError: true,
                        content: [{ type: 'text', text: 'Failed to spawn peer: directory does not exist' }],
                    },
                }
            }),
            toolBlock({
                id: 'block-codex-peer-ok',
                name: 'mcp__hapi__spawn_peer',
                createdAt: 2000,
                tool: {
                    id: 'call-codex-peer-ok',
                    state: 'completed',
                    startedAt: 2000,
                    completedAt: 2500,
                    input: { name: 'Healthy worker', directory: '/work/app' },
                    result: {
                        isError: false,
                        content: [{ type: 'text', text: 'Spawned 55555555-5555-4555-8555-555555555555 (Healthy worker)' }],
                    },
                }
            }),
        ]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks })?.subagents).toEqual([
            expect.objectContaining({
                id: 'call-codex-peer-failed',
                blockId: 'block-codex-peer-failed',
                title: 'Codex worker',
                detail: '/work/app',
                state: 'error',
                startedAt: 1000,
                endedAt: 1500,
                linkedSessionId: null,
            })
        ])
    })

    it('lists a linked child with only derived tool work as running', () => {
        const child = makeSummary({
            id: 'child',
            active: true,
            derivedToolWork: true,
            metadata: { path: '/work/app', parentLink: { parentSessionId: 'parent', kind: 'peer' } },
        })
        const status = buildSessionStatusData({
            sessionId: 'parent', goal: null, tasks: [], blocks: [], linkedSessions: [child],
        })

        expect(status?.subagents).toMatchObject([{ linkedSessionId: child.id, state: 'running' }])
    })

    it('merges linked child sessions into subagents and deduplicates active tool blocks', () => {
        const blocks: ChatBlock[] = [
            toolBlock({
                id: 'block-spawn-live',
                name: 'mcp__hapi__spawn_peer',
                tool: {
                    id: 'call-spawn-live',
                    state: 'running',
                    input: { directory: '/work/app', name: 'Live Peer' },
                    result: 'Spawned child-live (Live Peer)',
                }
            })
        ]

        const linkedSessions: SessionSummary[] = [
            makeSummary({
                id: 'parent-1',
                active: true,
                metadata: { path: '/work/app', name: 'Parent' },
            }),
            makeSummary({
                id: 'child-live',
                active: true,
                thinking: true,
                updatedAt: 200,
                metadata: {
                    path: '/work/app',
                    name: 'Live Peer',
                    flavor: 'codex',
                    parentLink: { parentSessionId: 'parent-1', kind: 'peer' },
                },
            }),
            makeSummary({
                id: 'child-done',
                active: false,
                updatedAt: 300,
                metadata: {
                    path: '/work/app',
                    name: 'Finished Fork',
                    flavor: 'claude',
                    parentLink: { parentSessionId: 'parent-1', kind: 'fork' },
                },
            }),
            makeSummary({
                id: 'child-running-extra',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: {
                    path: '/work/app',
                    name: 'Extra Worker',
                    flavor: 'agy',
                    parentLink: { parentSessionId: 'parent-1', kind: 'peer' },
                },
            }),
        ]

        const status = buildSessionStatusData({
            sessionId: 'parent-1',
            goal: null,
            tasks: [],
            blocks,
            linkedSessions,
        })

        expect(status?.subagents).toEqual([
            expect.objectContaining({
                id: 'call-spawn-live',
                blockId: 'block-spawn-live',
                linkedSessionId: 'child-live',
                linkKind: 'peer',
                state: 'running',
            }),
            expect.objectContaining({
                id: 'session:child-running-extra',
                blockId: null,
                title: 'Extra Worker',
                detail: 'agy',
                state: 'running',
                linkedSessionId: 'child-running-extra',
                linkKind: 'peer',
            }),
            expect.objectContaining({
                id: 'session:child-done',
                blockId: null,
                title: 'Finished Fork',
                detail: 'claude',
                state: 'idle',
                linkedSessionId: 'child-done',
                linkKind: 'fork',
            }),
        ])
    })

    it('reconciles deduplicated peer subagents with live waiting, background, and error child states', () => {
        const blocks: ChatBlock[] = [
            toolBlock({
                id: 'block-wait-peer',
                name: 'mcp__hapi__spawn_peer',
                tool: {
                    id: 'call-wait-peer',
                    state: 'running',
                    input: { directory: '/work/app', name: 'Waiting Peer' },
                    result: 'Spawned child-wait (Waiting Peer)',
                }
            }),
            toolBlock({
                id: 'block-err-peer',
                name: 'mcp__hapi__spawn_peer',
                tool: {
                    id: 'call-err-peer',
                    state: 'running',
                    input: { directory: '/work/app', name: 'Error Peer' },
                    result: 'Spawned child-err (Error Peer)',
                }
            }),
        ]

        const linkedSessions: SessionSummary[] = [
            makeSummary({
                id: 'child-wait',
                active: true,
                thinking: false,
                pendingRequestsCount: 1,
                metadata: {
                    path: '/work/app',
                    name: 'Waiting Peer',
                    parentLink: { parentSessionId: 'parent-2', kind: 'peer' },
                },
            }),
            makeSummary({
                id: 'child-err',
                active: true,
                thinking: false,
                metadata: {
                    path: '/work/app',
                    name: 'Error Peer',
                    parentLink: { parentSessionId: 'parent-2', kind: 'peer' },
                    lastModelError: {
                        eventId: 'err-2',
                        kind: 'rate_limit',
                        transient: true,
                        rawSnippet: '429',
                        atTs: 500,
                        priorAssistantClaimsDone: false,
                    },
                },
            }),
            makeSummary({
                id: 'child-bg-only',
                active: true,
                thinking: false,
                backgroundTaskCount: 1,
                updatedAt: 400,
                metadata: {
                    path: '/work/app',
                    name: 'Background Only Worker',
                    flavor: 'codex',
                    parentLink: { parentSessionId: 'parent-2', kind: 'peer' },
                },
            }),
        ]

        const status = buildSessionStatusData({
            sessionId: 'parent-2',
            goal: null,
            tasks: [],
            blocks,
            linkedSessions,
        })

        expect(status?.subagents).toEqual([
            expect.objectContaining({
                id: 'call-wait-peer',
                linkedSessionId: 'child-wait',
                state: 'waiting',
            }),
            expect.objectContaining({
                id: 'call-err-peer',
                linkedSessionId: 'child-err',
                state: 'error',
            }),
            expect.objectContaining({
                id: 'session:child-bg-only',
                linkedSessionId: 'child-bg-only',
                state: 'running',
            }),
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
