import { describe, expect, it } from 'vitest'
import { extractClaudeSubagentMeta, resetClaudeSubagentAdapterState } from './claudeSubagentAdapter'

describe('claudeSubagentAdapter', () => {
    it('retains the Task prompt for later lifecycle title fallback', () => {
        resetClaudeSubagentAdapterState()

        expect(extractClaudeSubagentMeta({
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

        expect(extractClaudeSubagentMeta({
            type: 'result',
            subtype: 'success',
            result: 'done',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'task-1'
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

    it('derives normalized Claude subagent spawn metadata from Task tool use', () => {
        resetClaudeSubagentAdapterState()

        const meta = extractClaudeSubagentMeta({
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

        expect(meta).toEqual([{
            kind: 'spawn',
            sidechainKey: 'task-1',
            prompt: 'Investigate test failure'
        }])
    })

    it('preserves the same sidechain key for assistant and user sidechain messages', () => {
        resetClaudeSubagentAdapterState()

        expect(extractClaudeSubagentMeta({
            type: 'assistant',
            parent_tool_use_id: 'task-1',
            message: {
                content: [{ type: 'text', text: 'working the sidechain' }]
            }
        } as any)).toEqual([{
            kind: 'message',
            sidechainKey: 'task-1'
        }])

        expect(extractClaudeSubagentMeta({
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

    it('maps Claude-native completion and error results to normalized lifecycle status', () => {
        resetClaudeSubagentAdapterState()

        expect(extractClaudeSubagentMeta({
            type: 'result',
            subtype: 'success',
            result: 'done',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'task-1'
        } as any)).toContainEqual({
            kind: 'status',
            sidechainKey: 'task-1',
            status: 'completed'
        })

        expect(extractClaudeSubagentMeta({
            type: 'result',
            subtype: 'error_during_execution',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: true,
            session_id: 'task-1'
        } as any)).toContainEqual({
            kind: 'status',
            sidechainKey: 'task-1',
            status: 'error'
        })
    })

    it('falls back to session id when no prompt is available', () => {
        resetClaudeSubagentAdapterState()

        expect(extractClaudeSubagentMeta({
            type: 'result',
            subtype: 'success',
            result: 'done',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'task-2'
        } as any)).toEqual([
            {
                kind: 'status',
                sidechainKey: 'task-2',
                status: 'completed'
            },
            {
                kind: 'title',
                sidechainKey: 'task-2',
                title: 'task-2'
            }
        ])
    })
})
