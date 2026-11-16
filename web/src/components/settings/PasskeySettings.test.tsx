import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PasskeySummary } from '@hapi/protocol'
import { I18nProvider } from '@/lib/i18n-context'
import { PasskeySettings } from './PasskeySettings'

const passkeyLib = vi.hoisted(() => ({
    isPasskeySupported: vi.fn(() => true),
    isPasskeyCancelled: vi.fn(() => false),
    registerPasskey: vi.fn(() => Promise.resolve()),
    defaultPasskeyName: vi.fn(() => 'Test passkey'),
}))
vi.mock('@/lib/passkey', () => passkeyLib)

const appContext = vi.hoisted(() => ({
    api: {
        listPasskeys: vi.fn(),
        deletePasskey: vi.fn(() => Promise.resolve()),
    },
    passkeyRegistrationAllowed: true as boolean | undefined,
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => appContext }))

const passkey: PasskeySummary = {
    id: 'pk-1',
    name: 'My passkey',
    rpId: 'hub.example',
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    valid: true,
}

const cloudflareAccessHint = "Passkeys can't be added while signed in through Cloudflare Access."

function renderSettings() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <PasskeySettings />
            </I18nProvider>
        </QueryClientProvider>,
    )
}

describe('PasskeySettings', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        passkeyLib.isPasskeySupported.mockReturnValue(true)
        appContext.passkeyRegistrationAllowed = true
        appContext.api.listPasskeys.mockResolvedValue({ passkeys: [passkey] })
        appContext.api.deletePasskey.mockResolvedValue(undefined)
    })

    it('hides the add action and explains why in a Cloudflare Access session, while list and delete keep working', async () => {
        appContext.passkeyRegistrationAllowed = false
        renderSettings()

        expect(await screen.findByText('My passkey')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Add passkey' })).not.toBeInTheDocument()
        expect(screen.getByText(cloudflareAccessHint)).toBeInTheDocument()

        vi.spyOn(window, 'confirm').mockReturnValue(true)
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
        await waitFor(() => expect(appContext.api.deletePasskey).toHaveBeenCalledWith('pk-1'))
    })

    it('still offers the add action when registration is allowed', async () => {
        appContext.passkeyRegistrationAllowed = true
        renderSettings()

        const addButton = screen.getByRole('button', { name: 'Add passkey' })
        expect(screen.queryByText(cloudflareAccessHint)).not.toBeInTheDocument()

        fireEvent.click(addButton)
        await waitFor(() => expect(passkeyLib.registerPasskey).toHaveBeenCalledOnce())
    })

    it('treats a missing flag as allowed so other sessions are unchanged', () => {
        appContext.passkeyRegistrationAllowed = undefined
        renderSettings()

        expect(screen.getByRole('button', { name: 'Add passkey' })).toBeInTheDocument()
        expect(screen.queryByText(cloudflareAccessHint)).not.toBeInTheDocument()
    })
})
