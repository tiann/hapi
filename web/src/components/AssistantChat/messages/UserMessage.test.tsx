import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'

const state = vi.hoisted(() => ({
    message: {
        role: 'user',
        id: 'user:m1',
        content: [{ type: 'text', text: 'hello' }],
        metadata: { custom: { kind: 'user', seq: 7, localId: null } }
    } as any
}))

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>
    },
    useAssistantState: (selector: (snapshot: { message: unknown }) => unknown) => selector({ message: state.message })
}))

vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text }: { text: string }) => <span>{text}</span>
}))

function renderUserMessage(onForkBeforeMessage?: (seq: number) => void) {
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
            <HappyUserMessage />
        </HappyChatProvider>
    )
}

describe('HappyUserMessage fork action', () => {
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
            role: 'user',
            id: 'user:m1',
            content: [{ type: 'text', text: 'hello' }],
            metadata: { custom: { kind: 'user', seq: 7, localId: null } }
        } as any
    })

    it('does not show fork action for user messages with a seq', () => {
        const onForkBeforeMessage = vi.fn()
        renderUserMessage(onForkBeforeMessage)

        expect(screen.queryByTitle('Fork from this response')).toBeNull()
        expect(onForkBeforeMessage).not.toHaveBeenCalled()
    })

    it('does not show fork action for non-user messages', () => {
        state.message = {
            role: 'assistant',
            id: 'assistant:m1',
            content: [{ type: 'text', text: 'answer' }],
            metadata: { custom: { kind: 'assistant' } }
        }

        renderUserMessage(vi.fn())

        expect(screen.queryByTitle('Fork from this response')).toBeNull()
    })
})
