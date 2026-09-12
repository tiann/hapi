import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { HappyUserMessage } from './UserMessage'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'

const auiState = {
    message: {
        role: 'user' as const,
        id: 'user-text:prompt',
        content: [{ type: 'text' as const, text: 'prompt' }],
        metadata: {
            custom: {
                kind: 'user' as const,
                status: 'sent' as HappyChatMessageMetadata['status'],
                invokedAt: undefined as number | null | undefined
            }
        }
    }
}

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
            <div {...props}>{children}</div>
        )
    },
    useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState)
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ({
        metadata: null,
        disabled: false,
        historyActionPending: false
    })
}))

vi.mock('@/components/AssistantChat/messages/MessageActions', () => ({
    MessageActions: () => null
}))

vi.mock('@/components/AssistantChat/messages/MessageStatusIndicator', () => ({
    MessageStatusIndicator: () => null
}))

vi.mock('@/components/AssistantChat/messages/MessageAttachments', () => ({
    MessageAttachments: () => null
}))

vi.mock('@/components/AssistantChat/messages/user-bubble', () => ({
    UserBubbleContent: () => null,
    getUserBubbleClassName: () => '',
    shouldShowMessageStatus: () => false
}))

vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: () => null
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('HappyUserMessage turn-input anchor', () => {
    it('keeps omitted invokedAt values eligible as already-invoked prompts', () => {
        const { container } = render(<HappyUserMessage />)

        expect(container.querySelector('[data-hapi-turn-input="true"]')).not.toBeNull()
    })

    it('does not mark queued messages as turn inputs', () => {
        auiState.message.metadata.custom = {
            kind: 'user',
            status: 'queued',
            invokedAt: null
        }

        const { container } = render(<HappyUserMessage />)

        expect(container.querySelector('[data-hapi-turn-input]')).toBeNull()
    })
})
