import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { HappyAssistantMessage } from './AssistantMessage'

// Create mock functions using vi.hoisted
const { mockUseAssistantState, mockGetHappyChatMetadata, mockGetMessageTextContent } = vi.hoisted(() => ({
    mockUseAssistantState: vi.fn(),
    mockGetHappyChatMetadata: vi.fn(),
    mockGetMessageTextContent: vi.fn(),
}))

// Mock assistant-ui hooks
vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, className }: { children: React.ReactNode; className?: string }) => (
            <div className={className}>{children}</div>
        ),
        Content: ({ components }: { components?: unknown }) => (
            <div data-testid="message-content">Content</div>
        ),
    },
    useAssistantState: mockUseAssistantState,
}))

// Mock other components
vi.mock('@/components/assistant-ui/markdown-text', () => ({
    MarkdownText: () => <div>MarkdownText</div>,
}))

vi.mock('@/components/assistant-ui/reasoning', () => ({
    Reasoning: () => <div>Reasoning</div>,
    ReasoningGroup: () => <div>ReasoningGroup</div>,
}))

vi.mock('./ToolMessage', () => ({
    HappyToolMessage: () => <div>ToolMessage</div>,
}))

vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: ({ text }: { text: string }) => <div data-testid="cli-output">{text}</div>,
}))

vi.mock('@/lib/assistant-runtime', () => ({
    getHappyChatMetadata: mockGetHappyChatMetadata,
    getMessageTextContent: mockGetMessageTextContent,
}))

describe('HappyAssistantMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetHappyChatMetadata.mockReturnValue(null)
        mockGetMessageTextContent.mockReturnValue('')
    })

    it('renders regular assistant message', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
            return selector({ message })
        })

        const { getByTestId } = render(<HappyAssistantMessage />)
        expect(getByTestId('message-content')).toBeInTheDocument()
    })

    it('renders CLI output message', () => {
        mockGetHappyChatMetadata.mockReturnValue({ kind: 'cli-output' })
        mockGetMessageTextContent.mockReturnValue('$ ls -la')
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'assistant', content: [] }
            return selector({ message })
        })

        const { getByTestId } = render(<HappyAssistantMessage />)
        expect(getByTestId('cli-output')).toBeInTheDocument()
        expect(getByTestId('cli-output')).toHaveTextContent('$ ls -la')
    })

    it('applies tool-only styling', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'assistant', content: [{ type: 'tool-call' }] }
            return selector({ message })
        })

        const { container } = render(<HappyAssistantMessage />)
        const root = container.firstChild as HTMLElement
        expect(root.className).toContain('py-1')
    })

    it('applies regular styling for mixed content', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'assistant', content: [{ type: 'text' }, { type: 'tool-call' }] }
            return selector({ message })
        })

        const { container } = render(<HappyAssistantMessage />)
        const root = container.firstChild as HTMLElement
        expect(root.className).toContain('px-1')
    })
})
