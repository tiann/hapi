import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage, ToolCallBlock } from './types'

function agentToolCall(
    messageId: string,
    toolUseId: string,
    name: string,
    input: unknown,
    createdAt: number
): NormalizedMessage {
    return {
        id: messageId,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: toolUseId,
            name,
            input,
            description: null,
            uuid: `${messageId}-uuid`,
            parentUUID: null
        }]
    }
}

function agentToolResult(
    messageId: string,
    toolUseId: string,
    content: unknown,
    createdAt: number
): NormalizedMessage {
    return {
        id: messageId,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-result',
            tool_use_id: toolUseId,
            content,
            is_error: false,
            uuid: `${messageId}-uuid`,
            parentUUID: null
        }]
    }
}

function userText(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'user',
        isSidechain: false,
        content: { type: 'text', text }
    }
}

function agentText(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'text',
            text,
            uuid: `${id}-uuid`,
            parentUUID: null
        }]
    }
}

describe('reduceChatBlocks', () => {
    it('groups Codex child messages under the matching spawn tool block', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('msg-spawn-call', 'spawn-1', 'CodexSpawnAgent', { message: 'Search GitHub trending' }, 1),
            agentToolResult('msg-spawn-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'Pauli' }, 2),
            userText('child-user', 'child prompt', 3),
            agentText('child-agent', 'child answer', 4),
            userText('notification', '<subagent_notification> child update', 5),
            agentToolCall('msg-wait-call', 'wait-1', 'CodexWaitAgent', { targets: ['agent-1'], timeout_ms: 120000 }, 6)
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlock = reduced.blocks.find(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

        expect(spawnBlock).toBeDefined()
        expect(spawnBlock?.children.map((child) => child.kind)).toEqual(['user-text', 'agent-text'])
        expect(spawnBlock?.children).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'user-text', text: 'child prompt' }),
                expect.objectContaining({ kind: 'agent-text', text: 'child answer' })
            ])
        )
        expect(reduced.blocks).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'user-text', text: 'child prompt' }),
                expect.objectContaining({ kind: 'agent-text', text: 'child answer' })
            ])
        )
        expect(reduced.blocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'user-text', text: '<subagent_notification> child update' }),
                expect.objectContaining({ kind: 'tool-call', tool: expect.objectContaining({ name: 'CodexWaitAgent' }) })
            ])
        )
    })
})
