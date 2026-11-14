import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    const machineOrder = () => screen.getAllByRole('button', { name: /^Machine (One|Two)/ })
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

function renderSessions(rows: Array<{ id: string; path: string; active: boolean; lastUserMessageAt: number }>) {
    const sessions = rows.map((row): Session => ({
        id: row.id, namespace: 'default', seq: 1, createdAt: 1, lastUserMessageAt: row.lastUserMessageAt, updatedAt: row.lastUserMessageAt,
        active: row.active, activeAt: 1, thinking: false, thinkingAt: 1,
        metadata: { path: row.path, host: 'mac', name: `Row ${row.id}`, machineId: 'm1', ...(row.active ? {} : { lifecycleState: 'archived' }) },
        metadataVersion: 1, agentState: null, agentStateVersion: 1,
        model: null, modelReasoningEffort: null, effort: null, serviceTier: null
    }))
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={sessions.map(s => toSessionSummary(s))}
                        onSelect={vi.fn()} onNewSession={vi.fn()} onRefresh={vi.fn()}
                        isLoading={false} renderHeader={false} api={null}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    return () => screen.queryAllByRole('button', { name: /Row \w+/ }).map(row => row.textContent?.match(/Row ([a-zA-Z]+)/)?.[1])
}

const MIXED_ROWS = [
    { id: 'archivedNew', path: '/a', active: false, lastUserMessageAt: 9_000 },
    { id: 'liveOld', path: '/a', active: true, lastUserMessageAt: 1_000 },
    { id: 'archivedOther', path: '/b', active: false, lastUserMessageAt: 5_000 }
]

it('lists active sessions ahead of archived ones by default', () => {
    const rowOrder = renderSessions(MIXED_ROWS)
    // Archived-only /b stays collapsed as before; within /a the live row leads.
    expect(rowOrder()).toEqual(['liveOld', 'archivedNew'])
})

it('shows archived sessions expanded when filtering to archived only', () => {
    window.localStorage.setItem('hapi-session-list-status', 'archived')
    const rowOrder = renderSessions(MIXED_ROWS)
    expect(rowOrder()).toEqual(['archivedNew', 'archivedOther'])
})

it('keeps the default project order for equally relevant search results', () => {
    window.localStorage.setItem('hapi-session-list-sort', 'created')
    const rowOrder = renderSessions([
        { id: 'archivedNewer', path: '/x', active: false, lastUserMessageAt: 9_000 },
        { id: 'liveOlder', path: '/y', active: true, lastUserMessageAt: 1_000 }
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Search sessions (title, path, Agent, machine name, ID, and more)' }))
    fireEvent.change(screen.getByPlaceholderText('Search title/path/Agent/machine/ID…'), { target: { value: 'Row' } })
    expect(rowOrder()).toEqual(['archivedNewer', 'liveOlder'])
})
