import { render, screen } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

const state = vi.hoisted(() => ({
    message: {
        role: 'user',
        id: 'user-text:__transcript-gap__601-801',
        content: [{ type: 'text', text: 'synthetic gap text' }],
        metadata: { custom: {} }
    }
}))

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
            <div {...props}>{children}</div>
        )
    },
    useAuiState: (selector: (value: typeof state) => unknown) => selector(state)
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ({ metadata: null, disabled: false })
}))

vi.mock('@/components/AssistantChat/messages/user-bubble', () => ({
    UserBubbleContent: ({ text }: { text: string }) => <span>{text}</span>,
    getUserBubbleClassName: () => '',
    shouldShowMessageStatus: () => false
}))

vi.mock('@/components/AssistantChat/messages/MessageActions', () => ({
    MessageActions: () => null
}))

import { HappyUserMessage } from './UserMessage'

describe('HappyUserMessage transcript gap', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'zh-CN'))

    it('renders a localized neutral boundary instead of a user bubble', () => {
        const { container } = render(
            <I18nProvider>
                <HappyUserMessage />
            </I18nProvider>
        )

        expect(screen.getByText('部分历史消息未加载')).toBeInTheDocument()
        expect(container.querySelector('[data-hapi-transcript-gap="true"]')).toBeInTheDocument()
        expect(container.querySelector('[data-hapi-message-role="user"]')).toBeNull()
        expect(screen.queryByText('synthetic gap text')).toBeNull()
    })
})
