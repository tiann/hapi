import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentQuotaBucket, AgentQuotasResponse } from '@hapi/protocol/apiTypes'
import { I18nProvider } from '@/lib/i18n-context'
import {
    AgentQuotaStatus,
    formatCompactCountdown,
    formatLongCountdown,
    selectComposerQuotaBuckets
} from './AgentQuotaStatus'

const getMachineAgentQuotasMock = vi.fn<(machineId: string) => Promise<AgentQuotasResponse>>()

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: { getMachineAgentQuotas: getMachineAgentQuotasMock },
        token: 't',
        baseUrl: 'http://localhost'
    })
}))

function bucket(overrides: Partial<AgentQuotaBucket> & Pick<AgentQuotaBucket, 'id'>): AgentQuotaBucket {
    return {
        label: overrides.id,
        group: null,
        window: null,
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: null,
        ...overrides
    }
}

const response: AgentQuotasResponse = {
    fetchedAt: 0,
    accounts: [
        {
            agent: 'claude',
            available: true,
            status: 'ok',
            buckets: [
                bucket({ id: 'claude-seven_day', label: 'Weekly (7d)', window: 'weekly', usedPercent: 40.4, remainingPercent: 59.6 }),
                bucket({ id: 'claude-five_hour', label: '5h window', window: '5h', usedPercent: 12, remainingPercent: 88 }),
                bucket({ id: 'claude-seven_day_opus', window: 'seven_day_opus', usedPercent: 99, remainingPercent: 1 })
            ],
            updatedAt: 0
        },
        {
            agent: 'codex',
            available: true,
            status: 'ok',
            buckets: [
                bucket({ id: 'gpt-primary', group: 'GPT-5 Pro', window: '5h', usedPercent: 70, remainingPercent: 30 }),
                bucket({ id: 'codex-primary', label: 'Weekly (7d)', window: 'weekly', usedPercent: 21, remainingPercent: 79 })
            ],
            updatedAt: 0
        },
        { agent: 'agy', available: false, status: 'unavailable', buckets: [], updatedAt: 0 }
    ]
}

describe('selectComposerQuotaBuckets', () => {
    it('picks the ungrouped 5h then weekly windows of the session agent', () => {
        expect(selectComposerQuotaBuckets(response, 'claude').map((b) => b.id))
            .toEqual(['claude-five_hour', 'claude-seven_day'])
        expect(selectComposerQuotaBuckets(response, 'codex').map((b) => b.id))
            .toEqual(['codex-primary'])
    })

    it('returns nothing for agents without an ok account', () => {
        expect(selectComposerQuotaBuckets(response, 'agy')).toEqual([])
        expect(selectComposerQuotaBuckets(response, 'pi')).toEqual([])
        expect(selectComposerQuotaBuckets(response, null)).toEqual([])
        expect(selectComposerQuotaBuckets(undefined, 'claude')).toEqual([])
    })
})

describe('quota countdown formatting', () => {
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour

    it('keeps the two most significant units and drops a zero tail', () => {
        expect(formatCompactCountdown(2 * day + 14 * hour + 5 * minute)).toBe('2d14h')
        expect(formatCompactCountdown(2 * hour + 13 * minute)).toBe('2h13m')
        expect(formatCompactCountdown(3 * hour)).toBe('3h')
        expect(formatCompactCountdown(35 * minute)).toBe('35m')
        expect(formatCompactCountdown(10_000)).toBe('1m')
    })

    it('spells units out per locale', () => {
        expect(formatLongCountdown(2 * day + 14 * hour, 'zh-CN')).toBe('2天14小时')
        expect(formatLongCountdown(35 * minute, 'zh-CN')).toBe('35分钟')
        expect(formatLongCountdown(2 * day + 14 * hour, 'en')).toBe('2 days 14 hours')
        expect(formatLongCountdown(1 * hour + 1 * minute, 'en')).toBe('1 hour 1 minute')
    })
})

describe('AgentQuotaStatus', () => {
    afterEach(() => {
        cleanup()
        getMachineAgentQuotasMock.mockReset()
    })

    function renderStatus(agentFlavor: string, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
        return render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <AgentQuotaStatus machineId="machine-1" agentFlavor={agentFlavor} />
                </I18nProvider>
            </QueryClientProvider>
        )
    }

    it('shows used percent for the 5h and weekly windows of the session machine', async () => {
        getMachineAgentQuotasMock.mockResolvedValue(response)
        renderStatus('claude')
        const chip = await screen.findByRole('button', { name: '5h 12% · 7d 40%' })
        expect(getMachineAgentQuotasMock).toHaveBeenCalledWith('machine-1')
        // Narrow screens keep only the 5h window on the chip; 7d is sm+ only.
        expect(screen.getByText('5h 12%').className).toBe('')
        expect(chip.textContent).toContain('7d 40%')
        // Too-narrow rows clip the chip instead of letting it overlap neighbouring labels.
        expect(chip.className).toContain('overflow-x-clip')
        // ...and it, not the context meter, absorbs the shrinking.
        expect(chip.className).toContain('shrink-[1000]')
        expect(screen.getByText(/7d 40%/, { selector: 'span.hidden' }).className).toContain('sm:inline')
    })

    it('shows used percent with a reset countdown, and a readable reset time in the popover', async () => {
        const now = Date.now()
        getMachineAgentQuotasMock.mockResolvedValue({
            fetchedAt: now,
            accounts: [{
                agent: 'claude',
                available: true,
                status: 'ok',
                buckets: [
                    bucket({ id: 'claude-five_hour', label: '5h window', window: '5h', usedPercent: 12, remainingPercent: 88, resetsAt: now + 35 * 60_000 + 1_000 }),
                    bucket({ id: 'claude-seven_day', label: 'Weekly (7d)', window: 'weekly', usedPercent: 40, remainingPercent: 60, resetsAt: now + (2 * 24 + 14) * 3_600_000 + 1_000 })
                ],
                updatedAt: now
            }]
        })
        renderStatus('claude')
        const chip = await screen.findByRole('button', { name: '5h 12% (36m) · 7d 40% (2d14h)' })

        fireEvent.click(chip)
        expect(await screen.findByText(/Resets in 36 minutes/)).toBeTruthy()
        expect(screen.getByText(/Resets in 2 days 14 hours/)).toBeTruthy()
        expect(screen.getByText('12% used')).toBeTruthy()
        expect(screen.getByText('40% used')).toBeTruthy()
    })

    it('hides previously loaded quotas once a refetch fails', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        getMachineAgentQuotasMock.mockResolvedValueOnce(response)
        renderStatus('claude', queryClient)
        expect(await screen.findByRole('button', { name: '5h 12% · 7d 40%' })).toBeTruthy()

        getMachineAgentQuotasMock.mockRejectedValueOnce(new Error('Runner offline'))
        await queryClient.refetchQueries()

        await vi.waitFor(() => expect(screen.queryByRole('button')).toBeNull())
    })

    it('renders nothing when the runner cannot report quotas', async () => {
        getMachineAgentQuotasMock.mockRejectedValue(new Error('This runner does not support agent quota inspection yet'))
        const { container } = renderStatus('claude')
        await vi.waitFor(() => expect(getMachineAgentQuotasMock).toHaveBeenCalled())
        expect(container.textContent).toBe('')
    })
})
