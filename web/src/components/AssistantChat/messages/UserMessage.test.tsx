import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const harness = vi.hoisted(() => ({
    message: {
        role: 'user',
        metadata: { custom: { kind: 'user', status: 'sent', localId: 'local-1' } },
        content: [{ type: 'text', text: 'User says hello' }],
        createdAt: new Date(2026, 4, 18, 14, 13, 9)
    } as any
}))

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ className, children }: { className?: string; children: ReactNode }) => (
            <div data-testid="message-root" className={className}>{children}</div>
        )
    },
    useAssistantState: (selector: (state: { message: typeof harness.message }) => unknown) => selector({
        message: harness.message
    })
}))

vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text }: { text: string }) => <span>{text}</span>
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ({})
}))

vi.mock('@/components/AssistantChat/messages/MessageStatusIndicator', () => ({
    MessageStatusIndicator: () => <span data-testid="status-indicator" />
}))

vi.mock('@/components/AssistantChat/messages/MessageAttachments', () => ({
    MessageAttachments: () => null
}))

vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: () => null
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({
        copied: false,
        copy: vi.fn()
    })
}))

vi.mock('@/components/icons', () => ({
    CopyIcon: ({ className }: { className?: string }) => <span data-testid="copy-icon" className={className} />,
    CheckIcon: ({ className }: { className?: string }) => <span data-testid="check-icon" className={className} />
}))

import { HappyUserMessage } from './UserMessage'

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    harness.message = {
        role: 'user',
        metadata: { custom: { kind: 'user', status: 'sent', localId: 'local-1' } },
        content: [{ type: 'text', text: 'User says hello' }],
        createdAt: new Date(2026, 4, 18, 14, 13, 9)
    }
    vi.useRealTimers()
})

describe('HappyUserMessage timestamp', () => {
    it('renders the user message timestamp from createdAt', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 4, 18, 15, 0, 0))

        render(<HappyUserMessage />)

        expect(screen.getByText('User says hello')).toBeInTheDocument()
        const timestamp = screen.getByText('14:13')
        expect(timestamp.tagName).toBe('TIME')
        expect(timestamp).toHaveAttribute('title', '2026-05-18 14:13:09')
        expect(timestamp).toHaveAttribute('dateTime', new Date(2026, 4, 18, 14, 13, 9).toISOString())
    })
})
