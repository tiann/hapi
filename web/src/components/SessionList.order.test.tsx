import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { toSessionSummary, type Session } from '@hapi/protocol'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    window.localStorage.clear()
})

it('keeps rendered rows and machine filters stable by default, but promotes new user input', () => {
    window.localStorage.clear()
    // An obsolete stored preference must not prevent the new default behavior.
    window.localStorage.setItem('hapi-fixed-session-order', 'true')
    const sessions = ['A', 'B', 'C'].map((id, index): Session => ({
        id, namespace: 'default', seq: 1, createdAt: index + 1,
        lastUserMessageAt: (index + 1) * 1_000, updatedAt: 10_000,
        active: true, activeAt: 10_000, thinking: true, thinkingAt: 10_000,
        metadata: { path: id === 'A' ? '/a' : '/b', host: 'mac', name: `Order ${id}`, machineId: id === 'A' ? 'm1' : 'm2' },
        metadataVersion: 1, agentState: null, agentStateVersion: 1,
        model: null, modelReasoningEffort: null, effort: null, serviceTier: null
    }))
    const client = new QueryClient()
    const list = (rows: Session[]) => (
        <QueryClientProvider client={client}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={rows.map(s => toSessionSummary(s))}
                        onSelect={vi.fn()} onNewSession={vi.fn()} onRefresh={vi.fn()}
                        isLoading={false} renderHeader={false} api={null}
                        machineLabelsById={{ m1: 'Machine One', m2: 'Machine Two' }}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    const { rerender } = render(list(sessions))
    const rowOrder = () => screen.getAllByRole('button', { name: /Order [ABC]/ })
        .map(row => row.textContent?.match(/Order [ABC]/)?.[0])
    const machineOrder = () => screen.getAllByRole('button', { name: /Machine (One|Two)/ })
        .map(button => button.textContent)
    expect(rowOrder()).toEqual(['Order C', 'Order B', 'Order A'])
    const machinesBefore = machineOrder()
    for (let index = 0; index < 6; index++) {
        rerender(list([...sessions].reverse().map(s => ({
            ...s, updatedAt: 20_000 + index * 1_000 + (s.id === 'A' ? 500 : 0)
        }))))
        expect(rowOrder()).toEqual(['Order C', 'Order B', 'Order A'])
        expect(machineOrder()).toEqual(machinesBefore)
    }
    rerender(list(sessions.map(s => s.id === 'A' ? { ...s, lastUserMessageAt: 100_000 } : s)))
    expect(rowOrder()).toEqual(['Order A', 'Order C', 'Order B'])
    expect(machineOrder()).toEqual([...machinesBefore].reverse())
})
