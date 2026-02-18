import { describe, expect, it } from 'vitest'
import { reconcileChatBlocks, type ChatBlocksById } from './reconcile'
import type { AgentTextBlock, ChatBlock, ToolCallBlock, ToolPermission, UserTextBlock } from './types'

function userText(id: string, text: string): UserTextBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

function agentText(id: string, text: string): AgentTextBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

function toolCall(
    id: string,
    children: ChatBlock[] = [],
    permission?: ToolPermission,
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        tool: {
            id: `call-${id}`,
            name: 'edit',
            state: 'completed',
            input: 'input',
            result: 'result',
            description: 'desc',
            createdAt: 1,
            startedAt: 2,
            completedAt: 3,
            permission,
        },
        children,
    }
}

function index(blocks: ChatBlock[]): ChatBlocksById {
    const byId: ChatBlocksById = new Map()

    const walk = (items: ChatBlock[]): void => {
        for (const block of items) {
            byId.set(block.id, block)
            if (block.kind === 'tool-call') {
                walk(block.children)
            }
        }
    }

    walk(blocks)
    return byId
}

describe('reconcileChatBlocks', () => {
    it('preserves prior references when block contents are unchanged', () => {
        const prev = userText('u-1', 'hello')
        const next = { ...prev }
        const prevById: ChatBlocksById = new Map([[prev.id, prev]])

        const result = reconcileChatBlocks([next], prevById)

        expect(result.blocks[0]).toBe(prev)
        expect(result.byId.get(prev.id)).toBe(prev)
    })

    it('replaces block reference when content changes', () => {
        const prev = userText('u-1', 'before')
        const next = { ...prev, text: 'after' }
        const prevById: ChatBlocksById = new Map([[prev.id, prev]])

        const result = reconcileChatBlocks([next], prevById)

        expect(result.blocks[0]).toBe(next)
        expect(result.blocks[0]).not.toBe(prev)
    })

    it('indexes nested tool-call children in byId map', () => {
        const leaf = agentText('leaf-1', 'done')
        const nested = toolCall('tool-child', [leaf])
        const root = toolCall('tool-root', [nested])

        const result = reconcileChatBlocks([root], new Map())

        expect(result.byId.get('tool-root')).toBe(root)
        expect(result.byId.get('tool-child')).toBe(nested)
        expect(result.byId.get('leaf-1')).toBe(leaf)
    })

    it('treats flat and nested permission answers as equal', () => {
        const prevPermission: ToolPermission = {
            id: 'perm-1',
            status: 'approved',
            reason: 'ok',
            mode: 'plan',
            decision: 'approved',
            allowedTools: ['edit', 'write'],
            answers: {
                q1: ['yes'],
                q2: ['a', 'b'],
            },
            date: 10,
            createdAt: 11,
            completedAt: 12,
        }

        const nextPermission: ToolPermission = {
            id: 'perm-1',
            status: 'approved',
            reason: 'ok',
            mode: 'plan',
            decision: 'approved',
            allowedTools: ['edit', 'write'],
            answers: {
                q1: { answers: ['yes'] },
                q2: { answers: ['a', 'b'] },
            },
            date: 10,
            createdAt: 11,
            completedAt: 12,
        }

        const prev = toolCall('tool-1', [], prevPermission)
        const next = toolCall('tool-1', [], nextPermission)
        const prevById: ChatBlocksById = new Map([[prev.id, prev]])

        const result = reconcileChatBlocks([next], prevById)

        expect(result.blocks[0]).toBe(prev)
    })

    it('recreates tool-call parent when a child block changes', () => {
        const prevChild = agentText('child-1', 'before')
        const prevParent = toolCall('tool-1', [prevChild])
        const prevById = index([prevParent])

        const nextChild = { ...prevChild, text: 'after' }
        const nextParent = toolCall('tool-1', [nextChild])

        const result = reconcileChatBlocks([nextParent], prevById)

        expect(result.blocks[0]).toBe(nextParent)
        expect(result.blocks[0]).not.toBe(prevParent)
        expect(result.byId.get('tool-1')).toBe(nextParent)
        expect(result.byId.get('child-1')).toBe(nextChild)
    })
})
