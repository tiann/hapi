import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CompanionPairing } from './CompanionPairing'

vi.mock('qrcode', () => ({
    default: {
        toCanvas: vi.fn(async () => undefined),
    },
}))

const BASE_URL = 'http://192.168.1.20:3001'
const ACCESS_TOKEN = 'test-access-token'
const DEEPLINK = `hapicompanion://bind?hub=${encodeURIComponent(BASE_URL)}&code=${ACCESS_TOKEN}`

const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function stubClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value,
    })
}

function stubExecCommand(execCommand: (command: string) => boolean) {
    Object.defineProperty(document, 'execCommand', {
        configurable: true,
        writable: true,
        value: vi.fn(execCommand),
    })
    return vi.mocked(document.execCommand)
}

function renderPairing() {
    return render(
        <I18nProvider>
            <CompanionPairing baseUrl={BASE_URL} />
        </I18nProvider>
    )
}

function revealAndCopy() {
    fireEvent.click(screen.getByRole('button', { name: 'Show pairing QR' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
}

beforeEach(() => {
    localStorage.setItem(`hapi_access_token::${BASE_URL}`, ACCESS_TOKEN)
})

afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
    if (originalExecCommand) {
        Object.defineProperty(document, 'execCommand', originalExecCommand)
    } else {
        delete (document as { execCommand?: unknown }).execCommand
    }
})

describe('CompanionPairing copy link', () => {
    it('copies via the legacy fallback when navigator.clipboard is undefined (plain HTTP)', async () => {
        stubClipboard(undefined)
        const execCommand = stubExecCommand(() => true)

        renderPairing()
        revealAndCopy()

        await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy()
        })
        expect(screen.getByText(DEEPLINK)).toBeTruthy()
    })

    it('does not claim success when both copy strategies fail', async () => {
        stubClipboard(undefined)
        const execCommand = stubExecCommand(() => false)

        renderPairing()
        revealAndCopy()

        await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
        expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
    })
})
