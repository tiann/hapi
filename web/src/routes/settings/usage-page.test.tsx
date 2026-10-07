import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UsageSummaryResponse } from '@hapi/protocol/apiTypes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsUsagePage from './usage'

const { getUsageSummary } = vi.hoisted(() => ({
    getUsageSummary: vi.fn(),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: { getUsageSummary } }),
}))

const summary: UsageSummaryResponse = {
    range: { from: null, to: 0 },
    totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        uncachedTokens: 0,
        requests: 0,
        sessions: 1,
        costs: [{ amount: 2.5, currency: 'USD' }]
    },
    daily: [],
    byAgent: [],
    byModel: [],
    agents: [],
    updatedAt: 0
}

describe('SettingsUsagePage', () => {
    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem('hapi-lang', 'zh-CN')
        getUsageSummary.mockResolvedValue(summary)
    })

    it('formats costs with the selected app locale instead of the browser locale', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsUsagePage />
                </I18nProvider>
            </QueryClientProvider>,
        )

        await waitFor(() => {
            expect(screen.getByText('US$2.50')).toBeInTheDocument()
        })
        expect(screen.queryByText('$2.50')).not.toBeInTheDocument()
    })
})
