import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionList } from './SessionList'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        }
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                {children}
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SessionList directory action', () => {
    it('starts a new session with the project machine and directory', () => {
        const onNewSessionInDirectory = vi.fn()
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: 'Greeting',
                flavor: 'codex',
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={onNewSessionInDirectory}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))

        expect(onNewSessionInDirectory).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/home/ubuntu',
        })
    })
})
