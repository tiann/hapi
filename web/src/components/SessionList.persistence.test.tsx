import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import type { SessionSummary } from '@/types/api'
import { SessionList } from './SessionList'

const storageKey = 'hapi.projectGroupCollapse.v1.test'
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function session(id: string, path = '/work/project', machineId = 'machine-a'): SessionSummary {
    return {
        id, active: false, thinking: false, activeAt: 0, updatedAt: 100,
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0,
        todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [],
        pendingRequests: [], backgroundTaskCount: 0, futureScheduledMessageCount: 0,
        nextScheduledAt: null, model: null, effort: null,
        metadata: { path, machineId, name: id, flavor: 'codex' },
    }
}

function list(options: {
    sessions?: SessionSummary[]; selected?: string | null; scope?: string; loading?: boolean
} = {}) {
    return <StrictMode><QueryClientProvider client={queryClient}>
        <ToastProvider><I18nProvider>
            <SessionList sessions={options.sessions ?? [session('task')]}
                selectedSessionId={options.selected ?? null}
                collapseStorageKey={options.scope ?? storageKey}
                isLoading={options.loading ?? false} api={null} renderHeader={false}
                onSelect={vi.fn()} onNewSession={vi.fn()} onRefresh={vi.fn()} />
        </I18nProvider></ToastProvider>
    </QueryClientProvider></StrictMode>
}

function header(path = '/work/project') { return screen.getByTitle(path) }
function isOpen(path = '/work/project') {
    return header(path).nextElementSibling?.getAttribute('data-open') === 'true'
}

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SessionList manual project preferences', () => {
    it('restores an explicit expansion after remounting', () => {
        const view = render(list())
        expect(isOpen()).toBe(false)
        fireEvent.click(header())
        expect(isOpen()).toBe(true)
        view.unmount()
        render(list())
        expect(isOpen()).toBe(true)
    })

    it('restores an explicit collapse of an active project', () => {
        const sessions = [{ ...session('task'), active: true }]
        const view = render(list({ sessions }))
        expect(isOpen()).toBe(true)
        fireEvent.click(header())
        view.unmount()
        render(list({ sessions }))
        expect(isOpen()).toBe(false)
    })

    it('reveals a selected session without replacing a saved collapse', () => {
        const view = render(list())
        fireEvent.click(header())
        fireEvent.click(header())
        const saved = localStorage.getItem(storageKey)
        view.rerender(list({ selected: 'task' }))
        expect(isOpen()).toBe(true)
        expect(localStorage.getItem(storageKey)).toBe(saved)
        view.unmount()
        render(list())
        expect(isOpen()).toBe(false)
    })

    it('keeps a manual collapse during selected-session live updates', () => {
        const view = render(list({ selected: 'task' }))
        fireEvent.click(header())
        view.rerender(list({ selected: 'task', sessions: [{ ...session('task'), updatedAt: 200 }] }))
        expect(isOpen()).toBe(false)
        view.unmount()
        render(list())
        expect(isOpen()).toBe(false)
    })

    it('does not persist selection-driven expansion of untouched groups', () => {
        const view = render(list({ selected: 'task' }))
        expect(isOpen()).toBe(true)
        expect(localStorage.getItem(storageKey)).toBeNull()
        view.unmount()
        render(list())
        expect(isOpen()).toBe(false)
    })

    it('does not overwrite preferences while searching or filtering out all sessions', () => {
        const view = render(list())
        fireEvent.click(header())
        fireEvent.click(header())
        const saved = localStorage.getItem(storageKey)
        fireEvent.click(screen.getByRole('button', { name: /^Search sessions/ }))
        const input = screen.getByPlaceholderText('Search title/path/Agent/machine/ID…')
        fireEvent.change(input, { target: { value: 'task' } })
        expect(isOpen()).toBe(true)
        fireEvent.change(input, { target: { value: 'no-matches' } })
        fireEvent.change(input, { target: { value: '' } })
        expect(isOpen()).toBe(false)
        expect(localStorage.getItem(storageKey)).toBe(saved)
        view.unmount()
        render(list())
        expect(isOpen()).toBe(false)
    })

    it('keeps saved expansions while initial data is empty or a project temporarily disappears', () => {
        const view = render(list())
        fireEvent.click(header())
        view.unmount()
        const next = render(list({ sessions: [], loading: true }))
        next.rerender(list())
        expect(isOpen()).toBe(true)
        next.rerender(list({ sessions: [] }))
        next.rerender(list())
        expect(isOpen()).toBe(true)
    })

    it('does not save a hidden toggle while search forces the group open', () => {
        render(list())
        fireEvent.click(header())
        const saved = localStorage.getItem(storageKey)
        fireEvent.click(screen.getByRole('button', { name: /^Search sessions/ }))
        const input = screen.getByPlaceholderText('Search title/path/Agent/machine/ID…')
        fireEvent.change(input, { target: { value: 'task' } })
        fireEvent.click(header())
        fireEvent.change(input, { target: { value: '' } })
        expect(isOpen()).toBe(true)
        expect(localStorage.getItem(storageKey)).toBe(saved)
    })

    it('restores a collapsed selected project after search temporarily excludes it', () => {
        render(list({ selected: 'task' }))
        fireEvent.click(header())
        const saved = localStorage.getItem(storageKey)
        fireEvent.click(screen.getByRole('button', { name: /^Search sessions/ }))
        const input = screen.getByPlaceholderText('Search title/path/Agent/machine/ID…')
        fireEvent.change(input, { target: { value: 'no-matches' } })
        fireEvent.change(input, { target: { value: '' } })
        expect(isOpen()).toBe(false)
        expect(localStorage.getItem(storageKey)).toBe(saved)
    })

    it('isolates preferences when the Hub or user storage scope changes', () => {
        const view = render(list())
        fireEvent.click(header())
        view.rerender(list({ scope: 'another-scope' }))
        expect(isOpen()).toBe(false)
        view.rerender(list())
        expect(isOpen()).toBe(true)
        expect(localStorage.getItem('another-scope')).toBeNull()
    })

    it('does not apply a saved project preference to another machine or directory', () => {
        const view = render(list())
        fireEvent.click(header())
        view.rerender(list({ sessions: [session('task', '/work/project', 'machine-b')] }))
        expect(isOpen()).toBe(false)
        view.rerender(list({ sessions: [session('task', '/work/other')] }))
        expect(isOpen('/work/other')).toBe(false)
        view.rerender(list())
        expect(isOpen()).toBe(true)
    })

    it('restores the inactive project expanded beneath the pinned active session', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        const sessions = [session('task'), { ...session('running'), active: true, thinking: true }]
        const view = render(list({ sessions, selected: 'running' }))
        expect(isOpen()).toBe(false)
        fireEvent.click(header())
        view.unmount()
        render(list({ sessions, selected: 'running' }))
        expect(isOpen()).toBe(true)
    })

    it('keeps toggles functional when browser storage fails', () => {
        vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
        vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
        render(list())
        fireEvent.click(header())
        expect(isOpen()).toBe(true)
        fireEvent.click(header())
        expect(isOpen()).toBe(false)
    })

    it('preserves manual preferences with user-activity ordering', () => {
        const sessions = [
            { ...session('older'), createdAt: 100, lastUserMessageAt: 100, updatedAt: 999, active: true },
            { ...session('newer'), createdAt: 200, lastUserMessageAt: 200, updatedAt: 1 },
        ]
        const view = render(list({ sessions }))
        expect(screen.queryByTitle('In progress')).toBeNull()
        expect(isOpen()).toBe(true)
        const project = header().nextElementSibling!
        expect(Array.from(project.querySelectorAll('button')).slice(0, 2).map(button => button.textContent))
            .toEqual([expect.stringContaining('newer'), expect.stringContaining('older')])
        fireEvent.click(header())
        view.unmount()
        const reopened = render(list({ sessions }))
        expect(isOpen()).toBe(false)
        reopened.rerender(list({ sessions: sessions.map(item => ({ ...item, updatedAt: 2000 })) }))
        expect(isOpen()).toBe(false)
    })
})
