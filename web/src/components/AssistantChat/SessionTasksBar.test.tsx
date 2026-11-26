import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { SessionTask, UpdateSessionTaskRequest } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionTasksBar } from './SessionTasksBar'

const MINUTE = 60_000

function task(overrides: Partial<SessionTask> = {}): SessionTask {
    return {
        id: 'task-1',
        sessionId: 'session-1',
        kind: 'repeat',
        state: 'active',
        items: [{ text: 'check progress' }],
        intervalMs: 10 * MINUTE,
        maxRuns: null,
        runCount: 0,
        totalRuns: null,
        nextRunAt: Date.now() + 10 * MINUTE,
        pending: false,
        lastRunAt: null,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

function setup(options: { tasks?: SessionTask[]; listError?: unknown; updateError?: unknown } = {}) {
    // The fake hub keeps its own copy, like the real one: a refetch after a
    // change returns the changed tasks.
    let current = options.tasks ?? []
    const api = {
        listSessionTasks: vi.fn(async () => {
            if (options.listError) throw options.listError
            return { tasks: current }
        }),
        updateSessionTask: vi.fn(async (_sessionId: string, taskId: string, request: UpdateSessionTaskRequest) => {
            if (options.updateError) throw options.updateError
            current = current.map((entry) => entry.id === taskId
                ? { ...entry, state: request.paused ? 'paused' as const : 'active' as const, nextRunAt: request.paused ? null : entry.nextRunAt }
                : entry)
            return { task: current.find((entry) => entry.id === taskId) ?? task() }
        }),
        deleteSessionTask: vi.fn(async (_sessionId: string, taskId: string) => {
            current = current.filter((entry) => entry.id !== taskId)
        })
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SessionTasksBar api={api as unknown as ApiClient} sessionId="session-1" />
            </I18nProvider>
        </QueryClientProvider>
    )
    return { api }
}

describe('SessionTasksBar', () => {
    it('renders nothing while the session has no tasks', async () => {
        setup()
        await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
        expect(document.body.textContent).toBe('')
    })

    it('hides itself on a hub that has no task routes', async () => {
        setup({ listError: new ApiError('HTTP 404 Not Found', 404) })
        // Nothing ever shows, and no error text leaks into the chat.
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(document.body.textContent).toBe('')
    })

    it('lists each task with its kind, interval and next run', async () => {
        setup({
            tasks: [
                task(),
                task({ id: 'task-2', kind: 'queue', state: 'paused', nextRunAt: null, items: [{ text: 'a' }, { text: 'b' }], runCount: 1, totalRuns: 2, createdAt: 2 })
            ]
        })
        const list = await screen.findByRole('list', { name: 'Tasks' })
        const rows = screen.getAllByRole('listitem')
        expect(rows).toHaveLength(2)
        expect(rows[0].textContent).toContain('Repeat')
        expect(rows[0].textContent).toContain('Every 10 minutes')
        expect(rows[0].textContent).toContain('check progress')
        expect(rows[0].textContent).toContain('Next in 10m')
        expect(rows[1].textContent).toContain('Queue')
        expect(rows[1].textContent).toContain('1/2 sent')
        // The queue's next prompt, not the one already sent.
        expect(rows[1].textContent).toContain('b')
        expect(rows[1].textContent).toContain('Paused')
        expect(list).toBeTruthy()
    })

    it('explains a task that is waiting for its machine', async () => {
        setup({ tasks: [task({ lastError: 'machine_offline', nextRunAt: Date.now() - MINUTE })] })
        const row = await screen.findByRole('listitem')
        expect(row.textContent).toContain('Sends once the machine is back online')
        expect(row.textContent).not.toContain('Next in')
    })

    it('pauses and resumes a task', async () => {
        const { api } = setup({ tasks: [task()] })
        await screen.findByRole('listitem')

        fireEvent.click(screen.getByRole('button', { name: 'Pause task' }))
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { paused: true }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Resume task' })).toBeTruthy())

        fireEvent.click(screen.getByRole('button', { name: 'Resume task' }))
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { paused: false }))
        await screen.findByRole('button', { name: 'Pause task' })
    })

    it('deletes a task', async () => {
        const { api } = setup({ tasks: [task()] })
        await screen.findByRole('listitem')

        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        await waitFor(() => expect(api.deleteSessionTask).toHaveBeenCalledWith('session-1', 'task-1'))
        await waitFor(() => expect(screen.queryByRole('listitem')).toBeNull())
    })

    it('keeps a task running when the hub rejects the pause', async () => {
        const { api } = setup({ tasks: [task()], updateError: new ApiError('HTTP 500 Internal Server Error', 500) })
        await screen.findByRole('listitem')

        fireEvent.click(screen.getByRole('button', { name: 'Pause task' }))

        // The row flipped to "Resume" at once; the failed request put it back.
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { paused: true }))
        expect(await screen.findByRole('button', { name: 'Pause task' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Resume task' })).toBeNull()
        expect(screen.getByRole('listitem').textContent).not.toContain('Paused')
    })
})
