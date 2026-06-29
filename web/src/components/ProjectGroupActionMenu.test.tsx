import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ProjectGroupActionMenu } from '@/components/ProjectGroupActionMenu'

afterEach(() => cleanup())

function renderMenu(overrides: Partial<React.ComponentProps<typeof ProjectGroupActionMenu>> = {}) {
    const defaults: React.ComponentProps<typeof ProjectGroupActionMenu> = {
        isOpen: true,
        onClose: vi.fn(),
        onCopyPath: vi.fn(),
        onArchiveAll: vi.fn(),
        canArchiveAll: true,
        onDelete: vi.fn(),
        canDelete: false,
        anchorPoint: { x: 0, y: 0 },
    }
    const merged = { ...defaults, ...overrides }
    return {
        ...render(
            <I18nProvider>
                <ProjectGroupActionMenu {...merged} />
            </I18nProvider>
        ),
        props: merged
    }
}

beforeEach(() => vi.clearAllMocks())

describe('ProjectGroupActionMenu', () => {
    it('renders all three actions', () => {
        renderMenu()
        expect(screen.getByRole('menuitem', { name: /Copy Path/ })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /Archive All Sessions/ })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /Delete Group/ })).toBeInTheDocument()
    })

    it('fires onCopyPath and closes on Copy Path click', () => {
        const onCopyPath = vi.fn()
        const onClose = vi.fn()
        renderMenu({ onCopyPath, onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: /Copy Path/ }))

        expect(onCopyPath).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('disables Archive All when nothing is archivable', () => {
        const onArchiveAll = vi.fn()
        renderMenu({ canArchiveAll: false, onArchiveAll })

        const item = screen.getByRole('menuitem', { name: /Archive All Sessions/ })
        expect(item).toBeDisabled()

        fireEvent.click(item)
        expect(onArchiveAll).not.toHaveBeenCalled()
    })

    it('disables Delete Group until every session is archived', () => {
        const onDelete = vi.fn()
        renderMenu({ canDelete: false, onDelete })

        const item = screen.getByRole('menuitem', { name: /Delete Group/ })
        expect(item).toBeDisabled()

        fireEvent.click(item)
        expect(onDelete).not.toHaveBeenCalled()
    })

    it('enables Delete Group and fires onDelete when canDelete is true', () => {
        const onDelete = vi.fn()
        const onClose = vi.fn()
        renderMenu({ canDelete: true, onDelete, onClose })

        const item = screen.getByRole('menuitem', { name: /Delete Group/ })
        expect(item).not.toBeDisabled()

        fireEvent.click(item)
        expect(onDelete).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders nothing when closed', () => {
        renderMenu({ isOpen: false })
        expect(screen.queryByRole('menu')).toBeNull()
    })
})
