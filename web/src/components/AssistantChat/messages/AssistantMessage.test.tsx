import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'

const state = vi.hoisted(() => ({
    message: {
        role: 'assistant',
        id: 'assistant:m1',
        content: [{ type: 'text', text: 'answer' }],
        metadata: { custom: { kind: 'assistant', seq: 8 } }
    } as any
}))

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
        Content: () => <div>answer</div>
    },
    useAssistantState: (selector: (snapshot: { message: unknown }) => unknown) => selector({ message: state.message })
}))

vi.mock('@/components/assistant-ui/markdown-text', () => ({
    MarkdownText: ({ text }: { text: string }) => <span>{text}</span>
}))

vi.mock('@/components/assistant-ui/reasoning', () => ({
    Reasoning: ({ text }: { text: string }) => <span>{text}</span>,
    ReasoningGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

function renderAssistantMessage(onForkBeforeMessage?: (seq: number) => void) {
    return render(
        <HappyChatProvider
            value={{
                api: {} as never,
                sessionId: 's1',
                metadata: null,
                disabled: false,
                onRefresh: vi.fn(),
                onForkBeforeMessage
            }}
        >
            <HappyAssistantMessage />
        </HappyChatProvider>
    )
}

describe('HappyAssistantMessage fork action', () => {
    afterEach(() => {
        cleanup()
    })

    beforeEach(() => {
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn()
            }))
        })
        state.message = {
            role: 'assistant',
            id: 'assistant:m1',
            content: [{ type: 'text', text: 'answer' }],
            metadata: { custom: { kind: 'assistant', seq: 8 } }
        } as any
    })

    it('shows fork action for assistant responses with a seq', () => {
        const onForkBeforeMessage = vi.fn()
        renderAssistantMessage(onForkBeforeMessage)

        fireEvent.click(screen.getByTitle('Fork from this response'))

        expect(onForkBeforeMessage).toHaveBeenCalledWith(8)
    })

    it('does not show fork action for tool-only assistant messages', () => {
        state.message = {
            role: 'assistant',
            id: 'tool:m1',
            content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Tool', argsText: '{}' }],
            metadata: { custom: { kind: 'tool', toolCallId: 't1' } }
        } as any

        renderAssistantMessage(vi.fn())

        expect(screen.queryByTitle('Fork from this response')).toBeNull()
    })
})
