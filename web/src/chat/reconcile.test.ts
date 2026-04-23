import { describe, expect, it } from 'vitest'
import { reconcileChatBlocks, type ChatBlocksById } from './reconcile'
import type { CodexAgentLifecycleStatus, ToolCallBlock } from './types'

const sharedInput = { message: 'child prompt' }
const sharedResult = { agent_id: 'agent-1', nickname: 'First' }

function spawnBlock(status: CodexAgentLifecycleStatus): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'spawn-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'spawn-1',
            name: 'CodexSpawnAgent',
            state: 'completed',
            input: sharedInput,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: sharedResult
        },
        children: [],
        lifecycle: {
            kind: 'codex-agent-lifecycle',
            agentId: 'agent-1',
            nickname: 'First',
            status,
            latestText: status === 'completed' ? 'child done' : 'agent-1:',
            actions: [{
                type: 'wait',
                createdAt: 3,
                summary: status === 'completed' ? 'child done' : 'agent-1:'
            }],
            hiddenToolIds: ['wait-1']
        }
    }
}

describe('reconcileChatBlocks', () => {
    it('does not reuse stale tool blocks when Codex lifecycle changes', () => {
        const prev = spawnBlock('waiting')
        const next = spawnBlock('completed')
        const prevById: ChatBlocksById = new Map([[prev.id, prev]])

        const reconciled = reconcileChatBlocks([next], prevById)
        const block = reconciled.blocks[0]

        expect(block).toBe(next)
        expect(block.kind === 'tool-call' ? block.lifecycle?.status : null).toBe('completed')
        expect(block.kind === 'tool-call' ? block.lifecycle?.latestText : null).toBe('child done')
    })
})
