import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_USAGE_QUERY_TEMPLATE } from '@hapi/protocol/usageQuery'
import type { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsUsageQueryPage from '@/routes/settings/usage-query'
import '../src/index.css'

const settings = {
    agent: 'claude',
    enabled: true,
    templateId: DEFAULT_USAGE_QUERY_TEMPLATE.id,
    template: DEFAULT_USAGE_QUERY_TEMPLATE,
    credentials: {
        baseUrl: { configured: true, source: 'config' },
        apiKey: { configured: true, source: 'config' }
    }
}

const api = {
    getMachines: async () => ({ machines: [{ id: 'fixture-machine', metadata: { host: 'fixture-workstation' } }] }),
    getMachineAgentAvailability: async () => ({ agents: [{ agent: 'claude', available: true }] }),
    getMachineUsageQuerySettings: async () => settings,
    testMachineUsageQuery: async () => ({
        status: 'success', fiveHour: { usedPercent: 42, resetsAt: null }, sevenDay: null, stale: false, queriedAt: Date.now()
    })
} as unknown as ApiClient

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AppContextProvider value={{ api, token: '', baseUrl: '' }}>
            <I18nProvider>
                <SettingsUsageQueryPage />
            </I18nProvider>
        </AppContextProvider>
    </QueryClientProvider>
)
