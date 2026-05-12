import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import type { ToolCallBlock } from '@/chat/types'

vi.mock('@/components/ToolCard/ToolCard', () => ({
    ToolCard: ({ block }: { block: ToolCallBlock }) => (
        <div data-testid="tool-card">{block.tool.name}</div>
    )
}))

vi.mock('@/components/CodeBlock', () => ({
    CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: ({ text }: { text: string }) => <pre>{text}</pre>
}))

const baseContext: HappyChatContextValue = {
    api: {} as HappyChatContextValue['api'],
    sessionId: 'session-1',
    metadata: null,
    terminalToolDisplayMode: 'compact',
    disabled: false,
    onRefresh: () => {},
    hasMoreMessages: false,
    isLoadingMoreMessages: false,
    loadOlderMessagesPreservingScroll: vi.fn(async () => false),
}

function renderToolMessage(props: Parameters<typeof HappyToolMessage>[0]) {
    return render(
        <HappyChatProvider value={baseContext}>
            <HappyToolMessage {...props} />
        </HappyChatProvider>
    )
}

function makeToolMessageProps(
    overrides: Partial<Parameters<typeof HappyToolMessage>[0]>
): Parameters<typeof HappyToolMessage>[0] {
    return {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        args: {},
        argsText: '{}',
        status: { type: 'complete' },
        addResult: () => {},
        resume: () => {},
        ...overrides,
    }
}

function makeToolBlock(toolName: string): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        tool: {
            id: 'tool-1',
            name: toolName,
            input: { command: 'Get-ChildItem -Force' },
            description: '执行 5',
            state: 'completed',
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            result: null,
        },
        children: []
    }
}

describe('HappyToolMessage', () => {
    it('renders tool-call artifacts through ToolCard', () => {
        renderToolMessage(makeToolMessageProps({
            artifact: makeToolBlock('Read'),
        }))

        expect(screen.getByTestId('tool-card')).toHaveTextContent('Read')
        expect(screen.queryByText(/^Tool:/)).not.toBeInTheDocument()
    })

    it('uses aggregate background in the raw fallback when the title is already aggregated', () => {
        const { container } = renderToolMessage(makeToolMessageProps({
            toolCallId: 'tool-agg',
            toolName: '检查项目文件 等 +4',
        }))

        const card = container.querySelector('.overflow-hidden.rounded-\\[20px\\]') as HTMLDivElement | null
        expect(card).not.toBeNull()
        expect(card?.className).toContain('bg-[var(--app-tool-card-aggregate-bg)]')
    })
})
