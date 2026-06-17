import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { PwaUpdateBanner } from '@/components/PwaUpdateBanner'

const usePwaUpdateMock = vi.fn()

vi.mock('@/hooks/usePwaUpdate', () => ({
    usePwaUpdate: () => usePwaUpdateMock(),
}))

vi.mock('@/hooks/useOnlineStatus', () => ({
    useOnlineStatus: () => true,
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            impact: vi.fn(),
            notification: vi.fn(),
        },
    }),
}))

function renderBanner() {
    return render(
        <I18nProvider>
            <PwaUpdateBanner />
        </I18nProvider>,
    )
}

describe('PwaUpdateBanner', () => {
    beforeEach(() => {
        vi.clearAllMocks()
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
    })

    afterEach(() => {
        cleanup()
    })

    it('does not render when no update is available', () => {
        usePwaUpdateMock.mockReturnValue({
            needRefresh: false,
            reload: vi.fn(),
        })

        renderBanner()

        expect(screen.queryByTestId('pwa-update-banner')).not.toBeInTheDocument()
    })

    it('renders a reload-only banner with no dismiss action', () => {
        const reload = vi.fn()

        usePwaUpdateMock.mockReturnValue({
            needRefresh: true,
            reload,
        })

        renderBanner()

        expect(screen.getByTestId('pwa-update-banner')).toBeInTheDocument()
        expect(screen.getByText('New version available')).toBeInTheDocument()
        expect(screen.getByText('Reload to get the latest HAPI')).toBeInTheDocument()
        expect(screen.getAllByRole('button')).toHaveLength(1)

        fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
        expect(reload).toHaveBeenCalledTimes(1)
    })

    it('expands the rationale section when the disclosure is opened', () => {
        usePwaUpdateMock.mockReturnValue({
            needRefresh: true,
            reload: vi.fn(),
        })

        renderBanner()

        const disclosure = screen.getByText("Why can't I dismiss this?")
        expect(screen.queryByText(/agent running/i)).not.toBeVisible()

        fireEvent.click(disclosure)

        expect(screen.getByText(/agent running/i)).toBeVisible()
        expect(screen.getByText(/finish what you are doing first/i)).toBeVisible()
    })
})
