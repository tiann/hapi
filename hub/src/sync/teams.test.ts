import { describe, test, expect } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
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

function codexToolMessage(name: string, input: Record<string, unknown>) {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: {
                type: 'tool-call',
                name,
                input
            }
        }
    }
}

function assistantToolBatch(blocks: Array<{ name: string; input: Record<string, unknown> }>) {
    return {
        role: 'assistant',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    content: blocks.map((block, index) => ({
                        type: 'tool_use',
                        id: `tool-${index}`,
                        name: block.name,
                        input: block.input
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
})

describe('Codex multi_agent_v1 team tracking', () => {
    test('should create team state when Codex spawn_agent appears without TeamCreate', () => {
        const delta = extractTeamStateFromMessageContent(codexToolMessage('spawn_agent', {
            agent_id: '019e83f2-45a6-72e3-b8ef-c11ed786f2a4',
            nickname: 'Boyle',
            agent_type: 'default',
            message: 'Review the HAPI Codex subagent diff'
        }))

        expect(delta).toBeTruthy()
        const result = applyTeamStateDelta(null, delta as any)

        expect(result).toMatchObject({
            teamName: 'Codex subagents',
            members: [{
                name: '019e83f2-45a6-72e3-b8ef-c11ed786f2a4',
                agentType: 'Boyle (default)',
                status: 'active'
            }],
            tasks: [{
                id: 'codex-subagent:019e83f2-45a6-72e3-b8ef-c11ed786f2a4',
                title: 'Review the HAPI Codex subagent diff',
                status: 'in_progress',
                owner: '019e83f2-45a6-72e3-b8ef-c11ed786f2a4'
            }]
        })
    })

    test('should mark Codex subagent tasks completed after wait_agent', () => {
        const state = applyTeamStateDelta(null, extractTeamStateFromMessageContent(codexToolMessage('spawn_agent', {
            agent_id: 'agent-1',
            nickname: 'Boyle',
            message: 'Review the HAPI diff'
        })) as any)
        const delta = extractTeamStateFromMessageContent(codexToolMessage('wait_agent', {
            target: 'agent-1',
            status: {
                'agent-1': { completed: 'Done' }
            }
        }))
        const result = applyTeamStateDelta(state, delta as any)

        expect(result?.members).toContainEqual(expect.objectContaining({
            name: 'agent-1',
            status: 'idle'
        }))
        expect(result?.tasks).toContainEqual(expect.objectContaining({
            id: 'codex-subagent:agent-1',
            title: 'Review the HAPI diff',
            status: 'completed'
        }))
    })

    test('should keep Codex wait_agent targets visible when status is empty', () => {
        const state = applyTeamStateDelta(null, extractTeamStateFromMessageContent(codexToolMessage('spawn_agent', {
            agent_id: 'agent-1',
            nickname: 'Boyle',
            message: 'Review the HAPI diff'
        })) as any)
        const delta = extractTeamStateFromMessageContent(codexToolMessage('wait_agent', {
            targets: ['agent-1'],
            status: {}
        }))
        const result = applyTeamStateDelta(state, delta as any)

        expect(result?.members).toContainEqual(expect.objectContaining({
            name: 'agent-1',
            status: 'active'
        }))
        expect(result?.tasks).toContainEqual(expect.objectContaining({
            id: 'codex-subagent:agent-1',
            title: 'Review the HAPI diff',
            status: 'in_progress'
        }))
    })

    test('should mark Codex subagents shutdown after close_agent', () => {
        const state = applyTeamStateDelta(null, extractTeamStateFromMessageContent(codexToolMessage('spawn_agent', {
            agent_id: 'agent-1',
            nickname: 'Boyle',
            message: 'Review the HAPI diff'
        })) as any)
        const delta = extractTeamStateFromMessageContent(codexToolMessage('close_agent', {
            target: 'agent-1'
        }))
        const result = applyTeamStateDelta(state, delta as any)

        expect(result?.members).toContainEqual(expect.objectContaining({
            name: 'agent-1',
            status: 'shutdown'
        }))
        expect(result?.tasks).toContainEqual(expect.objectContaining({
            id: 'codex-subagent:agent-1',
            title: 'Review the HAPI diff',
            status: 'completed'
        }))
    })

    test('should not mark a closed running Codex subagent task as completed', () => {
        const state = applyTeamStateDelta(null, extractTeamStateFromMessageContent(codexToolMessage('spawn_agent', {
            agent_id: 'agent-1',
            nickname: 'Boyle',
            message: 'Review the HAPI diff'
        })) as any)
        const delta = extractTeamStateFromMessageContent(codexToolMessage('close_agent', {
            target: 'agent-1',
            previous_status: { running: true }
        }))
        const result = applyTeamStateDelta(state, delta as any)

        expect(result?.members).toContainEqual(expect.objectContaining({
            name: 'agent-1',
            status: 'shutdown'
        }))
        expect(result?.tasks).toContainEqual(expect.objectContaining({
            id: 'codex-subagent:agent-1',
            title: 'Review the HAPI diff',
            status: 'blocked'
        }))
    })

    test('should treat null close_agent previous_status as no prior status', () => {
        const state = applyTeamStateDelta(null, extractTeamStateFromMessageContent(codexToolMessage('spawn_agent', {
            agent_id: 'agent-1',
            nickname: 'Boyle',
            message: 'Review the HAPI diff'
        })) as any)
        const delta = extractTeamStateFromMessageContent(codexToolMessage('close_agent', {
            target: 'agent-1',
            previous_status: null
        }))
        const result = applyTeamStateDelta(state, delta as any)

        expect(result?.tasks).toContainEqual(expect.objectContaining({
            id: 'codex-subagent:agent-1',
            title: 'Review the HAPI diff',
            status: 'completed'
        }))
    })

    test('should still create Codex subagent state when an ensure delta follows an update in the same message', () => {
        const delta = extractTeamStateFromMessageContent(assistantToolBatch([
            {
                name: 'close_agent',
                input: { target: 'agent-1' }
            },
            {
                name: 'spawn_agent',
                input: {
                    agent_id: 'agent-1',
                    nickname: 'Boyle',
                    message: 'Review the HAPI diff'
                }
            }
        ]))
        const result = applyTeamStateDelta(null, delta as any)

        expect(result).toMatchObject({
            teamName: 'Codex subagents',
            members: [expect.objectContaining({ name: 'agent-1' })]
        })
    })
})
