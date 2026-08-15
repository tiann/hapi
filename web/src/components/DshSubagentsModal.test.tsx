import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { DshSubagentsModal } from './DshSubagentsModal'
import type { ApiClient } from '@/api/client'

const API = {
    dshAction: vi.fn(async () => ({
        ok: true as const,
        result: {
            parentAvailable: true,
            entries: [
                { id: 'child-1', kind: 'child', mode: 'continuable', label: 'research', activity: 'running', hasChildren: false },
                { id: 'child-2', kind: 'child', mode: 'one-shot', label: 'refactor', activity: 'inactive' },
            ],
        },
    })),
} as unknown as ApiClient

function renderModal() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onClose = vi.fn()
    const view = render(
        <I18nProvider>
            <QueryClientProvider client={queryClient}>
                <DshSubagentsModal api={API} sessionId="dsh-1" onClose={onClose} />
            </QueryClientProvider>
        </I18nProvider>
    )
    return { onClose, ...view }
}

describe('DshSubagentsModal', () => {
    it('lists subagents with activity state from the DSH catalog', async () => {
        renderModal()
        expect(await screen.findByText('research')).toBeTruthy()
        expect(screen.getByText('refactor')).toBeTruthy()
        expect(screen.getByText('1 running')).toBeTruthy()
        expect(screen.getByText(/continuable/)).toBeTruthy()
        expect(API.dshAction).toHaveBeenCalledWith('dsh-1', { type: 'subagent', action: 'list' })
    })

    it('closes on backdrop click', async () => {
        const { onClose } = renderModal()
        await screen.findByText('research')
        fireEvent.click(document.querySelector('.fixed.inset-0')!)
        expect(onClose).toHaveBeenCalled()
    })
})
