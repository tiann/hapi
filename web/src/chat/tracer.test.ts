import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage } from './types'

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

function sidechainMessage(
    id: string,
    text: string,
    createdAt: number
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: true,
        content: [{
            type: 'sidechain',
            uuid: `${id}-uuid`,
            prompt: text
        }]
    }
}

function sidechainText(
    id: string,
    text: string,
    createdAt: number
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: true,
        content: [{
            type: 'text',
            text,
            uuid: `${id}-uuid`,
            parentUUID: null
        }]
    }
}

function sidechainTextWithParent(
    id: string,
    text: string,
    createdAt: number,
    parentUUID: string
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: true,
        content: [{
            type: 'text',
            text,
            uuid: `${id}-uuid`,
            parentUUID
        }]
    }
}

describe('traceMessages sidechain fallback', () => {
    it('does not attach ambiguous duplicate Task prompts to the later task', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('msg-task-1', 'task-1', 'Task', { prompt: 'Investigate flaky test' }, 1),
            agentToolCall('msg-task-2', 'task-2', 'Task', { prompt: 'Investigate flaky test' }, 2),
            sidechainMessage('msg-root', 'Investigate flaky test', 3),
            sidechainText('msg-child-user', 'child prompt', 4),
            sidechainText('msg-child-agent', 'child answer', 5)
        ]

        const reduced = reduceChatBlocks(messages, null)
        const task1 = reduced.blocks.find((block): block is Extract<(typeof reduced.blocks)[number], { kind: 'tool-call' }> => block.kind === 'tool-call' && block.tool.id === 'task-1')
        const task2 = reduced.blocks.find((block): block is Extract<(typeof reduced.blocks)[number], { kind: 'tool-call' }> => block.kind === 'tool-call' && block.tool.id === 'task-2')

        expect(task1?.children).toHaveLength(0)
        expect(task2?.children).toHaveLength(0)
        expect(reduced.blocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'agent-text', text: 'child prompt' }),
                expect.objectContaining({ kind: 'agent-text', text: 'child answer' })
            ])
        )
    })

    it('keeps ambiguous unresolved sidechain descendants visible at the root level', () => {
        const messages: NormalizedMessage[] = [
            agentToolCall('msg-task-1', 'task-1', 'Task', { prompt: 'Investigate flaky test' }, 1),
            agentToolCall('msg-task-2', 'task-2', 'Task', { prompt: 'Investigate flaky test' }, 2),
            sidechainMessage('msg-root', 'Investigate flaky test', 3),
            sidechainTextWithParent('msg-child-user', 'child prompt', 4, 'msg-root-uuid'),
            sidechainTextWithParent('msg-child-agent', 'child answer', 5, 'msg-child-user-uuid')
        ]

        const reduced = reduceChatBlocks(messages, null)
        const task1 = reduced.blocks.find((block): block is Extract<(typeof reduced.blocks)[number], { kind: 'tool-call' }> => block.kind === 'tool-call' && block.tool.id === 'task-1')
        const task2 = reduced.blocks.find((block): block is Extract<(typeof reduced.blocks)[number], { kind: 'tool-call' }> => block.kind === 'tool-call' && block.tool.id === 'task-2')

        expect(task1?.children).toHaveLength(0)
        expect(task2?.children).toHaveLength(0)
        expect(reduced.blocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'agent-text', text: 'child prompt' }),
                expect.objectContaining({ kind: 'agent-text', text: 'child answer' })
            ])
        )
    })
})
