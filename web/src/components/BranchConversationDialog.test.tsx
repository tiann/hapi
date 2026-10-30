import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { BranchConversationDialog } from './BranchConversationDialog'

function mount(onSubmit = vi.fn().mockResolvedValue(undefined)) {
    const api = {
        getMachineClaudeModels: vi.fn().mockResolvedValue({ success: true, availableModels: [{ value: 'claude-opus-test', displayName: 'Opus test' }] }),
        getMachineCodexModels: vi.fn().mockResolvedValue({ success: true, models: [{ id: 'codex-test', displayName: 'Codex test' }] })
    } as unknown as ApiClient
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider><BranchConversationDialog api={api} machineId="machine" sourceAgent="claude"
            messageLocalId="turn-two" onClose={vi.fn()} onSubmit={onSubmit} /></I18nProvider>
    </QueryClientProvider>)
    return { api, onSubmit }
}
afterEach(cleanup)
describe('BranchConversationDialog', () => {
    it('selects another harness, its discovered model, boundary and workspace', async () => {
        const { onSubmit } = mount()
        await screen.findByRole('option', { name: 'Opus test' })
        fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'codex' } })
        await screen.findByRole('option', { name: 'Codex test' })
        expect(screen.queryByRole('option', { name: 'Opus test' })).toBeNull()
        fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'codex-test' } })
        fireEvent.change(screen.getByLabelText('Keep history'), { target: { value: 'after' } })
        fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'worktree' } })
        fireEvent.change(screen.getByLabelText('First instruction in the new branch'), { target: { value: 'Try another approach' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ agent: 'codex', model: 'codex-test', boundary: 'after',
            workspace: 'worktree', messageLocalId: 'turn-two', instruction: 'Try another approach' })
        expect(screen.getByText(/Files are not rolled back/)).toBeInTheDocument()
    })
    it('retains request identity after a lost response and requires a new instruction', async () => {
        const onSubmit = vi.fn().mockRejectedValue(new Error('Response lost'))
        mount(onSubmit)
        expect(screen.getByRole('button', { name: 'Create branch' })).toBeDisabled()
        fireEvent.change(screen.getByLabelText('First instruction in the new branch'), { target: { value: 'Continue' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
        await screen.findByRole('alert')
        fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
        expect(onSubmit.mock.calls[0][0].requestId).toBe(onSubmit.mock.calls[1][0].requestId)
        fireEvent.change(screen.getByLabelText('First instruction in the new branch'), { target: { value: 'Changed instruction' } })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create branch' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3))
        expect(onSubmit.mock.calls[2][0].requestId).not.toBe(onSubmit.mock.calls[0][0].requestId)
    })
})
