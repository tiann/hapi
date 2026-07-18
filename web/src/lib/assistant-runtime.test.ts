import { describe, expect, it } from 'vitest'
import { AGENT_ATTACHMENTS_DATA_PART_NAME, toThreadMessageLike } from './assistant-runtime'
import type {
    AgentAttachmentBlock,
    AgentEventBlock,
    MoaReferenceBlock,
    AgentReasoningBlock,
    AgentTextBlock,
    CliOutputBlock,
    ToolCallBlock,
    UserTextBlock,
} from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGrouping'

const createdAt = 1_700_000_000_000
const displayTimestamp = 1_700_000_030_000

function makeToolCallBlock(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt,
        displayTimestamp,
        tool: {
            id: 'tool-1',
            name: 'Read',
            state: 'completed',
            input: { file: 'README.md' },
            createdAt,
            startedAt: createdAt,
            completedAt: displayTimestamp,
            description: null,
            result: { ok: true },
        },
        children: [],
        meta: undefined,
        ...overrides,
    }
}

describe('toThreadMessageLike', () => {
    it('marks assistant text timestamps as completion-based', () => {
        const block: AgentTextBlock = {
            kind: 'agent-text',
            id: 'agent-1:0',
            localId: null,
            createdAt,
            displayTimestamp,
            text: 'Final reply',
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.createdAt).toEqual(new Date(createdAt))
        expect(message.metadata?.custom).toMatchObject({
            kind: 'assistant',
            timestampSource: 'completion',
            timestampAt: displayTimestamp
        })
    })

    it('records null completion timestamp metadata when assistant text has no display timestamp', () => {
        const block: AgentTextBlock = {
            kind: 'agent-text',
            id: 'agent-1:0',
            localId: null,
            createdAt,
            text: 'Streaming reply',
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.metadata?.custom).toMatchObject({
            kind: 'assistant',
            timestampSource: 'completion',
            timestampAt: null
        })
    })

    it('marks assistant reasoning timestamps as completion-based', () => {
        const block: AgentReasoningBlock = {
            kind: 'agent-reasoning',
            id: 'reasoning-1:0',
            localId: null,
            createdAt,
            displayTimestamp,
            text: 'Thinking',
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.content).toEqual([{ type: 'reasoning', text: 'Thinking' }])
        expect(message.metadata?.custom).toMatchObject({
            kind: 'assistant',
            timestampSource: 'completion',
            timestampAt: displayTimestamp
        })
    })

    it('converts MoA reference blocks to a dedicated data part with completion timestamp metadata', () => {
        const block: MoaReferenceBlock = {
            kind: 'moa-reference',
            id: 'moa-ref-1:0',
            localId: null,
            createdAt,
            displayTimestamp,
            label: 'openai-codex:gpt-5.5',
            text: 'Reference answer',
            index: 1,
            count: 3,
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.content).toEqual([{
            type: 'data',
            name: 'hapi-moa-reference',
            data: {
                label: 'openai-codex:gpt-5.5',
                text: 'Reference answer',
                index: 1,
                count: 3
            }
        }])
        expect(message.metadata?.custom).toMatchObject({
            kind: 'moa-reference',
            timestampSource: 'completion',
            timestampAt: displayTimestamp
        })
    })

    it('converts assistant attachments to a data part while preserving metadata and completion timestamp', () => {
        const attachments = [{ id: 'file-1', filename: 'chart.png', mimeType: 'image/png', size: 123, path: '/tmp/chart.png' }]
        const block: AgentAttachmentBlock = {
            kind: 'agent-attachments',
            id: 'attachments-1:0',
            localId: 'local-attachment-1',
            createdAt,
            displayTimestamp,
            attachments,
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.content).toEqual([{
            type: 'data',
            name: AGENT_ATTACHMENTS_DATA_PART_NAME,
            data: { attachments }
        }])
        expect(message.metadata?.custom).toMatchObject({
            kind: 'assistant',
            localId: 'local-attachment-1',
            attachments,
            timestampSource: 'completion',
            timestampAt: displayTimestamp
        })
    })

    it('marks assistant CLI output timestamps as completion-based', () => {
        const block: CliOutputBlock = {
            kind: 'cli-output',
            id: 'cli-1',
            localId: null,
            createdAt,
            displayTimestamp,
            text: 'assistant output',
            source: 'assistant',
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.role).toBe('assistant')
        expect(message.metadata?.custom).toMatchObject({
            kind: 'cli-output',
            source: 'assistant',
            timestampSource: 'completion',
            timestampAt: displayTimestamp
        })
    })

    it('does not add completion timestamp metadata to user CLI output', () => {
        const block: CliOutputBlock = {
            kind: 'cli-output',
            id: 'cli-2',
            localId: null,
            createdAt,
            displayTimestamp,
            text: 'user output',
            source: 'user',
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.role).toBe('user')
        expect(message.metadata?.custom).toMatchObject({ kind: 'cli-output', source: 'user' })
        expect(message.metadata?.custom).not.toHaveProperty('timestampSource')
        expect(message.metadata?.custom).not.toHaveProperty('timestampAt')
    })

    it('marks single tool-call timestamps as completion-based', () => {
        const message = toThreadMessageLike(makeToolCallBlock())

        expect(message.metadata?.custom).toMatchObject({
            kind: 'tool',
            toolCallId: 'tool-1',
            timestampSource: 'completion',
            timestampAt: displayTimestamp
        })
    })

    it('marks tool-group timestamps as completion-based', () => {
        const block: ToolGroupBlock = {
            kind: 'tool-group',
            id: 'tool-group:tool-1',
            localId: null,
            createdAt,
            displayTimestamp,
            tools: [makeToolCallBlock()]
        }

        const message = toThreadMessageLike(block)

        expect(message.metadata?.custom).toMatchObject({
            kind: 'tool-group',
            toolCallId: 'tool-group:tool-1',
            timestampSource: 'completion',
            timestampAt: displayTimestamp
        })
    })

    it('does not add completion timestamp metadata to user text', () => {
        const block: UserTextBlock = {
            kind: 'user-text',
            id: 'user-1',
            localId: 'local-user-1',
            createdAt,
            text: 'hello',
            status: 'sent',
            originalText: 'hello',
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.metadata?.custom).toMatchObject({ kind: 'user' })
        expect(message.metadata?.custom).not.toHaveProperty('timestampSource')
        expect(message.metadata?.custom).not.toHaveProperty('timestampAt')
    })

    it('does not add completion timestamp metadata to agent events', () => {
        const block: AgentEventBlock = {
            kind: 'agent-event',
            id: 'event-1',
            createdAt,
            event: { type: 'ready' },
            meta: undefined
        }

        const message = toThreadMessageLike(block)

        expect(message.metadata?.custom).toMatchObject({ kind: 'event', event: { type: 'ready' } })
        expect(message.metadata?.custom).not.toHaveProperty('timestampSource')
        expect(message.metadata?.custom).not.toHaveProperty('timestampAt')
    })
})
