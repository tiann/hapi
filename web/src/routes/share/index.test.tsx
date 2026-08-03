import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SharePage from './index'

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useSearch: () => ({}),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} }),
}))

vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions: [], isLoading: false }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

describe('SharePage', () => {
    it('uses paired button theme colors for the missing-share action', async () => {
        render(<SharePage />)

        const backButton = await screen.findByRole('button', { name: 'share.backToSessions' })
        expect(backButton).toHaveClass('bg-[var(--app-button)]')
        expect(backButton).toHaveClass('text-[var(--app-button-text)]')
        expect(backButton).not.toHaveClass('text-white')
    })
})
