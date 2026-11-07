import { describe, expect, it } from 'bun:test'
import { extractSessionTodosFromMessageContent } from './todos'

describe('extractSessionTodosFromMessageContent', () => {
    it('promotes Codex update_plan tool calls to session todos', () => {
        const todos = extractSessionTodosFromMessageContent({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'update_plan',
                    input: {
                        plan: [
                            { step: 'Inspect the repository', status: 'completed' },
                            { step: 'Implement the fix', status: 'in_progress' },
                            { step: 'Run the regression tests', status: 'pending' }
                        ]
                    }
                }
            }
        })

        expect(todos).toEqual([
            { content: 'Inspect the repository', priority: 'medium', status: 'completed', id: 'plan-1' },
            { content: 'Implement the fix', priority: 'medium', status: 'in_progress', id: 'plan-2' },
            { content: 'Run the regression tests', priority: 'medium', status: 'pending', id: 'plan-3' }
        ])
    })

    it('accepts the direct plan_update payload used by older Codex paths', () => {
        const todos = extractSessionTodosFromMessageContent({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'plan_update',
                    plan: [{ content: 'Keep the session task state visible', state: 'active' }]
                }
            }
        })

        expect(todos).toEqual([
            {
                content: 'Keep the session task state visible',
                priority: 'medium',
                status: 'in_progress',
                id: 'plan-1'
            }
        ])
    })

    it('keeps Claude TodoWrite snapshots as the canonical task state', () => {
        const todos = extractSessionTodosFromMessageContent({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [{
                            type: 'tool_use',
                            name: 'TodoWrite',
                            input: {
                                todos: [{ content: 'Use the shared task state', status: 'pending' }]
                            }
                        }]
                    }
                }
            }
        })

        expect(todos).toEqual([
            { content: 'Use the shared task state', priority: 'medium', id: '', status: 'pending' }
        ])
    })

    it('promotes a structured Markdown plan attached to ExitPlanMode', () => {
        const todos = extractSessionTodosFromMessageContent({
            role: 'assistant',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'text', text: '## Proposed plan\n\n1. Inspect\n2. Implement' },
                            { type: 'tool_use', name: 'ExitPlanMode', input: {} }
                        ]
                    }
                }
            }
        })

        expect(todos).toEqual([
            { content: 'Inspect', priority: 'medium', status: 'pending', id: 'plan-1' },
            { content: 'Implement', priority: 'medium', status: 'pending', id: 'plan-2' }
        ])
    })

    it('ignores nested Markdown plan detail bullets', () => {
        const todos = extractSessionTodosFromMessageContent({
            role: 'assistant',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [
                            {
                                type: 'text',
                                text: '## Proposed plan\n\n1. Inspect\n   - Read the relevant files\n2. Implement\n   - Add regression tests'
                            },
                            { type: 'tool_use', name: 'ExitPlanMode', input: {} }
                        ]
                    }
                }
            }
        })

        expect(todos).toEqual([
            { content: 'Inspect', priority: 'medium', status: 'pending', id: 'plan-1' },
            { content: 'Implement', priority: 'medium', status: 'pending', id: 'plan-2' }
        ])
    })

    it('does not promote ordinary assistant text without a plan event', () => {
        const todos = extractSessionTodosFromMessageContent({
            role: 'assistant',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [{ type: 'text', text: '1. This is just an explanation' }]
                    }
                }
            }
        })

        expect(todos).toBeNull()
    })
})
