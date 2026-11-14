import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USAGE_QUERY_TEMPLATE, DEFAULT_USAGE_QUERY_TEMPLATES } from '@hapi/protocol/usageQuery'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
import SettingsUsageQueryPage from './usage-query'

const testUsageQuery = vi.fn()
const saveUsageQuery = vi.fn()
const useMachinesMock = vi.hoisted(() => vi.fn())

const defaultMachines = [{
    id: 'machine-1',
    metadata: { host: 'workstation.local', platform: 'win32' }
}]

beforeEach(() => {
    testUsageQuery.mockReset()
    saveUsageQuery.mockReset()
    useMachinesMock.mockReturnValue({
        machines: defaultMachines,
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
})

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {
        getMachineUsageQuerySettings: vi.fn().mockResolvedValue({
            agent: 'claude',
            enabled: false,
            templateId: DEFAULT_USAGE_QUERY_TEMPLATE.id,
            template: DEFAULT_USAGE_QUERY_TEMPLATE,
            credentials: {
                baseUrl: { configured: true, source: 'config' },
                apiKey: { configured: true, source: 'config' }
            }
        }),
        getMachineAgentAvailability: vi.fn().mockResolvedValue({
            agents: [
                { agent: 'claude', available: true },
                { agent: 'codex', available: false, reason: 'not_found' },
                { agent: 'kimi', available: true }
            ]
        }),
        testMachineUsageQuery: testUsageQuery,
        saveMachineUsageQuerySettings: saveUsageQuery
    } })
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: useMachinesMock
}))

describe('SettingsUsageQueryPage', () => {
    it('shows agent/template selectors and keeps credentials as placeholders', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsUsageQueryPage />
                </I18nProvider>
            </QueryClientProvider>
        )

        expect(await screen.findByRole('combobox', { name: 'Template' })).toHaveTextContent('Generic rate-limit windows')
        expect(screen.getByRole('heading', { name: 'Quota query target' })).toBeInTheDocument()
        expect(screen.getByText('{{baseUrl}}')).toBeInTheDocument()
        expect(screen.getByText('{{apiKey}}')).toBeInTheDocument()
        expect(screen.queryByText('secret-value')).not.toBeInTheDocument()

        expect(screen.getByRole('combobox', { name: 'Machine' })).toHaveClass('w-full')
        expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveClass('w-full')
        expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveTextContent('Claude Code')
        expect(screen.getAllByText('workstation.local')).toHaveLength(1)
        const templateSelect = screen.getByRole('combobox', { name: 'Template' })
        expect(templateSelect).toHaveClass('rounded-lg', 'bg-[var(--app-bg)]', 'text-[var(--app-fg)]')
        fireEvent.click(templateSelect)
        expect(screen.getByRole('listbox', { name: 'Template' })).toBeInTheDocument()
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
            'Kimi Coding Plan',
            'ZenMux subscription',
            'Zhipu GLM Coding Plan',
            'MiniMax Coding Plan',
            'Generic rate-limit windows',
            'Custom JSON paths'
        ])
        expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('bg-[var(--app-button)]', 'text-[var(--app-button-text)]')
        expect(screen.getByRole('button', { name: 'Test' }).parentElement).toHaveClass('justify-end')
        expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1)

        const agentSelect = screen.getByRole('combobox', { name: 'Agent' })
        fireEvent.click(agentSelect)
        expect(screen.queryByRole('option', { name: 'Codex' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('option', { name: 'Kimi CLI' }))
        expect(agentSelect).toHaveAttribute('aria-expanded', 'false')
    })

    it('validates and forwards the selected template through Test', async () => {
        const result = {
            agent: 'claude' as const,
            templateId: DEFAULT_USAGE_QUERY_TEMPLATE.id,
            status: 'success' as const,
            fiveHour: { usedPercent: 42, resetsAt: Date.now() + 3_600_000 },
            sevenDay: { usedPercent: 18, resetsAt: Date.now() + 86_400_000 },
            queriedAt: Date.now(),
            stale: false
        }
        testUsageQuery.mockResolvedValue(result)
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsUsageQueryPage />
                </I18nProvider>
            </QueryClientProvider>
        )

        await screen.findByRole('combobox', { name: 'Template' })
        fireEvent.click(screen.getByRole('button', { name: 'Test' }))

        await waitFor(() => expect(testUsageQuery).toHaveBeenCalledWith('machine-1', 'claude', DEFAULT_USAGE_QUERY_TEMPLATE))
        expect(await screen.findByText('42%')).toBeInTheDocument()
        expect(screen.getByText('18%')).toBeInTheDocument()
        expect(DEFAULT_USAGE_QUERY_TEMPLATES).toHaveLength(6)
    })

    it('keys an async save result by its original Agent selection', async () => {
        let resolveSave!: (value: unknown) => void
        saveUsageQuery.mockReset()
        saveUsageQuery.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve }))
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsUsageQueryPage />
                </I18nProvider>
            </QueryClientProvider>
        )

        await screen.findByRole('combobox', { name: 'Template' })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(saveUsageQuery).toHaveBeenCalledWith(
            'machine-1',
            'claude',
            expect.objectContaining({ enabled: false, templateId: DEFAULT_USAGE_QUERY_TEMPLATE.id })
        ))
        expect(screen.getByRole('combobox', { name: 'Template' })).toBeDisabled()
        expect(screen.getByRole('textbox', { name: 'Usage query template JSON' })).toBeDisabled()

        fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
        fireEvent.click(screen.getByRole('option', { name: 'Kimi CLI' }))
        fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
        fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }))
        await waitFor(() => {
            expect(screen.getByRole('combobox', { name: 'Template' })).toBeDisabled()
            expect(screen.getByRole('textbox', { name: 'Usage query template JSON' })).toBeDisabled()
        })
        const saved = {
            agent: 'claude',
            enabled: true,
            templateId: DEFAULT_USAGE_QUERY_TEMPLATE.id,
            template: DEFAULT_USAGE_QUERY_TEMPLATE,
            credentials: {
                baseUrl: { configured: true, source: 'config' },
                apiKey: { configured: true, source: 'config' }
            }
        }
        resolveSave(saved)

        await waitFor(() => expect(queryClient.getQueryData(queryKeys.machineUsageQuery('machine-1', 'claude'))).toMatchObject(saved))
        expect(queryClient.getQueryData(queryKeys.machineUsageQuery('machine-1', 'kimi'))).not.toMatchObject(saved)
        expect(screen.getByRole('combobox', { name: 'Template' })).not.toBeDisabled()
        expect(screen.getByRole('textbox', { name: 'Usage query template JSON' })).not.toBeDisabled()
    })

    it('surfaces machine-list errors and exposes a retry action', async () => {
        const refetch = vi.fn()
        useMachinesMock.mockReturnValue({ machines: [], isLoading: false, error: 'machines unavailable', refetch })
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsUsageQueryPage />
                </I18nProvider>
            </QueryClientProvider>
        )

        expect(await screen.findByText('machines unavailable')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(refetch).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('combobox', { name: 'Machine' })).not.toBeInTheDocument()
    })

    it('validates malformed templates from Test, Save, and Enable actions', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsUsageQueryPage />
                </I18nProvider>
            </QueryClientProvider>
        )

        await screen.findByRole('combobox', { name: 'Template' })
        fireEvent.change(screen.getByRole('textbox', { name: 'Usage query template JSON' }), { target: { value: '{' } })
        fireEvent.click(screen.getByRole('button', { name: 'Test' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Template JSON is invalid or missing required fields.')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'Enable quota query' }))
        expect(testUsageQuery).not.toHaveBeenCalled()
        expect(saveUsageQuery).not.toHaveBeenCalled()
    })
})
