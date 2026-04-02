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
    it('groups Codex child messages under the matching spawn tool block and folds lifecycle controls into it', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('msg-spawn-call', 'spawn-1', 'CodexSpawnAgent', { message: 'Search GitHub trending' }, 1),
            agentToolResult('msg-spawn-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'Pauli' }, 2),
            userText('child-user', 'child prompt', 3),
            agentText('child-agent', 'child answer', 4),
            userText('notification', '<subagent_notification> child update', 5),
            agentToolCall('msg-wait-call', 'wait-1', 'CodexWaitAgent', { targets: ['agent-1'], timeout_ms: 120000 }, 6),
            agentToolResult('msg-wait-result', 'wait-1', { status: 'completed', text: 'agent finished' }, 7),
            agentToolCall('msg-send-call', 'send-1', 'CodexSendInput', { target: 'agent-1', message: 'continue', interrupt: true }, 8),
            agentToolResult('msg-send-result', 'send-1', { ok: true }, 9),
            agentToolCall('msg-close-call', 'close-1', 'CodexCloseAgent', { target: 'agent-1' }, 10),
            agentToolResult('msg-close-result', 'close-1', { status: 'closed' }, 11)
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
        expect(spawnBlock?.lifecycle).toEqual(
            expect.objectContaining({
                kind: 'codex-agent-lifecycle',
                agentId: 'agent-1',
                nickname: 'Pauli',
                status: 'completed'
            })
        )
        expect(spawnBlock?.lifecycle?.actions.map((action) => action.type)).toEqual(['wait', 'send', 'close'])
        expect(spawnBlock?.lifecycle?.actions.map((action) => action.summary)).toEqual([
            'agent finished',
            'Sent input to agent-1',
            'Closed agent-1'
        ])
        expect(spawnBlock?.lifecycle?.hiddenToolIds).toEqual(expect.arrayContaining(['wait-1', 'send-1', 'close-1']))
        expect(
            reduced.blocks.some((block) => block.kind === 'user-text' && block.text === 'child prompt')
        ).toBe(false)
        expect(
            reduced.blocks.some((block) => block.kind === 'agent-text' && block.text === 'child answer')
        ).toBe(false)
        expect(
            reduced.blocks.some((block) =>
                block.kind === 'tool-call'
                && ['CodexWaitAgent', 'CodexSendInput', 'CodexCloseAgent'].includes(block.tool.name)
            )
        ).toBe(false)
        expect(reduced.blocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'user-text', text: '<subagent_notification> child update' }),
                expect.objectContaining({ kind: 'tool-call', tool: expect.objectContaining({ name: 'CodexSpawnAgent' }) })
            ])
        )
    })

    it('does not mark unresolved sibling spawn blocks completed from a partial multi-target wait result', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('msg-spawn-1-call', 'spawn-1', 'CodexSpawnAgent', { message: 'First child' }, 1),
            agentToolResult('msg-spawn-1-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'First' }, 2),
            agentToolCall('msg-spawn-2-call', 'spawn-2', 'CodexSpawnAgent', { message: 'Second child' }, 3),
            agentToolResult('msg-spawn-2-result', 'spawn-2', { agent_id: 'agent-2', nickname: 'Second' }, 4),
            agentToolCall('msg-wait-call', 'wait-1', 'CodexWaitAgent', { targets: ['agent-1', 'agent-2'] }, 5),
            agentToolResult('msg-wait-result', 'wait-1', {
                statuses: {
                    'agent-1': {
                        status: 'completed',
                        message: 'done'
                    }
                }
            }, 6)
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlocks = reduced.blocks.filter(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

        expect(spawnBlocks).toHaveLength(2)
        expect(spawnBlocks.find((block) => block.tool.id === 'spawn-1')?.lifecycle?.status).toBe('completed')
        expect(spawnBlocks.find((block) => block.tool.id === 'spawn-2')?.lifecycle?.status).toBe('running')
    })

    it('reassigns a stray root child reply to the matching spawn card using wait status messages', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('msg-spawn-1-call', 'spawn-1', 'CodexSpawnAgent', { message: 'First child prompt' }, 1),
            agentToolResult('msg-spawn-1-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'First' }, 2),
            agentToolCall('msg-spawn-2-call', 'spawn-2', 'CodexSpawnAgent', { message: 'Second child prompt' }, 3),
            agentToolResult('msg-spawn-2-result', 'spawn-2', { agent_id: 'agent-2', nickname: 'Second' }, 4),
            {
                ...userText('child-2-user', 'Second child prompt', 5),
                isSidechain: true,
                sidechainKey: 'spawn-2'
            },
            {
                ...agentText('child-2-agent', 'Second child answer', 6),
                isSidechain: true,
                sidechainKey: 'spawn-2'
            },
            agentText('child-1-root-agent', 'First child answer', 7),
            agentText('parent-agent', 'Parent progress update', 8),
            agentToolCall('msg-wait-call', 'wait-1', 'CodexWaitAgent', { targets: ['agent-1', 'agent-2'] }, 9),
            agentToolResult('msg-wait-result', 'wait-1', {
                statuses: {
                    'agent-1': {
                        status: 'completed',
                        message: 'First child answer'
                    },
                    'agent-2': {
                        status: 'completed',
                        message: 'Second child answer'
                    }
                }
            }, 10)
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlocks = reduced.blocks.filter(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

        const firstSpawn = spawnBlocks.find((block) => block.tool.id === 'spawn-1')
        const secondSpawn = spawnBlocks.find((block) => block.tool.id === 'spawn-2')

        expect(firstSpawn?.children).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'agent-text', text: 'First child answer' })
            ])
        )
        expect(secondSpawn?.children).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'user-text', text: 'Second child prompt' }),
                expect.objectContaining({ kind: 'agent-text', text: 'Second child answer' })
            ])
        )
        expect(
            reduced.blocks.some((block) => block.kind === 'agent-text' && block.text === 'First child answer')
        ).toBe(false)
        expect(
            reduced.blocks.some((block) => block.kind === 'agent-text' && block.text === 'Parent progress update')
        ).toBe(true)
    })

    it('uses the completed child message as lifecycle latest text for single-target waits', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('msg-spawn-call', 'spawn-1', 'CodexSpawnAgent', { message: 'Delegate task' }, 1),
            agentToolResult('msg-spawn-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'Solo' }, 2),
            agentToolCall('msg-wait-call', 'wait-1', 'CodexWaitAgent', { targets: ['agent-1'] }, 3),
            agentToolResult('msg-wait-result', 'wait-1', {
                statuses: {
                    'agent-1': {
                        status: 'completed',
                        message: 'Final child answer'
                    }
                }
            }, 4)
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlock = reduced.blocks.find(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

        expect(spawnBlock?.lifecycle?.latestText).toBe('Final child answer')
    })
})
