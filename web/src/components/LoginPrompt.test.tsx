import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { AUTH_PROXY_REDIRECT_MESSAGE } from '@/api/authProxy'
import { LoginPrompt } from './LoginPrompt'

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

describe('LoginPrompt', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
            key: vi.fn(() => null),
            length: 0,
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })
    })

    it('does not clear first hub URL edit when hub URL required', async () => {
        renderWithProviders(
            <LoginPrompt
                baseUrl="https://app.example.com"
                serverUrl={null}
                setServerUrl={vi.fn((value: string) => ({ ok: true as const, value }))}
                clearServerUrl={vi.fn()}
                requireServerUrl={true}
                onLogin={vi.fn()}
            />
        )

        fireEvent.change(screen.getByPlaceholderText('Access token'), { target: { value: 'token' } })
        fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

        const hubInput = await screen.findByPlaceholderText('https://hapi.example.com')
        expect(screen.getByText('Hub URL required. Please set it before signing in.')).toBeInTheDocument()

        fireEvent.change(hubInput, { target: { value: 'https://hub.example.com' } })

        expect(hubInput).toHaveValue('https://hub.example.com')
        expect(screen.queryByText('Hub URL required. Please set it before signing in.')).not.toBeInTheDocument()
    })
})

const REDIRECT_TEXT = 'Request was redirected'
const OPEN_BUTTON = `Open ${window.location.host}`

describe('LoginPrompt redirected hub requests', () => {
    let originalFetch: typeof globalThis.fetch
    let originalLocation: Location
    let assign: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        Object.defineProperty(window, 'localStorage', {
            value: {
                getItem: vi.fn(() => 'en'),
                setItem: vi.fn(),
                removeItem: vi.fn(),
                clear: vi.fn(),
                key: vi.fn(() => null),
                length: 0,
            },
            configurable: true,
        })
        assign = vi.fn()
        originalLocation = window.location
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { ...originalLocation, origin: originalLocation.origin, host: originalLocation.host, href: originalLocation.href, assign }
        })
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
    })

    function mockRedirectedFetch() {
        // First attempt (redirect: 'manual') sees the redirect; the follow-up is blocked as cross-origin.
        ;(globalThis as { fetch: unknown }).fetch = vi.fn()
            .mockResolvedValueOnce({ type: 'opaqueredirect', status: 0, ok: false } as Response)
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    }

    function renderPrompt(extra: Partial<React.ComponentProps<typeof LoginPrompt>> = {}) {
        return renderWithProviders(
            <LoginPrompt
                baseUrl={window.location.origin}
                serverUrl={null}
                setServerUrl={vi.fn((value: string) => ({ ok: true as const, value }))}
                clearServerUrl={vi.fn()}
                onLogin={vi.fn()}
                onBind={vi.fn()}
                {...extra}
            />
        )
    }

    function submitToken(label = 'Sign In') {
        fireEvent.change(screen.getByPlaceholderText('Access token'), { target: { value: 'token' } })
        fireEvent.click(screen.getByRole('button', { name: label }))
    }

    it('shows the redirect notice and an open-hub button instead of "Failed to fetch"', async () => {
        mockRedirectedFetch()
        renderPrompt()

        submitToken()

        expect(await screen.findByText(REDIRECT_TEXT)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: OPEN_BUTTON })).toBeInTheDocument()
        expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument()
    })

    it('opens the hub through a URL the service worker precache does not match', async () => {
        mockRedirectedFetch()
        renderPrompt()

        submitToken()
        fireEvent.click(await screen.findByRole('button', { name: OPEN_BUTTON }))

        expect(assign).toHaveBeenCalledTimes(1)
        expect(assign.mock.calls[0][0]).toMatch(new RegExp(`^${window.location.origin}/\\?hapi_reauth=\\d+$`))
    })

    it('shows the notice for a redirect error handed down by the parent', () => {
        renderPrompt({ error: AUTH_PROXY_REDIRECT_MESSAGE })

        expect(screen.getByText(REDIRECT_TEXT)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: OPEN_BUTTON })).toBeInTheDocument()
    })

    it('opens the configured hub rather than the page origin', () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null)
        renderPrompt({ baseUrl: 'https://hub.example', error: AUTH_PROXY_REDIRECT_MESSAGE })

        fireEvent.click(screen.getByRole('button', { name: 'Open hub.example' }))

        expect(assign).not.toHaveBeenCalled()
        expect(open).toHaveBeenCalledTimes(1)
        expect(open.mock.calls[0][0]).toMatch(/^https:\/\/hub\.example\/\?hapi_reauth=\d+$/)
        open.mockRestore()
    })

    it('translates the notice and the button', () => {
        vi.mocked(window.localStorage.getItem).mockReturnValue('zh-CN')
        renderPrompt({ error: AUTH_PROXY_REDIRECT_MESSAGE })

        expect(screen.getByText('请求已被重定向')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: `打开 ${window.location.host}` })).toBeInTheDocument()
        expect(screen.queryByText(REDIRECT_TEXT)).not.toBeInTheDocument()
    })

    it('shows the notice without the button in bind mode', () => {
        renderPrompt({ mode: 'bind', error: AUTH_PROXY_REDIRECT_MESSAGE })

        expect(screen.getByText(REDIRECT_TEXT)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument()
    })

    it('leaves other failures unchanged', async () => {
        ;(globalThis as { fetch: unknown }).fetch = vi.fn()
            .mockResolvedValue(new Response('nope', { status: 401, statusText: 'Unauthorized' }))
        renderPrompt()

        submitToken()

        expect(await screen.findByText(/Auth failed: HTTP 401/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument()
    })
})

describe('LoginPrompt passkey sign-in', () => {
    beforeEach(() => {
        vi.resetModules()
    })
    afterEach(() => {
        vi.doUnmock('@/lib/passkey')
    })

    async function renderWithPasskey(signIn: () => Promise<{ hubUrl: string; passkeySession: string }>) {
        const discover = vi.fn(signIn)
        const manual = vi.fn(async () => 'manual-session')
        const setServerUrl = vi.fn((value: string) => ({ ok: true as const, value }))
        vi.doMock('@/lib/passkey', () => ({
            isPasskeySupported: () => true,
            isPasskeyCancelled: (e: unknown) => e instanceof Error && e.name === 'NotAllowedError',
            discoverAndSignInWithPasskey: discover,
            signInWithPasskey: manual
        }))
        const { LoginPrompt: Prompt } = await import('./LoginPrompt')
        const { I18nProvider: Provider } = await import('@/lib/i18n-context')
        const onPasskeyLogin = vi.fn()
        render(
            <Provider>
                <Prompt
                    baseUrl="https://hub.example.com"
                    serverUrl={null}
                    setServerUrl={setServerUrl}
                    clearServerUrl={vi.fn()}
                    onLogin={vi.fn()}
                    onPasskeyLogin={onPasskeyLogin}
                    requireServerUrl={true}
                />
            </Provider>
        )
        return { onPasskeyLogin, discover, manual, setServerUrl }
    }

    it('hands the passkey session to the app on success', async () => {
        const { onPasskeyLogin, setServerUrl, manual } = await renderWithPasskey(async () => ({ hubUrl: 'https://discovered.example', passkeySession: 'pk-session' }))
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }))
        await vi.waitFor(() => expect(onPasskeyLogin).toHaveBeenCalledWith('pk-session', 'https://discovered.example'))
        expect(setServerUrl).toHaveBeenCalledWith('https://discovered.example')
        expect(manual).not.toHaveBeenCalled()
    })

    it('keeps explicit Hub passkey sign-in available without discovery', async () => {
        const { onPasskeyLogin, discover, manual } = await renderWithPasskey(async () => ({ hubUrl: 'https://other.example', passkeySession: 'unused' }))
        fireEvent.click(screen.getByRole('button', { name: /^Hub/ }))
        fireEvent.change(await screen.findByPlaceholderText('https://hapi.example.com'), { target: { value: 'https://manual.example' } })
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey for this Hub' }))
        await vi.waitFor(() => expect(onPasskeyLogin).toHaveBeenCalledWith('manual-session', 'https://manual.example'))
        expect(manual).toHaveBeenCalledWith('https://manual.example')
        expect(discover).not.toHaveBeenCalled()
    })

    it('explains a passkey revoked by token rotation and stays quiet on cancel', async () => {
        const { ApiError } = await import('@/api/client')
        let next: Error = new ApiError('Passkey sign-in failed: HTTP 401', 401, 'passkey_revoked')
        const { onPasskeyLogin } = await renderWithPasskey(async () => { throw next })
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }))
        expect(await screen.findByText(/access token was rotated/)).toBeInTheDocument()

        next = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }))
        await vi.waitFor(() => expect(screen.queryByText(/access token was rotated/)).not.toBeInTheDocument())
        expect(screen.queryByText(/Passkey sign-in failed/)).not.toBeInTheDocument()
        expect(onPasskeyLogin).not.toHaveBeenCalled()
    })
})
