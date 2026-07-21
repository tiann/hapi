import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionActionMenu } from '@/components/SessionActionMenu'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { notification: vi.fn(), impact: vi.fn() },
    }),
}))

afterEach(() => cleanup())

function renderMenu(overrides: Partial<React.ComponentProps<typeof SessionActionMenu>> = {}) {
    const defaults: React.ComponentProps<typeof SessionActionMenu> = {
        isOpen: true,
        onClose: vi.fn(),
        sessionId: 'sess-123',
        sessionTitle: 'Test session',
        sessionActive: false,
        onRename: vi.fn(),
        onArchive: vi.fn(),
        onReopen: vi.fn(),
        onDelete: vi.fn(),
        anchorPoint: { x: 0, y: 0 },
    }
    const merged = { ...defaults, ...overrides }
    return {
        ...render(
            <I18nProvider>
                <SessionActionMenu {...merged} />
            </I18nProvider>
        ),
        props: merged
    }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('SessionActionMenu - Pin action', () => {
    it('renders pin and unpin labels and invokes the action', () => {
        const onTogglePin = vi.fn()
        const { rerender } = renderMenu({ onTogglePin, sessionPinned: false })

        fireEvent.click(screen.getByRole('menuitem', { name: 'Pin session' }))
        expect(onTogglePin).toHaveBeenCalledOnce()

        rerender(
            <I18nProvider>
                <SessionActionMenu
                    isOpen={true}
                    onClose={vi.fn()}
                    sessionActive={false}
                    sessionPinned={true}
                    onTogglePin={onTogglePin}
                    onRename={vi.fn()}
                    onArchive={vi.fn()}
                    onDelete={vi.fn()}
                    anchorPoint={{ x: 0, y: 0 }}
                />
            </I18nProvider>
        )
        expect(screen.getByRole('menuitem', { name: 'Unpin session' })).toBeInTheDocument()
    })
})

describe('SessionActionMenu - Reopen action', () => {
    it('renders the Reopen item on inactive sessions when onReopen is provided', () => {
        renderMenu({ sessionActive: false })

        expect(screen.getByRole('menuitem', { name: /Reopen/ })).toBeInTheDocument()
    })

    it('does not render the Reopen item on active sessions', () => {
        renderMenu({ sessionActive: true })

        expect(screen.queryByRole('menuitem', { name: /Reopen/ })).toBeNull()
    })

    it('does not render the Reopen item when onReopen is omitted (back-compat)', () => {
        renderMenu({ sessionActive: false, onReopen: undefined })

        expect(screen.queryByRole('menuitem', { name: /Reopen/ })).toBeNull()
        // Delete item is still present for inactive sessions.
        expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument()
    })

    it('renders a disabled Reopen item with an explanation when resume data is missing', () => {
        const onClose = vi.fn()
        renderMenu({
            sessionActive: false,
            onReopen: undefined,
            reopenDisabledReason: 'Cursor chat data is no longer available on this machine.',
            onClose,
        })

        const reopen = screen.getByRole('menuitem', { name: /Reopen/ })
        expect(reopen).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByRole('tooltip')).toHaveTextContent('Cursor chat data is no longer available')

        fireEvent.click(reopen)
        expect(onClose).not.toHaveBeenCalled()
    })

    it('fires onReopen and closes the menu when the Reopen item is clicked', () => {
        const onReopen = vi.fn()
        const onClose = vi.fn()
        renderMenu({ sessionActive: false, onReopen, onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: /Reopen/ }))

        expect(onReopen).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders Reopen alongside Delete for inactive sessions', () => {
        renderMenu({ sessionActive: false })

        expect(screen.getByRole('menuitem', { name: /Reopen/ })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument()
        // Archive should not show up for inactive sessions (it is the active-session destructive).
        expect(screen.queryByRole('menuitem', { name: /Archive/ })).toBeNull()
    })
})

describe('SessionActionMenu - Codex sync action', () => {
    it('renders Sync from Codex only when a handler is provided', () => {
        const { rerender } = renderMenu({ onSyncCodex: undefined })

        expect(screen.queryByRole('menuitem', { name: /Sync from Codex/ })).toBeNull()

        rerender(
            <I18nProvider>
                <SessionActionMenu
                    isOpen={true}
                    onClose={vi.fn()}
                    sessionId="sess-123"
                    sessionTitle="Test session"
                    sessionActive={false}
                    onRename={vi.fn()}
                    onExport={vi.fn()}
                    onSyncCodex={vi.fn()}
                    onArchive={vi.fn()}
                    onReopen={vi.fn()}
                    onDelete={vi.fn()}
                    anchorPoint={{ x: 0, y: 0 }}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('menuitem', { name: /Sync from Codex/ })).toBeInTheDocument()
    })

    it('fires onSyncCodex and closes the menu when clicked', () => {
        const onSyncCodex = vi.fn()
        const onClose = vi.fn()
        renderMenu({ onSyncCodex, onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: /Sync from Codex/ }))

        expect(onSyncCodex).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})

describe('SessionActionMenu - Copy reference action', () => {
    it('renders the Copy reference item', () => {
        renderMenu()

        expect(screen.getByRole('menuitem', { name: /Copy reference/ })).toBeInTheDocument()
    })

    it('copies a session citation and closes the menu when Copy reference is clicked', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        const onClose = vi.fn()
        renderMenu({
            sessionId: 'abc-def',
            sessionTitle: 'upstream issue/pr discovery',
            onClose,
        })

        fireEvent.click(screen.getByRole('menuitem', { name: /Copy reference/ }))

        expect(onClose).toHaveBeenCalledTimes(1)
        await vi.waitFor(() => {
            expect(writeText).toHaveBeenCalledWith(
                'See session "upstream issue/pr discovery" (/sessions/abc-def) for context'
            )
        })
    })
})
