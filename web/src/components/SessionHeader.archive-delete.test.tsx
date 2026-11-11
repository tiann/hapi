import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionHeader } from './SessionHeader'
import { ToastProvider } from '@/lib/toast-context'
import { I18nProvider } from '@/lib/i18n-context'
import type { Session } from '@/types/api'
import type { ApiClient } from '@/api/client'

afterEach(() => { cleanup(); localStorage.clear() })

it('waits for archive confirmation before allowing an explicitly confirmed delete', async () => {
    let finishArchive!: () => void
    const archivePromise = new Promise<void>(resolve => { finishArchive = resolve })
    const archiveSession = vi.fn(() => archivePromise)
    let finishDelete!: () => void
    const deletePromise = new Promise<void>(resolve => { finishDelete = resolve })
    const deleteSession = vi.fn(() => deletePromise)
    const api = { archiveSession, deleteSession, getMachines: vi.fn(async () => ({ machines: [] })),
        getScratchlist: vi.fn(async () => ({ entries: [] })) } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const session: Session = { id: 'archive-delete-test', namespace: 'default', seq: 0, createdAt: 0, updatedAt: 0,
        active: true, activeAt: 0, metadata: { flavor: 'codex', path: '/repo', host: 'test' }, metadataVersion: 0,
        agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, model: null,
        modelReasoningEffort: null, effort: null, serviceTier: null }
    const view = (active: boolean) => <QueryClientProvider client={client}><ToastProvider><I18nProvider>
        <SessionHeader session={{ ...session, active }} api={api} onBack={vi.fn()} />
    </I18nProvider></ToastProvider></QueryClientProvider>
    const rendered = render(view(true))
    fireEvent.click(screen.getByTitle('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(archiveSession).toHaveBeenCalledOnce())
    rendered.rerender(view(false))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirming cleanup…' })).toBeVisible())
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]!)
    fireEvent.click(screen.getByTitle('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Waiting for archive to finish…' })).toBeDisabled()
    expect(within(dialog).getByText('Archiving is still in progress. Wait for it to finish, then confirm deletion.')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(within(dialog).queryByRole('button', { name: 'Deleting…' })).not.toBeInTheDocument()
    expect(deleteSession).not.toHaveBeenCalled()
    await act(async () => finishArchive())
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled())
    expect(deleteSession).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleteSession).toHaveBeenCalledOnce())
    expect(within(dialog).getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    await act(async () => finishDelete())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})
