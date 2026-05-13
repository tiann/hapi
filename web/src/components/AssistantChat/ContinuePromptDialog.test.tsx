import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CONTINUE_PROMPT, ContinuePromptDialog } from './ContinuePromptDialog'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

describe('ContinuePromptDialog', () => {
    afterEach(() => {
        cleanup()
    })

    it('shows the exact prompt before sending', () => {
        render(
            <ContinuePromptDialog
                open
                onOpenChange={vi.fn()}
                onConfirm={vi.fn()}
            />
        )

        expect(screen.getByText(CONTINUE_PROMPT)).toBeInTheDocument()
        expect(screen.getByText('composer.continueShortcut.confirmDescription')).toBeInTheDocument()
    })

    it('confirms and closes the dialog', () => {
        const onOpenChange = vi.fn()
        const onConfirm = vi.fn()

        render(
            <ContinuePromptDialog
                open
                onOpenChange={onOpenChange}
                onConfirm={onConfirm}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'composer.continueShortcut.confirmSend' }))

        expect(onConfirm).toHaveBeenCalledOnce()
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('cancels without confirming', () => {
        const onOpenChange = vi.fn()
        const onConfirm = vi.fn()

        render(
            <ContinuePromptDialog
                open
                onOpenChange={onOpenChange}
                onConfirm={onConfirm}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'button.cancel' }))

        expect(onConfirm).not.toHaveBeenCalled()
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })
})
