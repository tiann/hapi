import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { UnblockReasonDialog } from './UnblockReasonDialog'

afterEach(cleanup)

function renderDialog(overrides: {
    onConfirm: (reason: string) => Promise<unknown>
    isPending?: boolean
}) {
    return render(
        <I18nProvider>
            <UnblockReasonDialog
                isOpen
                sessionTitle="stuck-one"
                blockedLabel="Blocked"
                blockedNote="needs a key"
                isPending={overrides.isPending}
                onClose={vi.fn()}
                onConfirm={overrides.onConfirm}
            />
        </I18nProvider>
    )
}

describe('UnblockReasonDialog (#1717)', () => {
    it('submits one dismissal when the keyboard shortcut is pressed twice', async () => {
        // The Confirm button disables itself while the mutation runs, but
        // Ctrl/Cmd+Enter in the textarea reaches the submit handler directly.
        // A second press mid-flight sent a second dismissal and appended a
        // duplicate `operator_unblock` ledger event for one operator decision.
        let release: (() => void) | undefined
        const onConfirm = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
        renderDialog({ onConfirm })

        const textarea = screen.getByRole('textbox')
        fireEvent.change(textarea, { target: { value: 'handled out of band' } })

        fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
        fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
        fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

        expect(onConfirm).toHaveBeenCalledTimes(1)
        release?.()
    })

    it('still submits on a single shortcut press', () => {
        // Positive control: the guard must not swallow the first activation.
        const onConfirm = vi.fn(() => Promise.resolve())
        renderDialog({ onConfirm })

        const textarea = screen.getByRole('textbox')
        fireEvent.change(textarea, { target: { value: 'not actually blocked' } })
        fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

        expect(onConfirm).toHaveBeenCalledTimes(1)
        expect(onConfirm).toHaveBeenCalledWith('not actually blocked')
    })

    it('refuses an empty reason without calling the mutation', () => {
        const onConfirm = vi.fn(() => Promise.resolve())
        renderDialog({ onConfirm })

        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true })

        expect(onConfirm).not.toHaveBeenCalled()
    })

    it('ignores the shortcut while a dismissal is already pending', () => {
        // `isPending` arrives from the caller's mutation state, so it covers
        // the window after a re-render as well as the synchronous latch.
        const onConfirm = vi.fn(() => Promise.resolve())
        renderDialog({ onConfirm, isPending: true })

        const textarea = screen.getByRole('textbox')
        fireEvent.change(textarea, { target: { value: 'handled out of band' } })
        fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

        expect(onConfirm).not.toHaveBeenCalled()
    })
})
