// @vitest-environment-options { "url": "http://hub.test/" }
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { useAppContext } from '@/lib/app-context'

const routerMocks = vi.hoisted(() => ({
    replace: vi.fn(),
    pathname: '/sessions',
    search: ''
}))

vi.mock('@tanstack/react-router', () => ({
    Outlet: () => {
        const { api, token } = useAppContext()
        return (
            <div data-testid="authenticated-shell" data-token={token}>
                <button type="button" onClick={() => void api.getSessions().catch(() => {})}>
                    Fetch Sessions
                </button>
            </div>
        )
    },
    useLocation: ({ select }: { select: (loc: { pathname: string }) => unknown }) =>
        select({ pathname: routerMocks.pathname }),
    useMatchRoute: () => () => false,
    useNavigate: () => vi.fn(),
    useRouter: () => ({
        history: {
            location: {
                pathname: routerMocks.pathname,
                search: routerMocks.search,
                hash: '',
                state: {}
            },
            replace: routerMocks.replace
        }
    })
}))

vi.mock('@/hooks/useSSE', () => ({
    useSSE: () => ({ subscriptionId: null })
}))

vi.mock('@/hooks/usePushNotifications', () => ({
    usePushNotifications: () => ({
        isSupported: false,
        permission: 'default',
        requestPermission: vi.fn(),
        subscribe: vi.fn()
    })
}))

vi.mock('@/hooks/useVisibilityReporter', () => ({
    useVisibilityReporter: () => {}
}))

vi.mock('@/components/InstallPrompt', () => ({
    InstallPrompt: () => null
}))

vi.mock('@/components/PwaUpdateBanner', () => ({
    PwaUpdateBanner: () => null,
    PwaUpdateBannerWithStatusOffset: () => null
}))

import { App } from './App'

function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) => btoa(JSON.stringify(value))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

function renderApp(queryClient: QueryClient) {
    return render(
        <I18nProvider>
            <QueryClientProvider client={queryClient}>
                <App />
            </QueryClientProvider>
        </I18nProvider>
    )
}

describe('App — Cloudflare Access authentication & revocation flows', () => {
    beforeEach(() => {
        localStorage.clear()
        sessionStorage.clear()
        routerMocks.replace.mockReset()
        vi.stubGlobal('matchMedia', vi.fn(() => ({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        })))
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('exits authenticated shell to Cloudflare sign-in prompt on mid-session 403 Access denied', async () => {
        const exp = Math.floor(Date.now() / 1000) + 3600
        const aliceJwt = fakeJwt({
            uid: 1,
            ns: 'default',
            authMethod: 'cloudflareAccess',
            cfAccessSub: 'alice-sub',
            cfAccessEmail: 'alice@example.com',
            exp
        })

        let revoked = false
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
            const url = String(input)
            if (url.endsWith('/api/auth/methods')) {
                return jsonResponse({ cloudflareAccess: true })
            }
            if (url.endsWith('/api/auth/cloudflare')) {
                if (revoked) {
                    return jsonResponse({ error: 'Access denied' }, 403)
                }
                return jsonResponse({ token: aliceJwt, user: { id: 1, firstName: 'Web User' } })
            }
            if (url.endsWith('/api/health')) {
                return jsonResponse({ status: 'ok', protocolVersion: 1, capabilities: {} })
            }
            if (url.endsWith('/api/sessions')) {
                if (revoked) {
                    return jsonResponse({ error: 'Access denied' }, 403)
                }
                return jsonResponse({ sessions: [] })
            }
            return jsonResponse({ error: 'Not Found' }, 404)
        }))

        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        renderApp(queryClient)

        await waitFor(() => expect(screen.getByTestId('authenticated-shell')).toBeInTheDocument())

        revoked = true
        await act(async () => {
            screen.getByRole('button', { name: 'Fetch Sessions' }).click()
        })

        await waitFor(() => {
            expect(screen.queryByTestId('authenticated-shell')).not.toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Sign in with Cloudflare Access' })).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
        })
        expect(screen.queryByPlaceholderText('Access token')).not.toBeInTheDocument()
    })
})
