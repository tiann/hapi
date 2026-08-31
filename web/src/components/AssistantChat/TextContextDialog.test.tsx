import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { TextContextDialog } from './TextContextDialog'

describe('TextContextDialog', () => {
    it('adds named text context without sending the composer body', async () => {
        const onAdd = vi.fn(async () => {})
        const onOpenChange = vi.fn()

        render(
            <I18nProvider>
                <TextContextDialog
                    open
                    onOpenChange={onOpenChange}
                    onAdd={onAdd}
                />
            </I18nProvider>
        )

        fireEvent.change(screen.getByLabelText('Name'), {
            target: { value: 'API history' },
        })
        fireEvent.change(screen.getByLabelText('Context'), {
            target: { value: 'long supporting context' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Add as context' }))

        await waitFor(() => {
            expect(onAdd).toHaveBeenCalledWith('long supporting context', 'API history')
        })
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })
})
