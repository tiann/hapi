import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsStoragePage from './storage'

const getSqliteStorageUsage = vi.fn().mockResolvedValue({
    path: 'C:\\hapi\\hapi.db',
    databaseBytes: 1,
    walBytes: 2,
    shmBytes: 3,
    totalBytes: 6,
})

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: { getSqliteStorageUsage } }),
}))

describe('SettingsStoragePage', () => {
    it('uses paired button theme colors for the refresh action and renders the pie chart', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsStoragePage />
                </I18nProvider>
            </QueryClientProvider>,
        )

        const refreshButton = screen.getByRole('button', { name: /refresh/i })
        expect(refreshButton).toHaveClass('bg-[var(--app-button)]')
        expect(refreshButton).toHaveClass('text-[var(--app-button-text)]')
        expect(refreshButton).not.toHaveClass('text-white')

        await waitFor(() => {
            expect(screen.getByRole('img', { name: /Relative share/i })).toBeInTheDocument()
        })

        const chart = screen.getByRole('img', { name: /Relative share/i })
        const details = screen.getByRole('heading', { name: /Exact sizes/i })
        expect(chart.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
})
