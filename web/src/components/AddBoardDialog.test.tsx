import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { AddBoardDialog } from './AddBoardDialog'

function renderDialog(onAdd: (url: string) => Promise<void>, onClose: () => void) {
    return render(
        <I18nProvider>
            <AddBoardDialog isOpen onClose={onClose} onAdd={onAdd} />
        </I18nProvider>
    )
}

afterEach(() => cleanup())

describe('AddBoardDialog', () => {
    it('submits the trimmed url and closes on success', async () => {
        const onAdd = vi.fn().mockResolvedValue(undefined)
        const onClose = vi.fn()
        renderDialog(onAdd, onClose)

        fireEvent.change(screen.getByPlaceholderText(/github.com/i), {
            target: { value: '  https://github.com/users/heavygee/projects/6  ' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Add' }))

        await waitFor(() => {
            expect(onAdd).toHaveBeenCalledWith('https://github.com/users/heavygee/projects/6')
            expect(onClose).toHaveBeenCalledOnce()
        })
    })

    it('shows the server error message (not the raw HTTP status line) and stays open on failure', async () => {
        const onAdd = vi.fn().mockRejectedValue(
            new ApiError('HTTP 400 Bad Request', 400, undefined, JSON.stringify({ error: 'Could not parse a GitHub Projects URL' }))
        )
        const onClose = vi.fn()
        renderDialog(onAdd, onClose)

        fireEvent.change(screen.getByPlaceholderText(/github.com/i), { target: { value: 'not a url' } })
        fireEvent.click(screen.getByRole('button', { name: 'Add' }))

        await waitFor(() => {
            expect(screen.getByText('Could not parse a GitHub Projects URL')).toBeInTheDocument()
        })
        expect(onClose).not.toHaveBeenCalled()
    })

    it('disables submit until a url is entered', () => {
        renderDialog(vi.fn(), vi.fn())
        expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
        fireEvent.change(screen.getByPlaceholderText(/github.com/i), { target: { value: 'x' } })
        expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled()
    })
})
