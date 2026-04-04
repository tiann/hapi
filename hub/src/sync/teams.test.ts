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

describe('extractTeamStateFromMessageContent - normalized subagent metadata', () => {
    test('derives team task/member updates from normalized Codex subagent metadata', () => {
        const delta = extractTeamStateFromMessageContent({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'CodexSpawnAgent',
                    input: { name: 'worker-1' },
                    meta: {
                        subagent: {
                            kind: 'spawn',
                            sidechainKey: 'task-1',
                            prompt: 'Investigate flaky test'
                        }
                    }
                }
            }
        })

        expect(delta).toMatchObject({
            members: [{ name: 'worker-1', status: 'active' }],
            tasks: [{ title: 'Investigate flaky test', status: 'in_progress', owner: 'worker-1' }]
        })
    })

    test('derives team task/member updates from normalized Claude subagent metadata', () => {
        const delta = extractTeamStateFromMessageContent({
            role: 'assistant',
            meta: {
                subagent: {
                    kind: 'spawn',
                    sidechainKey: 'task-2',
                    prompt: 'Investigate flaky test'
                }
            },
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [{
                            type: 'tool_use',
                            id: 'task-2',
                            name: 'Task',
                            input: { name: 'worker-1' }
                        }]
                    }
                }
            }
        })

        expect(delta).toMatchObject({
            members: [{ name: 'worker-1', status: 'active' }],
            tasks: [{ title: 'Investigate flaky test', status: 'in_progress', owner: 'worker-1' }]
        })
    })
})
