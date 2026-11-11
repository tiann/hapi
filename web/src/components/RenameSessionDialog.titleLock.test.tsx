import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { RenameSessionDialog } from './RenameSessionDialog'

afterEach(cleanup)
const label = 'Lock title against agent updates'
function fixture(locked = false) {
    const onRename = vi.fn(async (_name: string | undefined, _locked?: boolean) => {})
    const onUpdateSummary = vi.fn(async (_text: string, _locked?: boolean) => {})
    const onClose = vi.fn()
    const props = { isOpen: true, currentName: 'Session', currentTitleLocked: locked, sessionId: 'first',
        onRename, onClose, onUpdateSummary, onSuggestTitle: async () => 'Generated', isPending: false }
    const view = render(<I18nProvider><RenameSessionDialog {...props} /></I18nProvider>)
    const update = (changes: Partial<typeof props>) => view.rerender(
        <I18nProvider><RenameSessionDialog {...props} {...changes} /></I18nProvider>)
    return { ...props, update }
}

describe('title lock draft', () => {
    it('saves only the lock when the title draft is untouched', async () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('button', { name: label }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(f.onRename).toHaveBeenCalledWith(undefined, true))
    })

    it('does not pin a stale displayed title when an agent update arrives during a lock-only draft', async () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('button', { name: label }))
        f.update({ currentName: 'New native title' })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(f.onRename).toHaveBeenCalledWith(undefined, true))
    })

    it('defaults unlocked, never locks on manual rename, and saves both values together', async () => {
        const f = fixture()
        expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Manual' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(f.onRename).toHaveBeenCalledWith('Manual', false))
    })

    it('saves a lock-only change and permits a manual rename while locked', async () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('button', { name: label }))
        expect(f.onRename).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(f.onRename).toHaveBeenCalledWith(undefined, true))
        f.update({ isOpen: false })
        f.update({ currentTitleLocked: true })
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Another manual title' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(f.onRename).toHaveBeenCalledWith('Another manual title', true))
    })

    it('unlocks without replacing the title, and saves a generated title with its lock', async () => {
        const f = fixture(true)
        fireEvent.click(screen.getByRole('button', { name: label }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(f.onRename).toHaveBeenCalledWith(undefined, false))
        f.update({ isOpen: false })
        f.update({ currentTitleLocked: false })
        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Generated'))
        fireEvent.click(screen.getByRole('button', { name: label }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(f.onUpdateSummary).toHaveBeenCalledWith('Generated', true))
    })

    it('discards cancel/escape drafts and does not leak a lock into another session', () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('button', { name: label }))
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(f.onRename).not.toHaveBeenCalled()
        f.update({ isOpen: false })
        f.update({ sessionId: 'second', currentName: 'Other' })
        expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false')
        fireEvent.click(screen.getByRole('button', { name: label }))
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
        expect(f.onClose).toHaveBeenCalled()
        expect(f.onRename).not.toHaveBeenCalled()
    })

    it('keeps an open draft through incoming agent title updates', () => {
        const f = fixture()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My draft' } })
        fireEvent.click(screen.getByRole('button', { name: label }))
        f.update({ currentName: 'Incoming agent title' })
        expect(screen.getByRole('textbox')).toHaveValue('My draft')
        expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true')
    })

    it('retains the draft on failure and disables duplicate submissions until save finishes', async () => {
        const f = fixture()
        let rejectSave!: (error: Error) => void
        f.onRename.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectSave = reject }))
        fireEvent.click(screen.getByRole('button', { name: label }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(screen.getByRole('button', { name: label })).toBeDisabled()
        fireEvent.submit(screen.getByRole('textbox').closest('form')!)
        expect(f.onRename).toHaveBeenCalledTimes(1)
        rejectSave(new Error('Offline'))
        await waitFor(() => expect(screen.getByText('Failed to rename. Please try again.')).toBeInTheDocument())
        expect(f.onClose).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true')
    })
})
