import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_USAGE_QUERY_TEMPLATE } from '@hapi/protocol/usageQuery'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

function renderWithQueries(ui: ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('StatusBar Runner quota details', () => {
    it('queries only after opening ctx and renders sanitized 5H/7D windows', async () => {
        const getSettings = vi.fn().mockResolvedValue({
            agent: 'claude',
            enabled: true,
            templateId: DEFAULT_USAGE_QUERY_TEMPLATE.id,
            template: DEFAULT_USAGE_QUERY_TEMPLATE,
            credentials: {
                baseUrl: { configured: true, source: 'config' },
                apiKey: { configured: true, source: 'config' }
            }
        })
        const queryUsage = vi.fn().mockResolvedValue({
            agent: 'claude',
            templateId: DEFAULT_USAGE_QUERY_TEMPLATE.id,
            status: 'success',
            fiveHour: { usedPercent: 42, resetsAt: Date.now() + 3_600_000 },
            sevenDay: { usedPercent: 18, resetsAt: Date.now() + 2 * 86_400_000 },
            queriedAt: Date.now(),
            stale: false
        })
        const api = { getMachineUsageQuerySettings: getSettings, queryMachineUsage: queryUsage } as unknown as ApiClient

        renderWithQueries(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    agentFlavor="claude"
                    contextSize={90_000}
                    contextWindow={258_000}
                    usageQueryApi={api}
                    usageQueryMachineId="machine-1"
                />
            </I18nProvider>
        )

        expect(getSettings).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Context popover' }))

        const quota = await screen.findByText('Quota:')
        expect(quota).toBeInTheDocument()
        expect(quota.parentElement).toHaveClass('mt-1', 'border-t', 'pt-2')
        expect(screen.getByText('5H')).not.toHaveClass('font-semibold')
        expect(screen.getByText('42%')).toHaveClass('text-right')
        expect(screen.getByText('42%')).not.toHaveClass('font-semibold', 'text-[var(--app-hint)]')
        expect(screen.getByText('42%')).toBeInTheDocument()
        expect(screen.getByText('18%')).toBeInTheDocument()
        expect(getSettings).toHaveBeenCalledTimes(1)
        expect(queryUsage).toHaveBeenCalledTimes(1)
    })
})
