// @vitest-environment-options { "url": "http://hub.test/" }
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { useAppContext } from '@/lib/app-context'
import { getMessageWindowState, ingestIncomingMessages } from '@/lib/message-window-store'

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
    let originalServiceWorkerDescriptor: PropertyDescriptor | undefined

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
        cleanup()
        vi.unstubAllGlobals()
    })

    afterAll(() => {
        if (originalServiceWorkerDescriptor) {
            Object.defineProperty(navigator, 'serviceWorker', originalServiceWorkerDescriptor)
            originalServiceWorkerDescriptor = undefined
        } else {
            delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
        }
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

    it('clears React Query, message-window, and service-worker API caches on silent Cloudflare Access identity switch, but keeps them on same-identity refresh', async () => {
        const exp = Math.floor(Date.now() / 1000) + 3600
        const aliceJwt1 = fakeJwt({
            uid: 1,
            ns: 'default',
            authMethod: 'cloudflareAccess',
            cfAccessSub: 'alice-sub',
            cfAccessEmail: 'alice@example.com',
            exp
        })
        const aliceJwt2 = fakeJwt({
            uid: 1,
            ns: 'default',
            authMethod: 'cloudflareAccess',
            cfAccessSub: 'alice-sub',
            cfAccessEmail: 'alice@example.com',
            exp: exp + 600
        })
        const bobJwt = fakeJwt({
            uid: 1,
            ns: 'work',
            authMethod: 'cloudflareAccess',
            cfAccessSub: 'bob-sub',
            cfAccessEmail: 'bob@example.com',
            exp: exp + 1200
        })

        const deleteCache = vi.fn(async () => true)
        vi.stubGlobal('caches', { delete: deleteCache })
        const swPostMessage = vi.fn()
        originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                controller: { postMessage: swPostMessage },
                register: vi.fn(async () => ({
                    update: vi.fn(async () => {}),
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn()
                })),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn()
            }
        })

        let activeJwt = aliceJwt1
        let rejectNextSessions = false
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
            const url = String(input)
            if (url.endsWith('/api/auth/methods')) {
                return jsonResponse({ cloudflareAccess: true })
            }
            if (url.endsWith('/api/auth/cloudflare')) {
                return jsonResponse({ token: activeJwt, user: { id: 1, firstName: 'Web User' } })
            }
            if (url.endsWith('/api/health')) {
                return jsonResponse({ status: 'ok', protocolVersion: 1, capabilities: {} })
            }
            if (url.endsWith('/api/sessions')) {
                if (rejectNextSessions) {
                    rejectNextSessions = false
                    return jsonResponse({ error: 'Invalid token' }, 401)
                }
                return jsonResponse({ sessions: [] })
            }
            return jsonResponse({ error: 'Not Found' }, 404)
        }))

        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        renderApp(queryClient)

        await waitFor(() => expect(screen.getByTestId('authenticated-shell')).toHaveAttribute('data-token', aliceJwt1))

        // Populate React Query caches and message-window cache for Alice.
        queryClient.setQueryData(['machines'], [{ id: 'alice-machine' }])
        queryClient.setQueryData(['usage', 'summary'], { totalTokens: 1234 })
        queryClient.setQueryData(['storage'], { bytes: 999 })
        ingestIncomingMessages('alice-session', [{
            id: 'msg-1',
            seq: 1,
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'secret prompt' } }
        } as never])
        sessionStorage.setItem('hapi:message-window:v2:alice-persisted', JSON.stringify({ messages: [{ id: 'p1' }] }))

        // Same-identity refresh (Alice -> Alice): caches must remain intact.
        activeJwt = aliceJwt2
        rejectNextSessions = true
        await act(async () => {
            screen.getByRole('button', { name: 'Fetch Sessions' }).click()
        })
        await waitFor(() => expect(screen.getByTestId('authenticated-shell')).toHaveAttribute('data-token', aliceJwt2))
        expect(queryClient.getQueryData(['machines'])).toEqual([{ id: 'alice-machine' }])
        expect(queryClient.getQueryData(['usage', 'summary'])).toEqual({ totalTokens: 1234 })
        expect(getMessageWindowState('alice-session').messages).toHaveLength(1)
        expect(deleteCache).not.toHaveBeenCalled()
        expect(swPostMessage).not.toHaveBeenCalled()

        // Silent identity switch (Alice -> Bob): all caches must be cleared.
        activeJwt = bobJwt
        rejectNextSessions = true
        await act(async () => {
            screen.getByRole('button', { name: 'Fetch Sessions' }).click()
        })
        await waitFor(() => expect(screen.getByTestId('authenticated-shell')).toHaveAttribute('data-token', bobJwt))
        expect(queryClient.getQueryData(['machines'])).toBeUndefined()
        expect(queryClient.getQueryData(['usage', 'summary'])).toBeUndefined()
        expect(queryClient.getQueryData(['storage'])).toBeUndefined()
        expect(getMessageWindowState('alice-session').messages).toEqual([])
        expect(sessionStorage.getItem('hapi:message-window:v2:alice-persisted')).toBeNull()
        expect(deleteCache).toHaveBeenCalledWith('api-sessions')
        expect(deleteCache).toHaveBeenCalledWith('api-session-detail')
        expect(deleteCache).toHaveBeenCalledWith('api-machines')
        expect(swPostMessage).toHaveBeenCalledWith({ type: 'CLEAR_API_CACHES' })
    })
})
