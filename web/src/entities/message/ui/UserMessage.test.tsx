import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { HappyUserMessage } from './UserMessage'

// Create mock functions using vi.hoisted
const { mockUseAssistantState, mockUseHappyChatContext, mockGetHappyChatMetadata, mockGetMessageTextContent } = vi.hoisted(() => ({
    mockUseAssistantState: vi.fn(),
    mockUseHappyChatContext: vi.fn(),
    mockGetHappyChatMetadata: vi.fn(),
    mockGetMessageTextContent: vi.fn(),
}))

// Mock assistant-ui hooks
vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, className }: { children: React.ReactNode; className?: string }) => (
            <div className={className}>{children}</div>
        ),
    },
    useAssistantState: mockUseAssistantState,
}))

// Mock context
vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: mockUseHappyChatContext,
}))

// Mock components
vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text }: { text: string }) => <div data-testid="rainbow-text">{text}</div>,
}))

vi.mock('./MessageStatusIndicator', () => ({
    MessageStatusIndicator: ({ status, onRetry }: { status: string; onRetry?: () => void }) => (
        <div data-testid="status-indicator" data-status={status} onClick={onRetry}>
            {status}
        </div>
    ),
}))

vi.mock('./MessageAttachments', () => ({
    MessageAttachments: ({ attachments }: { attachments: unknown[] }) => (
        <div data-testid="attachments">Attachments: {attachments.length}</div>
    ),
}))

vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: ({ text }: { text: string }) => <div data-testid="cli-output">{text}</div>,
}))

// Mock helper functions
vi.mock('@/lib/assistant-runtime', () => ({
    getHappyChatMetadata: mockGetHappyChatMetadata,
    getMessageTextContent: mockGetMessageTextContent,
}))

describe('HappyUserMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetHappyChatMetadata.mockReturnValue(null)
        mockGetMessageTextContent.mockReturnValue('Hello')
        mockUseHappyChatContext.mockReturnValue({ onRetryMessage: vi.fn() })
    })

    afterEach(() => {
        cleanup()
    })

    it('renders user message text', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'user' }
            return selector({ message })
        })
        mockGetMessageTextContent.mockReturnValue('Hello world')

        render(<HappyUserMessage />)
        expect(screen.getByTestId('rainbow-text')).toHaveTextContent('Hello world')
    })

    it('renders CLI output message', () => {
        mockGetHappyChatMetadata.mockReturnValue({ kind: 'cli-output' })
        mockGetMessageTextContent.mockReturnValue('$ npm test')
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'user' }
            return selector({ message })
        })

        render(<HappyUserMessage />)
        expect(screen.getByTestId('cli-output')).toHaveTextContent('$ npm test')
    })

    it('renders message with attachments', () => {
        const mockAttachments = [
            { id: 'att-1', filename: 'test.txt', mimeType: 'text/plain', size: 100, path: '/uploads/test.txt' },
        ]

        mockGetHappyChatMetadata.mockReturnValue({ attachments: mockAttachments })
        mockGetMessageTextContent.mockReturnValue('Check this file')
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'user' }
            return selector({ message })
        })

        render(<HappyUserMessage />)
        expect(screen.getByTestId('attachments')).toHaveTextContent('Attachments: 1')
    })

    it('renders status indicator for sending message', () => {
        mockGetHappyChatMetadata.mockReturnValue({ status: 'sending' })
        mockGetMessageTextContent.mockReturnValue('Sending...')
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'user' }
            return selector({ message })
        })

        render(<HappyUserMessage />)
        expect(screen.getByTestId('status-indicator')).toHaveAttribute('data-status', 'sending')
    })

    it('renders retry button for failed message', () => {
        const mockRetry = vi.fn()
        mockUseHappyChatContext.mockReturnValue({ onRetryMessage: mockRetry })
        mockGetHappyChatMetadata.mockReturnValue({ status: 'failed', localId: 'local-123' })
        mockGetMessageTextContent.mockReturnValue('Failed message')
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'user' }
            return selector({ message })
        })

        render(<HappyUserMessage />)
        const statusIndicators = screen.getAllByTestId('status-indicator')
        const failedIndicator = statusIndicators.find(el => el.getAttribute('data-status') === 'failed')
        expect(failedIndicator).toBeDefined()
        failedIndicator?.click()

        expect(mockRetry).toHaveBeenCalledWith('local-123')
    })

    it('returns null for non-user messages', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'assistant' }
            return selector({ message })
        })

        const { container } = render(<HappyUserMessage />)
        expect(container.firstChild).toBeNull()
    })
})
