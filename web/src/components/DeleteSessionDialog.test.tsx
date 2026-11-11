import { StrictMode, type ReactNode } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { I18nProvider } from '@/lib/i18n-context'
import { DeleteSessionDialog } from './DeleteSessionDialog'

function setup() {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <StrictMode><QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider></StrictMode>
    )
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const api = { archiveSession: vi.fn(() => promise) } as unknown as ApiClient
    const initiator = renderHook(() => useSessionActions(api, 'session-A'), { wrapper })
    const onConfirm = vi.fn(async () => {})
    const onClose = vi.fn()
    const dialog = (sessionId = 'session-A', isPending = false) => (
        <DeleteSessionDialog isOpen sessionId={sessionId} onClose={onClose}
            description="Delete this session permanently?" onConfirm={onConfirm} isPending={isPending} />
    )
    return { client, wrapper, initiator, resolve, reject, dialog, onConfirm, onClose }
}

describe('DeleteSessionDialog shared archive progress', () => {
    it.each(['success', 'failure'])('waits after the initiating view unmounts and requires explicit delete (%s)', async outcome => {
        const state = setup()
        let pending!: Promise<unknown>
        act(() => { pending = state.initiator.result.current.archiveSession().catch(error => error) })
        await waitFor(() => expect(state.initiator.result.current.isPending).toBe(true))
        state.initiator.unmount()
        const view = render(state.dialog(), { wrapper: state.wrapper })
        expect(screen.getByRole('button', { name: 'Waiting for archive to finish…' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Waiting for archive to finish…' }))
        expect(state.onConfirm).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
        // A different session must remain deletable even while A is archiving.
        view.rerender(state.dialog('session-B'))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled())
        view.rerender(state.dialog())
        await waitFor(() => expect(screen.getByRole('button', { name: 'Waiting for archive to finish…' })).toBeDisabled())
        await act(async () => {
            if (outcome === 'success') state.resolve()
            else state.reject(new Error('Archive failed'))
            await pending
        })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled())
        expect(state.onConfirm).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(state.onConfirm).toHaveBeenCalledTimes(1))
        expect(state.onClose).toHaveBeenCalledTimes(1)
    })

    it('updates an already-open dialog when another view starts archiving', async () => {
        const state = setup()
        render(state.dialog(), { wrapper: state.wrapper })
        expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
        let pending!: Promise<void>
        act(() => { pending = state.initiator.result.current.archiveSession() })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Waiting for archive to finish…' })).toBeDisabled())
        await act(async () => { state.resolve(); await pending })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled())
    })

    it('releases its shared subscription when dismissed and recovers progress when reopened', async () => {
        const state = setup()
        const cache = state.client.getMutationCache()
        expect(cache.hasListeners()).toBe(false)
        let pending!: Promise<void>
        act(() => { pending = state.initiator.result.current.archiveSession() })
        await waitFor(() => expect(state.initiator.result.current.isPending).toBe(true))
        const view = render(state.dialog(), { wrapper: state.wrapper })
        expect(cache.hasListeners()).toBe(true)
        view.unmount()
        expect(cache.hasListeners()).toBe(false)
        render(state.dialog(), { wrapper: state.wrapper })
        expect(screen.getByRole('button', { name: 'Waiting for archive to finish…' })).toBeDisabled()
        await act(async () => { state.resolve(); await pending })
    })

    it('keeps the deleting label and disables confirmation while delete is pending', () => {
        const state = setup()
        render(state.dialog('session-A', true), { wrapper: state.wrapper })
        expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    })

    it('does not subscribe while its wrapper is closed', () => {
        const state = setup()
        render(<DeleteSessionDialog isOpen={false} sessionId="session-A" onClose={state.onClose}
            description="Delete?" onConfirm={state.onConfirm} isPending={false} />, { wrapper: state.wrapper })
        expect(state.client.getMutationCache().hasListeners()).toBe(false)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})
