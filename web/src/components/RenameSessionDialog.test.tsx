import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { RenameSessionDialog } from './RenameSessionDialog'

afterEach(cleanup)

function renderDialog(overrides: Partial<Parameters<typeof RenameSessionDialog>[0]> = {}) {
    return render(
        <I18nProvider>
            <RenameSessionDialog
                isOpen
                onClose={vi.fn()}
                currentName="My session"
                onRename={vi.fn(async () => {})}
                isPending={false}
                {...overrides}
            />
        </I18nProvider>
    )
}

describe('RenameSessionDialog title-lock FUE', () => {
    afterEach(() => {
        window.localStorage.removeItem('hapi.fue.v1.session-title-lock')
    })

    it('shows a pulsing FUE dot on the lock toggle until acknowledged', () => {
        renderDialog()

        const lockButton = screen.getByRole('button', { name: 'Lock title against agent updates' })
        expect(within(lockButton).getByRole('status', { name: 'New feature available' })).toBeInTheDocument()
    })

    it('toggles the lock and shows the explainer on first click', () => {
        renderDialog()

        const lockButton = screen.getByRole('button', { name: 'Lock title against agent updates' })
        fireEvent.click(lockButton)

        expect(lockButton).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('dialog', { name: 'New: lock this title' })).toBeInTheDocument()
    })

    it('dismisses and persists acknowledgement on Got it', () => {
        renderDialog()

        fireEvent.click(screen.getByRole('button', { name: 'Lock title against agent updates' }))
        fireEvent.click(screen.getByRole('button', { name: 'Got it' }))

        expect(window.localStorage.getItem('hapi.fue.v1.session-title-lock')).toBe('1')
        expect(screen.queryByRole('dialog', { name: 'New: lock this title' })).not.toBeInTheDocument()
    })
})
