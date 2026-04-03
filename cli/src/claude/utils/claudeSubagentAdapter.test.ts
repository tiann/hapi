import { describe, expect, it } from 'vitest'
import { createClaudeSubagentAdapter } from './claudeSubagentAdapter'

describe('claudeSubagentAdapter', () => {
    it('derives normalized Claude subagent spawn metadata from Task tool use', () => {
        const adapter = createClaudeSubagentAdapter()

        expect(adapter.extract({
            type: 'assistant',
            message: {
                content: [{
                    type: 'tool_use',
                    id: 'task-1',
                    name: 'Task',
                    input: { prompt: 'Investigate test failure' }
                }]
            }
        } as any)).toEqual([{
            kind: 'spawn',
            sidechainKey: 'task-1',
            prompt: 'Investigate test failure'
        }])
    })

    it('preserves the same sidechain key for assistant and user sidechain messages', () => {
        const adapter = createClaudeSubagentAdapter()

        expect(adapter.extract({
            type: 'assistant',
            parent_tool_use_id: 'task-1',
            message: {
                content: [{ type: 'text', text: 'working the sidechain' }]
            }
        } as any)).toEqual([{
            kind: 'message',
            sidechainKey: 'task-1'
        }])

        expect(adapter.extract({
            type: 'user',
            parent_tool_use_id: 'task-1',
            message: {
                role: 'user',
                content: 'sidechain user reply'
            }
        } as any)).toEqual([{
            kind: 'message',
            sidechainKey: 'task-1'
        }])
    })

    it('retains the Task prompt for later lifecycle title fallback', () => {
        const adapter = createClaudeSubagentAdapter()

        adapter.extract({
            type: 'assistant',
            message: {
                content: [{
                    type: 'tool_use',
                    id: 'task-1',
                    name: 'Task',
                    input: { prompt: 'Investigate test failure' }
                }]
            }
        } as any)

        expect(adapter.extract({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'claude-session-1'
        } as any)).toEqual([
            {
                kind: 'status',
                sidechainKey: 'task-1',
                status: 'completed'
            },
            {
                kind: 'title',
                sidechainKey: 'task-1',
                title: 'Investigate test failure'
            }
        ])
    })

    it('falls back to session id as title text when the task prompt is unavailable', () => {
        const adapter = createClaudeSubagentAdapter()

        adapter.extract({
            type: 'assistant',
            message: {
                content: [{
                    type: 'tool_use',
                    id: 'task-2',
                    name: 'Task',
                    input: {}
                }]
            }
        } as any)

        expect(adapter.extract({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'claude-session-2'
        } as any)).toEqual([
            {
                kind: 'status',
                sidechainKey: 'task-2',
                status: 'completed'
            },
            {
                kind: 'title',
                sidechainKey: 'task-2',
                title: 'claude-session-2'
            }
        ])
    })

    it('does not guess a sidechain key from result.session_id when multiple Task sidechains are active', () => {
        const adapter = createClaudeSubagentAdapter()

        adapter.extract({
            type: 'assistant',
            message: {
                content: [
                    {
                        type: 'tool_use',
                        id: 'task-1',
                        name: 'Task',
                        input: { prompt: 'Task 1' }
                    },
                    {
                        type: 'tool_use',
                        id: 'task-2',
                        name: 'Task',
                        input: { prompt: 'Task 2' }
                    }
                ]
            }
        } as any)

        expect(adapter.extract({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'claude-session-3'
        } as any)).toEqual([])
    })
})
