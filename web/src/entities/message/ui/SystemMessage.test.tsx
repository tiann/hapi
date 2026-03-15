import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HappySystemMessage } from './SystemMessage'

// Create mock functions using vi.hoisted
const { mockUseAssistantState, mockGetHappyChatMetadata, mockGetMessageTextContent, mockGetEventPresentation } = vi.hoisted(() => ({
    mockUseAssistantState: vi.fn(),
    mockGetHappyChatMetadata: vi.fn(),
    mockGetMessageTextContent: vi.fn(),
    mockGetEventPresentation: vi.fn(),
}))

// Mock assistant-ui hooks
vi.mock('@assistant-ui/react', () => ({
    useAssistantState: mockUseAssistantState,
}))

// Mock helper functions
vi.mock('@/lib/assistant-runtime', () => ({
    getHappyChatMetadata: mockGetHappyChatMetadata,
    getMessageTextContent: mockGetMessageTextContent,
}))

vi.mock('@/chat/presentation', () => ({
    getEventPresentation: mockGetEventPresentation,
}))

describe('HappySystemMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetHappyChatMetadata.mockReturnValue(null)
        mockGetEventPresentation.mockReturnValue({ icon: '🔔', label: 'event' })
    })

    it('renders system message', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'system' }
            return selector({ message })
        })
        mockGetMessageTextContent.mockReturnValue('System notification')

        render(<HappySystemMessage />)
        expect(screen.getByText('System notification')).toBeInTheDocument()
    })

    it('renders system message with event icon', () => {
        mockGetHappyChatMetadata.mockReturnValue({
            kind: 'event',
            event: 'session-started',
        })
        mockGetMessageTextContent.mockReturnValue('Session started')
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'system' }
            return selector({ message })
        })

        render(<HappySystemMessage />)
        expect(screen.getByText('Session started')).toBeInTheDocument()
        expect(screen.getByText('🔔')).toBeInTheDocument()
    })

    it('returns null for non-system messages', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'user' }
            return selector({ message })
        })

        const { container } = render(<HappySystemMessage />)
        expect(container.firstChild).toBeNull()
    })

    it('applies correct styling', () => {
        mockUseAssistantState.mockImplementation((selector) => {
            const message = { role: 'system' }
            return selector({ message })
        })
        mockGetMessageTextContent.mockReturnValue('Test message')

        const { container } = render(<HappySystemMessage />)
        const wrapper = container.querySelector('.py-1')
        expect(wrapper).toBeInTheDocument()

        const textElement = container.querySelector('.text-xs')
        expect(textElement).toBeInTheDocument()
    })
})
