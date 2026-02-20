import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key
    })
}))

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

type RenderDialogOptions = {
    isPending?: boolean
    onClose?: () => void
    onConfirm?: () => Promise<void>
}

function renderDialog(options: RenderDialogOptions = {}) {
    const onClose = options.onClose ?? vi.fn()
    const onConfirm = options.onConfirm ?? vi.fn().mockResolvedValue(undefined)

    render(
        <ConfirmDialog
            isOpen={true}
            onClose={onClose}
            title="Confirm action"
            description="This action is permanent"
            confirmLabel="Confirm"
            confirmingLabel="Confirming..."
            onConfirm={onConfirm}
            isPending={options.isPending ?? false}
            destructive={true}
        />
    )

    return { onClose, onConfirm }
}

describe('ConfirmDialog', () => {
    it('focuses the confirm button when opened', () => {
        renderDialog()

        const confirmButton = screen.getByRole('button', { name: 'Confirm' })

        expect(confirmButton).toHaveFocus()
    })

    it('runs confirm action and closes when confirm is clicked', async () => {
        const onClose = vi.fn()
        const onConfirm = vi.fn().mockResolvedValue(undefined)
        renderDialog({ onClose, onConfirm })

        const confirmButton = screen.getByRole('button', { name: 'Confirm' })
        fireEvent.click(confirmButton)

        await waitFor(() => {
            expect(onConfirm).toHaveBeenCalledTimes(1)
        })

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('pressing Escape dismisses the dialog', async () => {
        const onClose = vi.fn()
        renderDialog({ onClose })

        fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })

        await waitFor(() => {
            expect(onClose).toHaveBeenCalledTimes(1)
        })
    })

    it('prevents duplicate confirms while async confirm is in flight', async () => {
        let resolveFirstConfirm: (() => void) | undefined
        const firstConfirmPromise = new Promise<void>((resolve) => {
            resolveFirstConfirm = resolve
        })

        const onConfirm = vi
            .fn<() => Promise<void>>()
            .mockImplementationOnce(() => firstConfirmPromise)
            .mockResolvedValue(undefined)

        const onClose = vi.fn()
        renderDialog({ onConfirm, onClose })

        const confirmButton = screen.getByRole('button', { name: 'Confirm' })

        fireEvent.click(confirmButton)
        fireEvent.click(confirmButton)

        expect(onConfirm).toHaveBeenCalledTimes(1)

        if (!resolveFirstConfirm) {
            throw new Error('Expected first confirm promise resolver to be available')
        }

        resolveFirstConfirm()

        await waitFor(() => {
            expect(onClose).toHaveBeenCalledTimes(1)
        })

        fireEvent.click(confirmButton)

        await waitFor(() => {
            expect(onConfirm).toHaveBeenCalledTimes(2)
        })
    })

    it('does not force focus to confirm when it is disabled', () => {
        renderDialog({ isPending: true })

        const confirmButton = screen.getByRole('button', { name: 'Confirming...' })
        const dialog = screen.getByRole('dialog')

        expect(confirmButton).toBeDisabled()
        expect(confirmButton).not.toHaveFocus()
        expect(dialog).toHaveFocus()
    })
})
