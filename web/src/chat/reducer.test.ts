import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import type { NormalizedAgentContent, NormalizedMessage, ToolCallBlock } from './types'

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

function userText(
    id: string,
    text: string,
    createdAt: number,
    extra: Partial<Pick<NormalizedMessage, 'isSidechain' | 'sidechainKey'>> = {}
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'user',
        isSidechain: extra.isSidechain ?? false,
        ...(extra.sidechainKey ? { sidechainKey: extra.sidechainKey } : {}),
        content: { type: 'text', text }
    }
}

function agentText(
    id: string,
    text: string,
    createdAt: number,
    extra: Partial<Pick<NormalizedMessage, 'isSidechain' | 'sidechainKey'>> = {}
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: extra.isSidechain ?? false,
        ...(extra.sidechainKey ? { sidechainKey: extra.sidechainKey } : {}),
        content: [{
            type: 'text',
            text,
            uuid: `${id}-uuid`,
            parentUUID: null
        }]
    }
}

function agentMessage(
    id: string,
    createdAt: number,
    content: NormalizedAgentContent[]
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content
    }
}

describe('reduceChatBlocks subagent grouping', () => {
    it('groups multiple Codex sidechain transcripts under their matching spawn cards', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1-call', 'spawn-1', 'CodexSpawnAgent', { message: 'First child prompt' }, 1),
            agentToolResult('spawn-1-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'First' }, 2),
            agentToolCall('spawn-2-call', 'spawn-2', 'CodexSpawnAgent', { message: 'Second child prompt' }, 3),
            agentToolResult('spawn-2-result', 'spawn-2', { agent_id: 'agent-2', nickname: 'Second' }, 4),
            userText('child-1-user', 'First child prompt', 5, { isSidechain: true, sidechainKey: 'spawn-1' }),
            agentText('child-1-agent', 'First child answer', 6, { isSidechain: true, sidechainKey: 'spawn-1' }),
            userText('child-2-user', 'Second child prompt', 7, { isSidechain: true, sidechainKey: 'spawn-2' }),
            agentText('child-2-agent', 'Second child answer', 8, { isSidechain: true, sidechainKey: 'spawn-2' })
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlocks = reduced.blocks.filter(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

        expect(spawnBlocks).toHaveLength(2)
        expect(spawnBlocks.find((block) => block.tool.id === 'spawn-1')?.children).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'user-text', text: 'First child prompt' }),
                expect.objectContaining({ kind: 'agent-text', text: 'First child answer' })
            ])
        )
        expect(spawnBlocks.find((block) => block.tool.id === 'spawn-2')?.children).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'user-text', text: 'Second child prompt' }),
                expect.objectContaining({ kind: 'agent-text', text: 'Second child answer' })
            ])
        )
        expect(reduced.blocks.some((block) => block.kind === 'agent-text' && block.text === 'First child answer')).toBe(false)
        expect(reduced.blocks.some((block) => block.kind === 'agent-text' && block.text === 'Second child answer')).toBe(false)
    })

    it('folds multi-target Codex wait results into each matching spawn card', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1-call', 'spawn-1', 'CodexSpawnAgent', { message: 'First child prompt' }, 1),
            agentToolResult('spawn-1-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'First' }, 2),
            agentToolCall('spawn-2-call', 'spawn-2', 'CodexSpawnAgent', { message: 'Second child prompt' }, 3),
            agentToolResult('spawn-2-result', 'spawn-2', { agent_id: 'agent-2', nickname: 'Second' }, 4),
            agentToolCall('wait-call', 'wait-1', 'CodexWaitAgent', { targets: ['agent-1', 'agent-2'] }, 5),
            agentToolResult(
                'wait-result',
                'wait-1',
                JSON.stringify({
                    status: {
                        'agent-1': { completed: 'First child done' },
                        'agent-2': { completed: 'Second child done' }
                    },
                    timed_out: false
                }),
                6
            )
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlocks = reduced.blocks.filter(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

        expect(spawnBlocks).toHaveLength(2)
        expect(spawnBlocks.find((block) => block.tool.id === 'spawn-1')?.lifecycle).toEqual(
            expect.objectContaining({
                status: 'completed',
                latestText: 'First child done'
            })
        )
        expect(spawnBlocks.find((block) => block.tool.id === 'spawn-2')?.lifecycle).toEqual(
            expect.objectContaining({
                status: 'completed',
                latestText: 'Second child done'
            })
        )
        expect(reduced.blocks.some((block) => block.kind === 'tool-call' && block.tool.name === 'CodexWaitAgent')).toBe(false)
    })

    it('groups Claude sidechain messages by the Task tool call id, not the parent message id', () => {
        const messages: NormalizedMessage[] = [
            agentMessage('msg-parent', 1, [{
                type: 'tool-call',
                id: 'task-1',
                name: 'Task',
                input: { prompt: 'Investigate flaky test' },
                description: null,
                uuid: 'parent-uuid',
                parentUUID: null
            }]),
            {
                id: 'child-root',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: 'child-root-uuid',
                    parentUUID: null,
                    prompt: 'Investigate flaky test'
                }]
            },
            agentText('child-agent', 'child answer', 3, { isSidechain: true, sidechainKey: 'task-1' })
        ]

        const reduced = reduceChatBlocks(messages, null)
        const taskBlock = reduced.blocks.find(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.id === 'task-1'
        )

        expect(taskBlock?.children).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'agent-text', text: 'child answer' })
            ])
        )
    })
})
