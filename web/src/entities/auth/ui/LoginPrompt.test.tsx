import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoginPrompt } from './LoginPrompt'

// Mock the translation hook
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

describe('LoginPrompt', () => {
    const mockProps = {
        baseUrl: 'https://example.com',
        serverUrl: 'https://example.com',
        setServerUrl: vi.fn(),
        clearServerUrl: vi.fn(),
    }

    it('renders login form', () => {
        const { container } = render(<LoginPrompt {...mockProps} />)
        expect(container.querySelector('form')).toBeInTheDocument()
    })

    it('renders with error message', () => {
        render(<LoginPrompt {...mockProps} error="Invalid token" />)
        expect(screen.getByText('Invalid token')).toBeInTheDocument()
    })

    it('renders with server URL input', () => {
        const { container } = render(<LoginPrompt {...mockProps} requireServerUrl={true} />)
        expect(container.querySelector('form')).toBeInTheDocument()
    })
})
