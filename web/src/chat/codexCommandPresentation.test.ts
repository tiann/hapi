import { describe, expect, it } from 'vitest'
import { getCodexCommandActions, isCodexExplorationTool } from '@/chat/codexCommandPresentation'
import type { ToolCallBlock } from '@/chat/types'

function block(input: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id: 'tool-1',
            name: 'CodexBash',
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null
        },
        children: []
    }
}

describe('Codex command presentation metadata', () => {
    it('accepts canonical app-server command actions', () => {
        const tool = block({
            command_actions: [
                { type: 'read', command: 'cat a.ts', name: 'a.ts', path: '/repo/a.ts' },
                { type: 'search', command: 'rg token', query: 'token', path: 'src' }
            ]
        })

        expect(getCodexCommandActions(tool)).toHaveLength(2)
        expect(isCodexExplorationTool(tool)).toBe(true)
    })

    it('rejects malformed actions and does not classify unknown commands as exploration', () => {
        const tool = block({
            command_actions: [
                { type: 'read', command: 'cat' },
                { type: 'unknown', command: 'bun test' }
            ]
        })

        expect(getCodexCommandActions(tool)).toEqual([{ type: 'unknown', command: 'bun test' }])
        expect(isCodexExplorationTool(tool)).toBe(false)
    })

    it('keeps user shell commands out of agent exploration groups', () => {
        const tool = block({
            command_source: 'userShell',
            command_actions: [{
                type: 'read',
                command: 'cat a.ts',
                name: 'a.ts',
                path: '/repo/a.ts'
            }]
        })

        expect(getCodexCommandActions(tool)).toHaveLength(1)
        expect(isCodexExplorationTool(tool)).toBe(false)
    })
})
