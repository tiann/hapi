import { describe, expect, it } from 'vitest'
import type { AgentTextBlock, ChatBlock, ToolCallBlock } from '@/chat/types'
import { groupConsecutiveToolBlocks, isToolGroupBlock } from '@/chat/toolGrouping'

function makeTool(id: string, overrides: Partial<ToolCallBlock['tool']> = {}, children: ChatBlock[] = []): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: Number(id.replace(/\D/g, '')) || 0,
        tool: {
            id,
            name: 'Bash',
            state: 'completed',
            input: { command: `echo ${id}` },
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            description: null,
            ...overrides
        },
        children
    }
}

function makeText(id: string): AgentTextBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 0,
        text: `text ${id}`
    }
}

describe('groupConsecutiveToolBlocks', () => {
    it('groups two or more consecutive non-actionable tool calls', () => {
        const grouped = groupConsecutiveToolBlocks([
            makeTool('tool-1'),
            makeTool('tool-2')
        ])

        expect(grouped).toHaveLength(1)
        expect(isToolGroupBlock(grouped[0])).toBe(true)
        if (!isToolGroupBlock(grouped[0])) return
        expect(grouped[0].id).toBe('tool-group:tool-1')
        expect(grouped[0].tools.map((tool) => tool.id)).toEqual(['tool-1', 'tool-2'])
    })

    it('leaves a single tool call as a standalone row', () => {
        const grouped = groupConsecutiveToolBlocks([
            makeTool('tool-1')
        ])

        expect(grouped.map((block) => block.kind)).toEqual(['tool-call'])
    })

    it('uses text and other non-tool blocks as hard group boundaries', () => {
        const grouped = groupConsecutiveToolBlocks([
            makeTool('tool-1'),
            makeTool('tool-2'),
            makeText('text-1'),
            makeTool('tool-4'),
            makeTool('tool-5')
        ])

        expect(grouped.map((block) => block.kind)).toEqual(['tool-group', 'agent-text', 'tool-group'])
    })

    it('keeps pending, failed, and nested tools visible outside collapsed groups', () => {
        const pending = makeTool('tool-pending', {
            state: 'pending',
            permission: { id: 'permission-1', status: 'pending' }
        })
        const failed = makeTool('tool-failed', { state: 'error' })
        const nested = makeTool('tool-nested', {}, [makeTool('tool-child')])

        const grouped = groupConsecutiveToolBlocks([
            makeTool('tool-1'),
            makeTool('tool-2'),
            makeTool('tool-3'),
            pending,
            makeTool('tool-4'),
            makeTool('tool-5'),
            failed,
            makeTool('tool-6'),
            makeTool('tool-7'),
            nested
        ])

        expect(grouped.map((block) => block.kind)).toEqual([
            'tool-group',
            'tool-call',
            'tool-group',
            'tool-call',
            'tool-group',
            'tool-call'
        ])
        expect(grouped[1]).toBe(pending)
        expect(grouped[3]).toBe(failed)
        expect(grouped[5]).toBe(nested)
    })
})
