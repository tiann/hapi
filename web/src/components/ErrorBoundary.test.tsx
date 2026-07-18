import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function BrokenChild(): ReactElement {
    throw new Error('boom')
}

describe('ErrorBoundary', () => {
    it('shows a recovery screen when a child render throws', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        try {
            render(
                <ErrorBoundary>
                    <BrokenChild />
                </ErrorBoundary>
            )

            expect(screen.getByText('Something went wrong')).toBeInTheDocument()
            expect(screen.getByText(/Reloading usually restores/)).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Reload app' })).toBeInTheDocument()
        } finally {
            errorSpy.mockRestore()
        }
    })
})
