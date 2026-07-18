import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionActionMenu } from './SessionActionMenu'

function renderMenu(overrides: Partial<Parameters<typeof SessionActionMenu>[0]> = {}) {
    const props: Parameters<typeof SessionActionMenu>[0] = {
        isOpen: true,
        onClose: vi.fn(),
        sessionActive: true,
        onRename: vi.fn(),
        onArchive: vi.fn(),
        onDelete: vi.fn(),
        anchorPoint: { x: 120, y: 80 },
        menuId: 'session-actions-test',
        sessionId: 'hapi-session-123',
        ...overrides
    }

    render(
        <I18nProvider>
            <SessionActionMenu {...props} />
        </I18nProvider>
    )

    return props
}

describe('SessionActionMenu', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('copies the HAPI session id from the more actions menu', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        const onClose = vi.fn()

        renderMenu({ onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: /copy hapi session id/i }))

        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('hapi-session-123')
        })
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})
