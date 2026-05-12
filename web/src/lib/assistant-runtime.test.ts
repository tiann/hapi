import { describe, expect, it } from 'vitest'
import type { ToolCallMessagePart } from '@assistant-ui/react'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { toThreadMessageLike } from '@/lib/assistant-runtime'

// Resolve from the published package entry instead of assuming a specific
// workspace node_modules layout.
const assistantEntryUrl = import.meta.resolve('@assistant-ui/react')
const { convertExternalMessages } = await import(
    new URL('./legacy-runtime/runtime-cores/external-store/external-message-converter.js', assistantEntryUrl).href
) as {
    convertExternalMessages: <T extends object>(
        messages: T[],
        callback: (message: T, metadata: unknown) => unknown,
        isRunning: boolean,
        metadata: Record<string, unknown>
    ) => Array<{ content: unknown[] }>
}

function makeToolBlock(id: string, toolName: string): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1_700_000_000_000,
        tool: {
            id,
            name: toolName,
            state: 'completed',
            input: toolName === 'Bash' ? { command: 'ls -la' } : { file_path: 'README.md' },
            createdAt: 1_700_000_000_000,
            startedAt: 1_700_000_000_100,
            completedAt: 1_700_000_000_200,
            description: toolName === 'Bash' ? '执行 1' : '读取 1',
            result: null,
        },
        children: []
    }
}

function getToolParts(message: { content: unknown[] }): ToolCallMessagePart[] {
    return message.content.filter((part: unknown): part is ToolCallMessagePart => (
        typeof part === 'object'
        && part !== null
        && 'type' in part
        && (part as { type?: unknown }).type === 'tool-call'
    ))
}

describe('assistant runtime tool-call conversion', () => {
    it('keeps a single tool block artifact as the original ToolCallBlock', () => {
        const block = makeToolBlock('tool-1', 'Read')
        const message = toThreadMessageLike(block)

        expect(message.role).toBe('assistant')
        expect(typeof message.content).toBe('object')

        const toolPart = (message.content as ToolCallMessagePart[])[0]
        expect(toolPart.toolCallId).toBe('tool-1')
        expect(toolPart.artifact).toBe(block)
        expect((toolPart.artifact as ToolCallBlock).kind).toBe('tool-call')
    })

    it('joins consecutive tool blocks into one assistant message while preserving per-part tool artifacts', () => {
        const first = makeToolBlock('tool-1', 'Bash')
        const second = makeToolBlock('tool-2', 'Read')

        const messages = convertExternalMessages(
            [first, second],
            (block: ChatBlock) => toThreadMessageLike(block),
            false,
            {}
        )

        expect(messages).toHaveLength(1)

        const toolParts = getToolParts(messages[0]!)
        expect(toolParts).toHaveLength(2)
        expect(toolParts.map((part) => part.toolCallId)).toEqual(['tool-1', 'tool-2'])
        expect(toolParts.map((part) => (part.artifact as ToolCallBlock).kind)).toEqual(['tool-call', 'tool-call'])
        expect(toolParts[0]?.artifact).toBe(first)
        expect(toolParts[1]?.artifact).toBe(second)
    })

    it('does not synthesize a tool-group artifact when assistant-ui groups consecutive tool-call parts', () => {
        const first = makeToolBlock('tool-1', 'Bash')
        const second = makeToolBlock('tool-2', 'Read')

        const messages = convertExternalMessages(
            [first, second],
            (block: ChatBlock) => toThreadMessageLike(block),
            false,
            {}
        )

        const toolParts = getToolParts(messages[0]!)
        const artifactKinds = toolParts.map((part) => (part.artifact as { kind?: string } | undefined)?.kind ?? null)

        expect(artifactKinds).not.toContain('tool-group')
        expect(artifactKinds).toEqual(['tool-call', 'tool-call'])
    })
})
