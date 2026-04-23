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

    it('keeps later Codex wait results on the root timeline after spawn nickname backfills', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1-call', 'spawn-1', 'CodexSpawnAgent', { message: 'First child prompt' }, 1),
            agentToolResult('spawn-1-result', 'spawn-1', { agent_id: 'agent-1', nickname: 'First' }, 2),
            agentToolCall('spawn-2-call', 'spawn-2', 'CodexSpawnAgent', { message: 'Second child prompt' }, 3),
            agentToolResult('spawn-2-result', 'spawn-2', { agent_id: 'agent-2', nickname: 'Second' }, 4),
            agentToolCall('wait-both-call', 'wait-both', 'CodexWaitAgent', { targets: ['agent-1', 'agent-2'] }, 5),
            agentToolResult('spawn-1-backfill', 'spawn-1', { agent_id: 'agent-1', nickname: 'First' }, 6),
            agentToolResult('spawn-2-backfill', 'spawn-2', { agent_id: 'agent-2', nickname: 'Second' }, 7),
            agentToolResult('wait-both-result', 'wait-both', { statuses: { 'agent-1': { status: 'completed', message: 'First child done' } } }, 8),
            agentToolCall('wait-second-call', 'wait-second', 'CodexWaitAgent', { targets: ['agent-2'] }, 9),
            agentToolResult('wait-second-result', 'wait-second', { statuses: { 'agent-2': { status: 'completed', message: 'Second child done' } } }, 10)
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlocks = reduced.blocks.filter(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

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
    })

    it('keeps each Codex spawn completed when multi-agent wait results arrive in separate chunks', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('spawn-1-call', 'spawn-1', 'CodexSpawnAgent', { message: 'First child prompt' }, 1),
            agentToolResult('spawn-1-result', 'spawn-1', { agent_id: 'agent-1' }, 2),
            agentToolCall('spawn-2-call', 'spawn-2', 'CodexSpawnAgent', { message: 'Second child prompt' }, 3),
            agentToolResult('spawn-2-result', 'spawn-2', { agent_id: 'agent-2' }, 4),
            agentToolCall('wait-both-call', 'wait-both', 'CodexWaitAgent', { targets: ['agent-1', 'agent-2'] }, 5),
            userText('child-2-user', 'Second child prompt', 6, { isSidechain: true, sidechainKey: 'spawn-2' }),
            userText('child-1-user', 'First child prompt', 7, { isSidechain: true, sidechainKey: 'spawn-1' }),
            agentToolResult('spawn-2-backfill', 'spawn-2', { agent_id: 'agent-2', nickname: 'Second' }, 8),
            agentToolResult('spawn-1-backfill', 'spawn-1', { agent_id: 'agent-1', nickname: 'First' }, 9),
            agentText('child-2-agent', 'Second child done', 10, { isSidechain: true, sidechainKey: 'spawn-2' }),
            agentToolResult('wait-both-result', 'wait-both', { statuses: { 'agent-2': { status: 'completed', message: 'Second child done' } } }, 11),
            agentText('child-1-stray', 'First child done', 12),
            agentToolCall('wait-first-call', 'wait-first', 'CodexWaitAgent', { targets: ['agent-1'] }, 13),
            agentToolResult('wait-first-result', 'wait-first', { statuses: { 'agent-1': { status: 'completed', message: 'First child done' } } }, 14),
            agentText('root-final', 'SUBAGENT_UI_OK', 15)
        ]

        const reduced = reduceChatBlocks(messages, null)
        const spawnBlocks = reduced.blocks.filter(
            (block): block is ToolCallBlock => block.kind === 'tool-call' && block.tool.name === 'CodexSpawnAgent'
        )

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

    it('suppresses Codex title tool calls from visible chat blocks', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('title-call', 'title-1', 'change_title', { title: 'Better Session Title' }, 1),
            agentToolResult('title-result', 'title-1', { ok: true }, 2)
        ]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).toEqual([])
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
