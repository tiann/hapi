import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import { HUB_WEB_BUILD_STORAGE_KEY } from '@/lib/swStaticCache'

const checkForUpdatesMock = vi.fn<() => Promise<boolean>>()
const fetchThroughAuthProxyMock = vi.fn<typeof fetch>()

vi.mock('@/api/authProxy', () => ({
    fetchThroughAuthProxy: (...args: Parameters<typeof fetch>) => fetchThroughAuthProxyMock(...args),
}))

vi.mock('@/lib/pwa-update-context', () => ({
    PwaUpdateProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    usePwaUpdateContext: () => ({
        needRefresh: false,
        reload: vi.fn(),
        checkForUpdates: checkForUpdatesMock,
    }),
}))

vi.mock('@/lib/toast-context', () => ({
    ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useAddToast: () => vi.fn(),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-router', () => ({
    Outlet: () => <div data-testid="outlet" />,
    useLocation: () => '/',
    useMatchRoute: () => () => false,
    useRouter: () => ({ history: { location: { pathname: '/', search: '', hash: '', state: null }, push: vi.fn(), replace: vi.fn() } }),
}))

vi.mock('@tanstack/react-query', () => ({
    useQueryClient: () => ({ clear: vi.fn(), invalidateQueries: vi.fn() }),
}))

vi.mock('@/hooks/useServerUrl', () => ({
    useServerUrl: () => ({
        serverUrl: null,
        baseUrl: '',
        setServerUrl: vi.fn(),
        clearServerUrl: vi.fn(),
    }),
}))

vi.mock('@/hooks/useAuthSource', () => ({
    useAuthSource: () => ({
        authSource: null,
        isLoading: false,
        setAccessToken: vi.fn(),
        setPasskeySession: vi.fn(),
        clearAuth: vi.fn(),
    }),
}))

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({
        token: null,
        api: null,
        isLoading: false,
        error: null,
        needsBinding: false,
        connectionError: null,
        retryConnection: vi.fn(),
        cancelRecovery: vi.fn(),
        bind: vi.fn(),
        handleSseClosed: vi.fn(),
    }),
}))

vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }))
vi.mock('@/hooks/useSSE', () => ({ useSSE: () => ({ subscriptionId: null }) }))
vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions: [], isLoading: false, error: null }),
}))
vi.mock('@/hooks/usePushNotifications', () => ({
    pushNotificationsDisabled: () => false,
    usePushNotifications: () => ({ isSupported: false, permission: 'default', subscribe: vi.fn() }),
}))
vi.mock('@/hooks/useAppBadgePreference', () => ({
    useAppBadgePreference: () => ({ appBadgeEnabled: false }),
}))
vi.mock('@/hooks/useAppBadge', () => ({
    canUseAppBadging: () => false,
    useAppBadge: () => {},
}))
vi.mock('@/hooks/useViewportHeight', () => ({ useViewportHeight: () => {} }))
vi.mock('@/hooks/useVisibilityReporter', () => ({ useVisibilityReporter: () => {} }))
vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => vi.fn() }))
vi.mock('@/hooks/useTheme', () => ({ initializeTheme: vi.fn() }))
vi.mock('@/hooks/useThemeColors', () => ({ initializeThemeColors: vi.fn() }))
vi.mock('@/hooks/useChatSurfaceColors', () => ({ initializeChatSurfaceColors: vi.fn() }))
vi.mock('@/components/PwaUpdateBanner', () => ({
    PwaUpdateBanner: () => <div data-testid="pwa-banner-slot" />,
    PwaUpdateBannerWithStatusOffset: () => null,
}))
vi.mock('@/components/LoginPrompt', () => ({
    LoginPrompt: () => <div data-testid="login-prompt" />,
}))

describe('App pre-sign-in health upgrade check', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
        checkForUpdatesMock.mockResolvedValue(true)
        fetchThroughAuthProxyMock.mockResolvedValue(new Response(JSON.stringify({
            status: 'ok',
            version: '9.9.9',
            webBuildId: 'build-after-upgrade',
            protocolVersion: 1,
        }), { status: 200 }))
    })

    afterEach(() => {
        cleanup()
    })

    it('checks public /health and triggers service worker update on the sign-in screen without an authenticated API client', async () => {
        render(<App />)

        expect(screen.getByTestId('login-prompt')).toBeInTheDocument()
        expect(screen.getByTestId('pwa-banner-slot')).toBeInTheDocument()

        await waitFor(() => {
            expect(fetchThroughAuthProxyMock).toHaveBeenCalledWith('/health', { cache: 'no-store' })
            expect(checkForUpdatesMock).toHaveBeenCalledTimes(1)
        })

        await waitFor(() => {
            expect(window.localStorage.getItem(HUB_WEB_BUILD_STORAGE_KEY)).toBe('build-after-upgrade')
        })
    })
})
