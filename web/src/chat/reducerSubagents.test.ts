import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage } from './types'

function eventMessage(id: string, content: NormalizedMessage['content'], createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content,
        isSidechain: false
    } as NormalizedMessage
}

describe('reduceChatBlocks — Codex subagents', () => {
    it('groups child output under the matching subagent action card', () => {
        const result = reduceChatBlocks([
            eventMessage('action-1', {
                type: 'codex_subagent_action',
                tool: 'spawnAgent',
                status: 'in_progress',
                receiverThreadIds: ['child-1'],
                agents: [{ threadId: 'child-1', nickname: 'Locke', role: 'explorer' }]
            }, 1000),
            eventMessage('output-1', {
                type: 'codex_subagent_output',
                threadId: 'child-1',
                role: 'assistant',
                text: 'child result'
            }, 1001)
        ], null)

        expect(result.blocks).toHaveLength(1)
        expect(result.blocks[0]).toMatchObject({
            kind: 'codex-subagents',
            action: {
                tool: 'spawnAgent',
                receiverThreadIds: ['child-1']
            },
            outputsByThreadId: {
                'child-1': [{
                    role: 'assistant',
                    text: 'child result'
                }]
            }
        })
    })
})
