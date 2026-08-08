import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { topFleetBannersOffsetClass, TopFleetBanners } from './TopFleetBanners'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'

vi.mock('@/lib/pwa-update-context', () => ({
    usePwaUpdateContext: () => ({
        needRefresh: true,
        offlineReady: false,
        reload: vi.fn(),
    }),
}))

vi.mock('@/hooks/useOnlineStatus', () => ({
    useOnlineStatus: () => true,
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { impact: vi.fn() } }),
}))

vi.mock('@/lib/voice-context', () => ({
    useVoiceOptional: () => null,
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({
        machines: [{
            id: 'm1',
            active: true,
            metadata: {
                happyCliVersion: '0.20.0',
                capabilities: [],
                host: 'skewed-host',
            },
        }],
    }),
}))

vi.mock('@/hooks/queries/useUpgradeInfo', () => ({
    useUpgradeInfo: () => ({
        info: {
            policy: 'alert',
            offer: {
                channel: 'npm',
                targetVersion: '0.25.1',
                targetCapabilities: ['runner-self-upgrade'],
                npmPackage: '@twsxtd/hapi',
            },
        },
    }),
}))

describe('topFleetBannersOffsetClass', () => {
    it('offsets below status banners when they are active', () => {
        expect(topFleetBannersOffsetClass({ isOnline: true, hasTopStatusBanner: true }))
            .toContain('3rem')
        expect(topFleetBannersOffsetClass({ isOnline: true, hasTopStatusBanner: false }))
            .toContain('0.5rem')
    })
})

describe('TopFleetBanners', () => {
    it('stacks PWA update and runner skew in one fixed column instead of overlapping', () => {
        const queryClient = new QueryClient()
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <ToastProvider>
                        <AppContextProvider value={{ api: {} as never, token: 't', baseUrl: 'http://localhost' }}>
                            <TopFleetBanners isSyncing={false} isReconnecting={false} />
                        </AppContextProvider>
                    </ToastProvider>
                </I18nProvider>
            </QueryClientProvider>,
        )

        const stack = screen.getByTestId('top-fleet-banners')
        expect(stack.className).toMatch(/flex flex-col/)
        expect(stack.className).toMatch(/fixed/)
        const pwa = screen.getByTestId('pwa-update-banner')
        const skew = screen.getByTestId('runner-version-skew-banner')
        expect(pwa.className).toMatch(/relative/)
        expect(skew.className).toMatch(/relative/)
        expect(pwa.className).not.toMatch(/fixed/)
        expect(skew.className).not.toMatch(/fixed/)
        expect(stack.contains(pwa)).toBe(true)
        expect(stack.contains(skew)).toBe(true)
    })
})
