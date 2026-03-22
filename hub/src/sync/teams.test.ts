import { describe, test, expect } from 'bun:test'
import { applyTeamStateDelta, extractTeamStateFromMessageContent } from './teams'
import type { TeamState, TeamTask } from '@hapi/protocol/types'

const baseTeamState: TeamState = {
    teamName: 'test-team',
    members: [{ name: 'lead', status: 'active' }],
    tasks: [],
    messages: [],
    updatedAt: 1000
}

function getTasks(result: TeamState | null | undefined): TeamTask[] {
    expect(result).toBeTruthy()
    return result!.tasks ?? []
}

// Helper to create a message content envelope with tool_use blocks
function makeToolCallMessage(tools: Array<{ name: string; input: Record<string, unknown> }>) {
    return {
        role: 'assistant',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    content: tools.map((t, i) => ({
                        type: 'tool_use',
                        id: `tool_${i}`,
                        name: t.name,
                        input: t.input
                    }))
                }
            }
        }
    }
}

describe('applyTeamStateDelta - orphan TaskUpdate', () => {
    test('should skip inserting task without title (orphan TaskUpdate)', () => {
        const result = applyTeamStateDelta(baseTeamState, {
            tasks: [{ id: 'task-1', status: 'in_progress' } as any],
            updatedAt: 2000
        })

        expect(getTasks(result)).toEqual([])
    })

    test('should insert task when title is present (normal TaskCreate)', () => {
        const result = applyTeamStateDelta(baseTeamState, {
            tasks: [{ id: 'task-1', title: 'Do something', status: 'pending' }],
            updatedAt: 2000
        })

        const tasks = getTasks(result)
        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({ title: 'Do something' })
    })

    test('should update existing task even without title (normal TaskUpdate)', () => {
        const stateWithTask: TeamState = {
            ...baseTeamState,
            tasks: [{ id: 'task-1', title: 'Do something', status: 'pending' }]
        }

        const result = applyTeamStateDelta(stateWithTask, {
            tasks: [{ id: 'task-1', status: 'completed' } as any],
            updatedAt: 2000
        })

        const tasks = getTasks(result)
        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({ title: 'Do something', status: 'completed' })
    })

    test('should handle mixed: existing task update + orphan new task', () => {
        const stateWithTask: TeamState = {
            ...baseTeamState,
            tasks: [{ id: 'task-1', title: 'Existing task', status: 'pending' }]
        }

        const result = applyTeamStateDelta(stateWithTask, {
            tasks: [
                { id: 'task-1', status: 'in_progress' } as any,
                { id: 'task-2', status: 'completed' } as any,
            ],
            updatedAt: 2000
        })

        const tasks = getTasks(result)
        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({ id: 'task-1', status: 'in_progress' })
    })

    test('should match agent task ids with and without @team suffix', () => {
        const stateWithTask: TeamState = {
            ...baseTeamState,
            tasks: [{ id: 'agent:coder', title: 'Coder task', status: 'in_progress' }]
        }

        const result = applyTeamStateDelta(stateWithTask, {
            tasks: [{ id: 'agent:coder@quick-check', status: 'completed' } as any],
            updatedAt: 2000
        })

        const tasks = getTasks(result)
        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({ id: 'agent:coder', status: 'completed' })
    })

    test('should canonicalize new agent task ids by dropping @team suffix', () => {
        const result = applyTeamStateDelta(baseTeamState, {
            tasks: [{ id: 'agent:researcher@quick-check', title: 'Research task', status: 'in_progress' }],
            updatedAt: 2000
        })

        const tasks = getTasks(result)
        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({ id: 'agent:researcher', title: 'Research task' })
    })
})

describe('extractTeamStateFromMessageContent - Agent tool', () => {
    test('should extract Agent tool as team member spawn', () => {
        const msg = makeToolCallMessage([{
            name: 'Agent',
            input: {
                name: 'researcher',
                description: 'Research API docs',
                prompt: 'Find all API endpoints',
                subagent_type: 'Explore',
                team_name: 'my-team'
            }
        }])

        const delta = extractTeamStateFromMessageContent(msg)
        expect(delta).toBeTruthy()
        expect(delta!.members).toHaveLength(1)
        expect(delta!.members![0]).toMatchObject({
            name: 'researcher',
            agentType: 'Explore',
            status: 'active'
        })
        expect(delta!.tasks).toHaveLength(1)
        expect(delta!.tasks![0]).toMatchObject({
            id: 'agent:researcher',
            title: 'Research API docs',
            status: 'in_progress',
            owner: 'researcher'
        })
    })

    test('should extract Agent tool with background and worktree flags', () => {
        const msg = makeToolCallMessage([{
            name: 'Agent',
            input: {
                name: 'builder',
                description: 'Build the project',
                team_name: 'my-team',
                run_in_background: true,
                isolation: 'worktree'
            }
        }])

        const delta = extractTeamStateFromMessageContent(msg)
        expect(delta).toBeTruthy()
        expect(delta!.members![0]).toMatchObject({
            name: 'builder',
            status: 'active',
            runInBackground: true,
            isolation: 'worktree'
        })
    })

    test('should NOT extract Agent tool without team_name (standalone subagent)', () => {
        const msg = makeToolCallMessage([{
            name: 'Agent',
            input: {
                name: 'worker',
                description: 'Do work'
            }
        }])

        const delta = extractTeamStateFromMessageContent(msg)
        expect(delta).toBeNull()
    })

    test('should still extract Task tool with team_name as legacy spawn', () => {
        const msg = makeToolCallMessage([{
            name: 'Task',
            input: {
                name: 'legacy-agent',
                team_name: 'my-team',
                description: 'Legacy task'
            }
        }])

        const delta = extractTeamStateFromMessageContent(msg)
        expect(delta).toBeTruthy()
        expect(delta!.members).toHaveLength(1)
        expect(delta!.members![0].name).toBe('legacy-agent')
    })

    test('should NOT extract Task tool without team_name (regular task)', () => {
        const msg = makeToolCallMessage([{
            name: 'Task',
            input: {
                description: 'Regular non-team task'
            }
        }])

        const delta = extractTeamStateFromMessageContent(msg)
        expect(delta).toBeNull()
    })

    test('should extract multiple tools from same message', () => {
        const msg = makeToolCallMessage([
            {
                name: 'TeamCreate',
                input: { team_name: 'project-x', description: 'Project team' }
            },
            {
                name: 'Agent',
                input: { name: 'dev-1', description: 'Frontend work', subagent_type: 'general-purpose', team_name: 'project-x' }
            }
        ])

        const delta = extractTeamStateFromMessageContent(msg)
        expect(delta).toBeTruthy()
        expect(delta!.teamName).toBe('project-x')
        expect(delta!.members).toHaveLength(1)
        expect(delta!.members![0].name).toBe('dev-1')
    })

    test('should extract SendMessage with shutdown_request', () => {
        const msg = makeToolCallMessage([{
            name: 'SendMessage',
            input: {
                type: 'shutdown_request',
                recipient: 'researcher',
                summary: 'Work is done'
            }
        }])

        const delta = extractTeamStateFromMessageContent(msg)
        expect(delta).toBeTruthy()
        expect(delta!.messages).toHaveLength(1)
        expect(delta!.messages![0].type).toBe('shutdown_request')
        expect(delta!.members).toHaveLength(1)
        expect(delta!.members![0]).toMatchObject({
            name: 'researcher',
            status: 'shutdown'
        })
    })
})

describe('extractTeamStateFromMessageContent - teammate messages', () => {
    const permissionRequestJson = JSON.stringify({
        type: 'permission_request',
        request_id: 'perm-123',
        agent_id: 'todo-scanner',
        tool_name: 'Bash',
        tool_use_id: 'toolu_abc',
        description: 'Run tests',
        input: { command: 'npm test' }
    })
    const teammateXml = `<teammate-message teammate_id="todo-scanner" color="blue">\n${permissionRequestJson}\n</teammate-message>`

    // permission_request messages are skipped (resolved internally by team lead agent)
    test('should skip permission_request - returns null delta', () => {
        const content = {
            role: 'user',
            content: { type: 'text', text: teammateXml },
            meta: { sentFrom: 'cli' }
        }
        const delta = extractTeamStateFromMessageContent(content)
        expect(delta).toBeNull()
    })

    test('should skip permission_request from agent-wrapped format', () => {
        const content = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: { content: teammateXml },
                    isSidechain: true
                }
            }
        }
        const delta = extractTeamStateFromMessageContent(content)
        expect(delta).toBeNull()
    })

    // Format 6: idle_notification
    test('should parse idle_notification from teammate message', () => {
        const idleJson = JSON.stringify({ type: 'idle_notification', agent_id: 'worker' })
        const idleXml = `<teammate-message teammate_id="worker" color="green">\n${idleJson}\n</teammate-message>`
        const content = {
            role: 'user',
            content: { type: 'text', text: idleXml }
        }
        const delta = extractTeamStateFromMessageContent(content)
        expect(delta).toBeTruthy()
        expect(delta!.members).toHaveLength(1)
        expect(delta!.members![0]).toMatchObject({
            name: 'worker',
            status: 'idle'
        })
    })

    test('should parse multiple teammate-message tags in a single payload', () => {
        const payload = [
            '<teammate-message teammate_id="researcher" color="blue">',
            'started scanning team files',
            '</teammate-message>',
            '',
            '<teammate-message teammate_id="coder" color="green">',
            '{"type":"idle_notification","from":"coder"}',
            '</teammate-message>'
        ].join('\n')

        const content = {
            role: 'user',
            content: payload
        }

        const delta = extractTeamStateFromMessageContent(content)
        expect(delta).toBeTruthy()
        expect(delta!.members).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'researcher',
                lastOutput: 'started scanning team files'
            }),
            expect.objectContaining({
                name: 'coder',
                status: 'idle'
            })
        ]))
        expect(delta!.tasks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'agent:coder',
                status: 'completed'
            })
        ]))
        expect(delta!.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                from: 'researcher',
                to: 'team-lead',
                summary: 'started scanning team files'
            }),
            expect.objectContaining({
                from: 'coder',
                to: 'team-lead',
                summary: 'idle'
            })
        ]))
    })
})

describe('extractTeamStateFromMessageContent - TeamCreate tool result', () => {
    test('should extract effective team_name from TeamCreate tool_result payload', () => {
        const content = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        content: [{
                            type: 'tool_result',
                            tool_use_id: 'toolu_team_create',
                            content: {
                                team_name: 'elegant-orbiting-corbato',
                                team_file_path: '/tmp/config.json',
                                lead_agent_id: 'team-lead@elegant-orbiting-corbato'
                            }
                        }]
                    },
                    isSidechain: true
                }
            }
        }

        const delta = extractTeamStateFromMessageContent(content)
        expect(delta).toBeTruthy()
        expect(delta!._action).toBe('update')
        expect(delta!.teamName).toBe('elegant-orbiting-corbato')
    })
})

describe('applyTeamStateDelta - member properties', () => {
    test('should preserve new member fields (description, isolation, runInBackground)', () => {
        const result = applyTeamStateDelta(baseTeamState, {
            _action: 'update',
            members: [{
                name: 'worker',
                agentType: 'Explore',
                status: 'active',
                description: 'Search codebase',
                isolation: 'worktree',
                runInBackground: true
            }],
            updatedAt: 2000
        })

        expect(result).toBeTruthy()
        const members = result!.members ?? []
        const worker = members.find(m => m.name === 'worker')
        expect(worker).toBeTruthy()
        expect(worker!.description).toBe('Search codebase')
        expect(worker!.isolation).toBe('worktree')
        expect(worker!.runInBackground).toBe(true)
    })

    test('should merge member updates preserving existing fields', () => {
        const stateWithMember: TeamState = {
            ...baseTeamState,
            members: [{
                name: 'worker',
                agentType: 'Explore',
                status: 'active',
                description: 'Search codebase',
                isolation: 'worktree'
            }]
        }

        const result = applyTeamStateDelta(stateWithMember, {
            _action: 'update',
            members: [{ name: 'worker', status: 'completed' }],
            updatedAt: 2000
        })

        const worker = result!.members!.find(m => m.name === 'worker')
        expect(worker!.status).toBe('completed')
        expect(worker!.description).toBe('Search codebase')
        expect(worker!.isolation).toBe('worktree')
    })
})

describe('applyTeamStateDelta - metadata updates', () => {
    test('should update teamName/description on update delta', () => {
        const result = applyTeamStateDelta(baseTeamState, {
            _action: 'update',
            teamName: 'effective-team-name',
            description: 'Effective team description',
            updatedAt: Date.now()
        })

        expect(result).toBeTruthy()
        expect(result!.teamName).toBe('effective-team-name')
        expect(result!.description).toBe('Effective team description')
    })
})
