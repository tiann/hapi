import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionTask, SessionTaskDeleteResponse, SessionTaskRun, UpdateSessionTaskRequest } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast } from '@/lib/toast-context'
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
        startAt: 1,
        lastRunAt: null,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

function run(overrides: Partial<SessionTaskRun> = {}): SessionTaskRun {
    return {
        id: 'run-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        taskKind: 'queue',
        runNumber: 1,
        outcome: 'sent',
        scheduledFor: Date.now() - 30 * MINUTE,
        recordedAt: Date.now() - 30 * MINUTE,
        takenAt: null,
        detail: null,
        preview: 'first prompt',
        ...overrides
    }
}

type HubOptions = {
    tasks?: SessionTask[]
    /** Rejects the task list with this error, every time. */
    listError?: unknown
    /** Lets the first list call through, then rejects the refetch, so a rollback cannot be repaired by a refetch. */
    listFailsAfterFirst?: unknown
    runs?: SessionTaskRun[]
    historyError?: unknown
    updateError?: unknown
    runError?: unknown
    deleteError?: unknown
    deleteResult?: SessionTaskDeleteResponse
}

/** The fake hub keeps its own copy, like the real one: a refetch after a change returns the changed tasks. */
function fakeHub(options: HubOptions = {}) {
    let current = options.tasks ?? []
    let listCalls = 0
    const api = {
        listSessionTasks: vi.fn(async () => {
            listCalls += 1
            if (options.listError) throw options.listError
            if (options.listFailsAfterFirst && listCalls > 1) throw options.listFailsAfterFirst
            return { tasks: current }
        }),
        updateSessionTask: vi.fn(async (_sessionId: string, taskId: string, request: UpdateSessionTaskRequest) => {
            if (options.updateError) throw options.updateError
            current = current.map((entry) => entry.id === taskId
                ? {
                    ...entry,
                    state: request.paused === undefined ? entry.state : request.paused ? 'paused' as const : 'active' as const,
                    // Like the hub: no next run while paused; a resumed task is due one interval from now.
                    nextRunAt: request.paused === true ? null : request.paused === false ? Date.now() + entry.intervalMs : entry.nextRunAt,
                    lastError: request.paused === false ? null : entry.lastError,
                    items: request.text !== undefined ? [{ text: request.text }] : entry.items,
                    intervalMs: request.intervalMs ?? entry.intervalMs,
                    maxRuns: request.maxRuns === undefined ? entry.maxRuns : request.maxRuns
                }
                : entry)
            return { task: current.find((entry) => entry.id === taskId) ?? task() }
        }),
        deleteSessionTask: vi.fn(async (_sessionId: string, taskId: string): Promise<SessionTaskDeleteResponse> => {
            if (options.deleteError) throw options.deleteError
            current = current.filter((entry) => entry.id !== taskId)
            return options.deleteResult ?? { ok: true, prompt: 'none' }
        }),
        runSessionTask: vi.fn(async (_sessionId: string, taskId: string) => {
            if (options.runError) throw options.runError
            current = current.map((entry) => entry.id === taskId
                ? { ...entry, state: 'active' as const, lastError: null, nextRunAt: Date.now() }
                : entry)
            return { task: current.find((entry) => entry.id === taskId) ?? task() }
        }),
        listSessionTaskRuns: vi.fn(async () => {
            if (options.historyError) throw options.historyError
            return { runs: options.runs ?? [] }
        }),
    }
    return {
        api,
        listCalls: () => listCalls,
        /** What the hub does when a task finishes or is deleted elsewhere: it is simply gone. */
        drop: (taskId: string) => {
            current = current.filter((entry) => entry.id !== taskId)
        },
    }
}

type Hub = ReturnType<typeof fakeHub>

/** Answers a hub call only when the test says so, with the answer the fake hub would have given (its state applied). */
function deferResponse<A extends unknown[], R>(fn: Mock<(...args: A) => Promise<R>>) {
    const likeHub = fn.getMockImplementation()!
    let release!: () => void
    fn.mockImplementation((async (...args: A) => {
        const result = await likeHub(...args)
        return await new Promise<R>((resolve) => {
            release = () => resolve(result)
        })
    }) as (...args: A) => Promise<R>)
    return () => release()
}

function ToastMessages() {
    const { toasts } = useToast()
    return <div data-testid="toasts">{toasts.map((toast) => <span key={toast.id}>{toast.title}</span>)}</div>
}

function mount(hub: Hub, withToasts = false) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const bar = <SessionTasksBar api={hub.api as unknown as ApiClient} sessionId="session-1" />
    render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                {withToasts ? <ToastProvider><ToastMessages />{bar}</ToastProvider> : bar}
            </I18nProvider>
        </QueryClientProvider>
    )
    return { api: hub.api, listCalls: hub.listCalls, drop: hub.drop, queryClient }
}

function setup(options: HubOptions = {}, withToasts = true) {
    return mount(fakeHub(options), withToasts)
}

/** Waits for the first list call to settle; the bar shows nothing before that. */
async function settleList(api: Hub['api']) {
    await waitFor(() => expect(api.listSessionTasks).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
}

async function refetchTasks(queryClient: QueryClient) {
    await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['session-tasks', 'session-1'] })
    })
}

describe('SessionTasksBar', () => {
    it('renders nothing while the session has no tasks, once the list has loaded', async () => {
        const { api, listCalls } = setup()
        await settleList(api)
        await act(async () => { await Promise.resolve() })
        expect(listCalls()).toBe(1)
        expect(screen.queryByText('Tasks')).toBeNull()
        expect(screen.queryByRole('alert')).toBeNull()
        expect(document.body.textContent).toBe('')
    })

    it('hides itself on a hub that has no task routes, without retrying or showing an error', async () => {
        const { api, listCalls } = setup({ listError: new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404) })
        await settleList(api)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(listCalls()).toBe(1)
        expect(screen.queryByText('Tasks')).toBeNull()
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    })

    it('lists each task with its kind, cadence and next run', async () => {
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
        expect(rows[1].textContent).toContain('Gap 10 minutes')
        expect(rows[1].textContent).toContain('1/2 sent')
        // The queue's next prompt, not the one already sent.
        expect(rows[1].textContent).toContain('b')
        expect(rows[1].textContent).toContain('Paused')
        expect(list).toBeTruthy()
        // The rules the bar follows, in short.
        expect(screen.getByText('If the agent is still busy when a run is due, that run is skipped.')).toBeTruthy()
        expect(screen.getByText('If the session is not running, the hub resumes it first.')).toBeTruthy()
    })

    it('says "every minute" for a one-unit interval', async () => {
        setup({ tasks: [task({ intervalMs: MINUTE, nextRunAt: Date.now() + MINUTE })] })
        const row = await screen.findByRole('listitem')
        expect(row.textContent).toContain('Every minute')
        expect(row.textContent).not.toContain('Every 1 minutes')
    })

    it('keeps the count of a one-unit gap for a queue: "Gap 1 minute", never "Gap minute"', async () => {
        const queue = (id: string, text: string, intervalMs: number, createdAt: number) => task({
            id,
            kind: 'queue',
            items: [{ text }],
            totalRuns: 1,
            intervalMs,
            nextRunAt: Date.now() + intervalMs,
            createdAt
        })
        setup({ tasks: [
            queue('task-1', 'a', MINUTE, 1),
            queue('task-2', 'b', 60 * MINUTE, 2),
            queue('task-3', 'c', 24 * 60 * MINUTE, 3),
            queue('task-4', 'd', 5 * MINUTE, 4)
        ] })
        const rows = await screen.findAllByRole('listitem')
        // "Every minute" reads well without the count; a gap does not.
        expect(rows[0].textContent).toContain('Gap 1 minute')
        expect(rows[0].textContent).not.toContain('Gap minute')
        expect(rows[1].textContent).toContain('Gap 1 hour')
        expect(rows[1].textContent).not.toContain('Gap hour')
        expect(rows[2].textContent).toContain('Gap 1 day')
        expect(rows[2].textContent).not.toContain('Gap day')
        expect(rows[3].textContent).toContain('Gap 5 minutes')
    })

    it('shows the prompt that is out while it waits, then the next one', async () => {
        const queue = (pending: boolean) => task({
            kind: 'queue',
            items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
            runCount: 1,
            totalRuns: 3,
            pending,
            nextRunAt: pending ? null : Date.now() + 5 * MINUTE
        })
        const { api, queryClient } = setup({ tasks: [queue(true)] })
        let row = await screen.findByRole('listitem')
        expect(row.textContent).toContain('Sent, waiting for the agent')
        expect(row.querySelector('span.line-clamp-2')?.textContent).toBe('a')
        // "Run now" is withheld while the task already has a prompt out, and the button says why.
        const runNow = within(row).getByRole('button', { name: 'Run now' })
        expect(runNow).toBeDisabled()
        expect(runNow).toHaveAttribute('title', 'A prompt of this task is still waiting for the agent.')

        vi.mocked(api.listSessionTasks).mockResolvedValue({ tasks: [queue(false)] })
        await refetchTasks(queryClient)
        await waitFor(() => expect(screen.getByRole('listitem').querySelector('span.line-clamp-2')?.textContent).toBe('b'))
        row = screen.getByRole('listitem')
        expect(row.textContent).toContain('Next in 5m')
        expect(row.textContent).not.toContain('Sent, waiting')
        expect(within(row).getByRole('button', { name: 'Run now' })).not.toBeDisabled()
    })

    it.each<[SessionTask['lastError'], string]>([
        ['machine_offline', 'Sends once the machine is back online'],
        ['session_unavailable', 'The session cannot be resumed right now; retrying'],
        ['session_archived', 'The session is archived; nothing runs until it is reopened'],
        ['prompt_indeterminate', 'Whether the agent took the prompt is unknown; retry or discard it in the queued messages'],
        ['prompt_not_taken', 'Sent, but the agent has not taken the prompt'],
        ['send_failed', 'The last run failed; retrying']
    ])('explains a task held up by %s in its own words', async (lastError, text) => {
        setup({ tasks: [task({ lastError, nextRunAt: Date.now() - MINUTE })] })
        const row = await screen.findByRole('listitem')
        expect(row.textContent).toContain(text)
        expect(row.textContent).not.toContain('Next in')
        expect(row.textContent).not.toContain('the task is paused')
    })

    it('announces the stable status line, not the countdown, and is not one live region', async () => {
        setup({ tasks: [task({ nextRunAt: Date.now() + 10 * MINUTE })] })
        const row = await screen.findByRole('listitem')
        expect(screen.queryByRole('status')).toBeNull()
        const live = row.querySelector('[aria-live="polite"]')
        expect(live).toBeTruthy()
        expect(live?.textContent).toMatch(/^Next .*\d/)
        expect(live?.textContent).not.toContain('Next in 10m')
        const visible = row.querySelector('[aria-hidden="true"][title]')
        expect(visible?.textContent).toBe('Next in 10m')
    })

    it('pauses and resumes a task, showing the new state before the hub answers', async () => {
        const hub = fakeHub({ tasks: [task()] })
        const answerUpdate = deferResponse(hub.api.updateSessionTask)
        mount(hub)
        await screen.findByRole('listitem')

        fireEvent.click(screen.getByRole('button', { name: 'Pause task' }))
        // The hub has not answered yet...
        expect(hub.api.updateSessionTask.mock.calls[0]).toBeUndefined()
        await screen.findByRole('button', { name: 'Resume task' })
        expect(screen.getByRole('listitem').textContent).toContain('Paused')
        await waitFor(() => expect(hub.api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { paused: true }))
        await act(async () => {
            answerUpdate()
            await Promise.resolve()
        })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Resume task' })).not.toBeDisabled())

        fireEvent.click(screen.getByRole('button', { name: 'Resume task' }))
        // Until the hub reports the next run, the row says it is starting rather than showing a stale state.
        await waitFor(() => expect(hub.api.updateSessionTask).toHaveBeenCalledTimes(2))
        await act(async () => { await Promise.resolve() })
        expect(screen.getByRole('button', { name: 'Pause task' })).toBeTruthy()
        expect(screen.getByRole('listitem').textContent).not.toContain('Paused')
        expect(screen.getByRole('listitem').textContent).toContain('Starting…')
        await act(async () => {
            answerUpdate()
            await Promise.resolve()
        })
        await waitFor(() => expect(screen.getByRole('listitem').textContent).toContain('Next in 10m'))
    })

    it('drops the stale error of a resumed task before the hub answers', async () => {
        const hub = fakeHub({ tasks: [task({ state: 'paused', nextRunAt: null, lastError: 'session_unavailable' })] })
        const answerUpdate = deferResponse(hub.api.updateSessionTask)
        mount(hub)
        await screen.findByRole('listitem')
        expect(screen.getByRole('listitem').textContent).toContain('Paused')

        fireEvent.click(screen.getByRole('button', { name: 'Resume task' }))
        await screen.findByRole('button', { name: 'Pause task' })
        // The hub has not answered, and the row no longer carries the error the pause was saved with.
        expect(screen.getByRole('listitem').textContent).not.toContain('The session cannot be resumed')
        expect(screen.getByRole('listitem').textContent).toContain('Starting…')
        await act(async () => {
            answerUpdate()
            await Promise.resolve()
        })
    })

    it('keeps a task running when the hub rejects the pause, even though no refetch can repair it', async () => {
        let rejectUpdate!: (reason: unknown) => void
        const hub = fakeHub({ tasks: [task()], listFailsAfterFirst: new ApiError('HTTP 502 Bad Gateway', 502) })
        hub.api.updateSessionTask.mockImplementation(() => new Promise((_resolve, reject) => { rejectUpdate = reject }))
        mount(hub, true)
        await screen.findByRole('listitem')

        fireEvent.click(screen.getByRole('button', { name: 'Pause task' }))
        // The row flipped at once, before the hub has said anything...
        await screen.findByRole('button', { name: 'Resume task' })
        expect(screen.getByRole('listitem').textContent).toContain('Paused')
        expect(screen.getByTestId('toasts').textContent).toBe('')
        await waitFor(() => expect(hub.api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { paused: true }))
        // ...and the refusal put it back, by rollback alone (the refetch fails too), and said so.
        await act(async () => {
            rejectUpdate(new ApiError('HTTP 500 Internal Server Error', 500))
            await Promise.resolve()
        })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Pause task' })).toBeTruthy())
        expect(screen.queryByRole('button', { name: 'Resume task' })).toBeNull()
        expect(screen.getByRole('listitem').textContent).not.toContain('Paused')
        expect(screen.getByTestId('toasts').textContent).toBe('The task could not be paused.')
        await waitFor(() => expect(hub.api.listSessionTasks).toHaveBeenCalledTimes(2))
    })

    it('says so as well when the hub refuses to resume a task', async () => {
        setup({ tasks: [task({ state: 'paused', nextRunAt: null })], updateError: new ApiError('HTTP 500 Internal Server Error', 500) })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Resume task' }))
        await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('The task could not be resumed.'))
        await waitFor(() => expect(screen.getByRole('listitem').textContent).toContain('Paused'))
    })

    it('drops a task the hub no longer has when a pause answers 404, even if the refetch fails', async () => {
        const gone = new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404, 'Task not found')
        const { api } = setup({ tasks: [task(), task({ id: 'task-2', createdAt: 2 })], updateError: gone, listFailsAfterFirst: new Error('offline') })
        await screen.findAllByRole('listitem')

        fireEvent.click(screen.getAllByRole('button', { name: 'Pause task' })[0])
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { paused: true }))
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))
        expect(screen.getAllByRole('listitem')[0].getAttribute('data-task-id')).toBe('task-2')
        // The failed refetch is visible, with a way to retry, instead of a silent empty bar.
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Tasks could not be loaded.'), { timeout: 6000 })
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
        // A task that is gone was not "refused": no note claims the pause failed.
        expect(screen.getByTestId('toasts').textContent).toBe('')
    })

    it('deletes a task only after a confirmation', async () => {
        const { api } = setup({ tasks: [task()] })
        await screen.findByRole('listitem')

        // The first tap asks; nothing is sent yet, and the safe answer has the focus.
        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        const question = screen.getByRole('group', { name: 'Delete this task? Prompts not sent yet are lost.' })
        expect(api.deleteSessionTask).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Keep task' }))

        fireEvent.click(within(question).getByRole('button', { name: 'Keep task' }))
        expect(screen.queryByRole('group', { name: /Delete this task/ })).toBeNull()
        expect(api.deleteSessionTask).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete task' }))

        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
        expect(screen.queryByRole('group', { name: /Delete this task/ })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        fireEvent.click(within(screen.getByRole('group', { name: /Delete this task/ })).getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(api.deleteSessionTask).toHaveBeenCalledWith('session-1', 'task-1'))
        await waitFor(() => expect(screen.queryByRole('listitem')).toBeNull())
    })

    it('brings a task back when the hub refuses the delete, says so, and puts focus back on Delete', async () => {
        const refused = setup({ tasks: [task()], deleteError: new ApiError('HTTP 500 Internal Server Error', 500), listFailsAfterFirst: new Error('offline') })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(refused.api.deleteSessionTask).toHaveBeenCalled())
        // Back once the hub refuses; the refetch cannot have repaired it, it fails too.
        await screen.findByRole('button', { name: 'Pause task' })
        expect(screen.getByRole('listitem').textContent).toContain('check progress')
        // The row returning by itself would read as "nothing happened": the refusal is said out loud.
        expect(screen.getByTestId('toasts').textContent).toBe('The task could not be deleted.')
        // The question's buttons are gone, so the keyboard would be on the page; it goes back to where it came from.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Delete task' })).not.toBeDisabled())
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete task' }))
    })

    it('says when the prompt of a deleted task could not be pulled back', async () => {
        const unconfirmed = setup({ tasks: [task({ id: 'task-9' })], deleteResult: { ok: true, prompt: 'unconfirmed' } })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe(
            'Task deleted, but its pending prompt could not be cancelled. Retry or discard it in the queued messages.'
        ))
        await waitFor(() => expect(screen.queryByRole('listitem')).toBeNull())
        expect(unconfirmed.api.deleteSessionTask).toHaveBeenCalledWith('session-1', 'task-9')
    })

    it('keeps a task deleted when the delete answers 404 although the refetch fails', async () => {
        const { api } = setup({ tasks: [task()], deleteError: new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404), listFailsAfterFirst: new Error('offline') })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(api.deleteSessionTask).toHaveBeenCalled())
        await act(async () => { await Promise.resolve() })
        await act(async () => { await Promise.resolve() })
        expect(screen.queryByRole('listitem')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Pause task' })).toBeNull()
    })

    it('says when the agent took the prompt before the task was deleted', async () => {
        setup({ tasks: [task()], deleteResult: { ok: true, prompt: 'taken' } })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('Task deleted. The agent had already taken its prompt.'))
    })

    it('shows a failed load with a retry instead of a silent empty bar', async () => {
        const { api } = setup({ tasks: [task()], listError: new ApiError('HTTP 502 Bad Gateway', 502) })
        // The query's own policy retries a 5xx twice before the bar gives up.
        const alert = await screen.findByRole('alert', {}, { timeout: 6000 })
        expect(alert.textContent).toContain('Tasks could not be loaded.')
        expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy()
        expect(screen.queryByRole('listitem')).toBeNull()

        vi.mocked(api.listSessionTasks).mockImplementation(async () => ({ tasks: [task()] }))
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
        const row = await screen.findByRole('listitem')
        expect(row.textContent).toContain('check progress')
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('runs a task now, showing it due at once and clearing its error', async () => {
        const hub = fakeHub({ tasks: [task({ state: 'paused', nextRunAt: null, lastError: 'session_unavailable' })] })
        const answerRun = deferResponse(hub.api.runSessionTask)
        mount(hub)
        await screen.findByRole('listitem')
        expect(screen.getByRole('listitem').textContent).toContain('Paused')

        fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
        await waitFor(() => expect(hub.api.runSessionTask).toHaveBeenCalledWith('session-1', 'task-1'))
        await act(async () => { await Promise.resolve() })
        expect(screen.getByRole('listitem').textContent).toContain('Due now; sending next')
        expect(screen.getByRole('listitem').textContent).not.toContain('Paused')
        await act(async () => {
            answerRun()
            await Promise.resolve()
        })
        // The hub's own answer: active again, the run due, the old error gone.
        await waitFor(() => expect(screen.getByRole('listitem').textContent).toContain('Due now'))
        expect(screen.getByRole('listitem').textContent).not.toContain('session cannot be resumed')
    })

    it('keeps the row as it was and says why when the hub refuses "run now" because a prompt is pending', async () => {
        const { api } = setup({ tasks: [task()], runError: new ApiError('HTTP 409 Conflict: {"code":"prompt_pending"}', 409, 'prompt_pending') })
        await screen.findByRole('listitem')
        // The cache still says nothing is pending (the event has not arrived yet), so the button is live.
        fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
        await waitFor(() => expect(api.runSessionTask).toHaveBeenCalled())
        await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('A prompt of this task is still waiting for the agent.'))
        await waitFor(() => expect(screen.getByRole('listitem').textContent).toContain('Next in 10m'))
    })

    it('drops a task whose "run now" answers 404', async () => {
        setup({ tasks: [task()], runError: new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404), listFailsAfterFirst: new Error('offline') })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
        await waitFor(() => expect(screen.queryByRole('listitem')).toBeNull())
    })

    it('edits a repeat task in place with the composer form\'s own fields, sending only what changed', async () => {
        const { api } = setup({ tasks: [task({ maxRuns: 5, runCount: 2 })] })
        await screen.findByRole('listitem')

        fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        expect((within(editor).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('check progress')
        expect((within(editor).getByLabelText('Every') as HTMLInputElement).value).toBe('10')
        expect((within(editor).getByLabelText('Runs') as HTMLInputElement).value).toBe('5')
        // Nothing changed yet: Save waits.
        expect(within(editor).getByRole('button', { name: 'Save changes' })).toBeDisabled()

        // Enter in the message field is a newline, not a submit.
        const message = within(editor).getByLabelText('Message')
        expect(fireEvent.keyDown(message, { key: 'Enter' })).toBe(true)
        expect(api.updateSessionTask).not.toHaveBeenCalled()

        fireEvent.change(message, { target: { value: 'check progress\nand the build' } })
        fireEvent.change(within(editor).getByLabelText('Every'), { target: { value: '30' } })
        fireEvent.change(within(editor).getByLabelText('Runs'), { target: { value: '1' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
        expect((await screen.findByRole('alert')).textContent).toBe('The limit cannot be below the 2 runs already sent.')
        expect(api.updateSessionTask).not.toHaveBeenCalled()

        fireEvent.change(within(editor).getByLabelText('Runs'), { target: { value: '5' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', {
            text: 'check progress\nand the build',
            intervalMs: 30 * MINUTE
        }))
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())
        expect((await screen.findByRole('listitem')).textContent).toContain('Every 30 minutes')
        expect(screen.getByRole('listitem').querySelector('span.line-clamp-2')?.textContent).toBe('check progress\nand the build')
    })

    it('lets the open editor take the height it needs instead of scrolling inside the capped task list', async () => {
        setup({ tasks: [task()] })
        await screen.findByRole('listitem')
        const list = screen.getByRole('list', { name: 'Tasks' })
        // Many tasks scroll inside the bar. The editor opens inside the list, under its row: capped, its own
        // fields would scroll in a small inner box with Save below the fold (jsdom lays nothing out, so the
        // classes are what is checked).
        expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-h-48', 'overflow-y-auto']))

        fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        expect(editor.closest('ul')).toBe(list)
        expect(list.className.split(/\s+/)).not.toContain('max-h-48')
        expect(list.className.split(/\s+/)).not.toContain('overflow-y-auto')

        // Closed, the list is capped again.
        fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())
        expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-h-48', 'overflow-y-auto']))
    })

    it('closes the editor when the task being edited leaves the list, so the list is capped and its hints are back', async () => {
        const view = setup({ tasks: [task(), task({ id: 'task-2', kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], totalRuns: 2, createdAt: 2 })] })
        const rows = await screen.findAllByRole('listitem')
        const list = screen.getByRole('list', { name: 'Tasks' })
        const wake = 'If the session is not running, the hub resumes it first.'
        fireEvent.click(within(rows[0]).getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        expect(list.className.split(/\s+/)).not.toContain('max-h-48')
        // The bar's own line stepped aside for the editor's copy of the rule.
        expect(within(editor).getByText(wake)).toBeTruthy()
        expect(screen.getAllByText(wake)).toHaveLength(1)

        // The task ends without its row's buttons: an edit that brings its run limit down to what already
        // ran, a delete on another device, a finish. The hub's event has the list refetched.
        view.drop('task-1')
        await refetchTasks(view.queryClient)
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())
        expect(screen.getAllByRole('listitem')).toHaveLength(1)
        expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-h-48', 'overflow-y-auto']))
        // No editor is left, so the one line there is the bar's own again.
        expect(screen.getAllByText(wake)).toHaveLength(1)
    })

    it('does not say its rule hints twice under an open editor, which carries them for the task being edited', async () => {
        setup({ tasks: [task(), task({ id: 'task-2', kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], totalRuns: 2, createdAt: 2 })] })
        const rows = await screen.findAllByRole('listitem')
        const skip = 'If the agent is still busy when a run is due, that run is skipped.'
        const wake = 'If the session is not running, the hub resumes it first.'
        expect(screen.getAllByText(skip)).toHaveLength(1)
        expect(screen.getAllByText(wake)).toHaveLength(1)

        // A repeat task: its editor repeats both rules, so the bar's own lines step aside.
        fireEvent.click(within(rows[0]).getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        expect(within(editor).getAllByText(skip)).toHaveLength(1)
        expect(within(editor).getAllByText(wake)).toHaveLength(1)
        expect(screen.getAllByText(skip)).toHaveLength(1)
        expect(screen.getAllByText(wake)).toHaveLength(1)

        fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())
        expect(screen.getAllByText(skip)).toHaveLength(1)
        expect(screen.getAllByText(wake)).toHaveLength(1)

        // A queue: its editor carries the wake rule too.
        fireEvent.click(within(rows[1]).getByRole('button', { name: 'Edit task' }))
        await screen.findByRole('group', { name: 'Edit task' })
        expect(screen.getAllByText(wake)).toHaveLength(1)
    })

    it('closes the editor on Escape and puts focus back on the Edit button', async () => {
        setup({ tasks: [task()] })
        await screen.findByRole('listitem')
        const edit = screen.getByRole('button', { name: 'Edit task' })
        edit.focus()
        fireEvent.click(edit)
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        const message = within(editor).getByLabelText('Message')
        fireEvent.change(message, { target: { value: 'discarded' } })
        message.focus()
        fireEvent.keyDown(message, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit task' }))
        expect(screen.getByRole('listitem').textContent).toContain('check progress')
    })

    it('keeps the editor and the delete question open on the Escape that dismisses an IME candidate list', async () => {
        setup({ tasks: [task()] })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        const message = within(editor).getByLabelText('Message')
        fireEvent.change(message, { target: { value: '進捗を確認' } })
        message.focus()
        // While a candidate list is up, Chrome reports keydown Escape with isComposing set.
        fireEvent.keyDown(message, { key: 'Escape', isComposing: true })
        expect(screen.getByRole('group', { name: 'Edit task' })).toBeTruthy()
        expect(document.activeElement).toBe(message)
        fireEvent.keyDown(message, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())

        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
        const keep = within(screen.getByRole('group', { name: /Delete this task/ })).getByRole('button', { name: 'Keep task' })
        fireEvent.keyDown(keep, { key: 'Escape', isComposing: true })
        expect(screen.getByRole('group', { name: /Delete this task/ })).toBeTruthy()
        fireEvent.keyDown(keep, { key: 'Escape' })
        expect(screen.queryByRole('group', { name: /Delete this task/ })).toBeNull()
    })

    it('edits the prompts a queue has not sent yet, as rows, and keeps the sent ones', async () => {
        const { api } = setup({ tasks: [task({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], runCount: 1, totalRuns: 3 })] })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        // Only the unsent tail is editable: the first row is "b", not "a".
        expect((within(editor).getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('b')
        expect((within(editor).getByLabelText('Message 2') as HTMLTextAreaElement).value).toBe('c')
        expect(within(editor).getByLabelText('Gap')).toBeTruthy()
        expect(within(editor).queryByLabelText('Every')).toBeNull()

        fireEvent.change(within(editor).getByLabelText('Message 2'), { target: { value: 'c\nwith more' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Add message' }))
        fireEvent.change(within(editor).getByLabelText('Message 3'), { target: { value: 'd' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', {
            items: [{ text: 'b' }, { text: 'c\nwith more' }, { text: 'd' }]
        }))
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())
    })

    it('refreshes the rows of an open queue editor when the queue sends a prompt meanwhile, instead of queueing it twice', async () => {
        const queue = (runCount: number, pending: boolean) => task({
            kind: 'queue',
            items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
            runCount,
            totalRuns: 3,
            pending,
            nextRunAt: pending ? null : Date.now() + MINUTE
        })
        const { api, queryClient } = setup({ tasks: [queue(1, false)] })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
        await screen.findByRole('group', { name: 'Edit task' })
        expect((screen.getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('b')

        // The hub sends "b" while the editor is open; the row above shows it waiting, the editor's rows do not move.
        vi.mocked(api.listSessionTasks).mockResolvedValue({ tasks: [queue(2, true)] })
        await refetchTasks(queryClient)
        // (The editor's own rows are list items too, so the task row is the one the Tasks list holds.)
        await waitFor(() => expect(screen.getByRole('list', { name: 'Tasks' }).querySelector('[data-task-id]')?.textContent).toContain('Sent, waiting'))
        const editor = screen.getByRole('group', { name: 'Edit task' })
        expect((within(editor).getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('b')
        fireEvent.change(within(editor).getByLabelText('Message 1'), { target: { value: 'b edited' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))

        // Nothing is sent: "b" is already out, and the stale rows would have put it in the queue a second time.
        expect(api.updateSessionTask).not.toHaveBeenCalled()
        expect((await screen.findByRole('alert')).textContent).toBe('The queue sent a prompt meanwhile, so the rows were refreshed. Review them and save again.')
        expect(within(editor).queryByLabelText('Message 2')).toBeNull()
        expect((within(editor).getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('c')
        expect(within(editor).getByRole('button', { name: 'Save changes' })).toBeDisabled()

        // A change made after that is saved against what the queue has left.
        fireEvent.change(within(editor).getByLabelText('Message 1'), { target: { value: 'c edited' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { items: [{ text: 'c edited' }] }))
    })

    it('lets a queue that has sent every prompt change its gap, with one blank row for a prompt to add', async () => {
        const { api } = setup({ tasks: [task({ kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], runCount: 2, totalRuns: 2, pending: true, nextRunAt: null })] })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        expect(within(editor).getAllByRole('textbox')).toHaveLength(1)
        expect((within(editor).getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('')
        expect(within(editor).getByRole('button', { name: 'Save changes' })).toBeDisabled()

        fireEvent.change(within(editor).getByLabelText('Gap'), { target: { value: '5' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
        // The gap alone goes out: no message list, so the hub is not asked to replace anything.
        await waitFor(() => expect(api.updateSessionTask).toHaveBeenCalledWith('session-1', 'task-1', { intervalMs: 5 * MINUTE }))
        await waitFor(() => expect(screen.queryByRole('group', { name: 'Edit task' })).toBeNull())
        expect(screen.getByRole('listitem').textContent).toContain('Gap 5 minutes')
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('drops the row when the edit answers 404, and restores it on any other refusal', async () => {
        const view = setup({ tasks: [task()], updateError: new ApiError('HTTP 400 Bad Request: {"code":"wrong_task_kind"}', 400, 'wrong_task_kind') })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
        const editor = await screen.findByRole('group', { name: 'Edit task' })
        fireEvent.change(within(editor).getByLabelText('Message'), { target: { value: 'changed' } })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
        expect((await screen.findByRole('alert')).textContent).toBe('That change does not apply to this kind of task.')
        expect(screen.getByRole('listitem').textContent).toContain('check progress')

        vi.mocked(view.api.updateSessionTask).mockImplementation(async (_sessionId: string, taskId: string) => {
            view.drop(taskId)
            throw new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404)
        })
        fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
        await waitFor(() => expect(screen.queryByRole('listitem')).toBeNull())
    })

    it('shows the runs behind the History toggle, each with its outcome', async () => {
        const now = Date.now()
        const { api } = setup({
            tasks: [task()],
            runs: [
                run({ id: 'r5', recordedAt: now - MINUTE, runNumber: 3, preview: 'third' }),
                run({ id: 'r4', recordedAt: now - 2 * MINUTE, runNumber: 2, takenAt: now - 90_000, preview: 'second' }),
                run({ id: 'r3', recordedAt: now - 3 * MINUTE, outcome: 'skipped', detail: 'previous_prompt_waiting', runNumber: null, preview: null, taskKind: 'repeat' }),
                run({ id: 'r2', recordedAt: now - 4 * MINUTE, outcome: 'failed', detail: 'machine_offline', runNumber: null, preview: null }),
                run({ id: 'r1', recordedAt: now - 5 * MINUTE, outcome: 'cancelled', runNumber: 1, preview: 'first' })
            ]
        })
        // The runs load with the bar but stay hidden until asked for.
        await waitFor(() => expect(api.listSessionTaskRuns).toHaveBeenCalledWith('session-1', 50))
        const toggle = await screen.findByRole('button', { name: 'History' })
        expect(toggle).toHaveAttribute('aria-pressed', 'false')
        expect(screen.queryByRole('list', { name: 'History' })).toBeNull()

        fireEvent.click(toggle)
        const history = await screen.findByRole('list', { name: 'History' })
        expect(toggle).toHaveAttribute('aria-pressed', 'true')
        const entries = within(history).getAllByRole('listitem')
        expect(entries).toHaveLength(5)
        expect(entries[0].textContent).toContain('third')
        expect(entries[0].textContent).toContain('Sent, waiting for the agent')
        expect(entries[1].textContent).toContain('Taken by the agent')
        expect(entries[1].textContent).toContain('second')
        expect(entries[2].textContent).toContain('Skipped: the previous prompt was still waiting')
        expect(entries[2].textContent).toContain('Repeat')
        expect(entries[3].textContent).toContain('Failed: the machine was offline')
        expect(entries[4].textContent).toContain('Cancelled')
        expect(entries[4].textContent).toContain('Queue #1')

        fireEvent.click(toggle)
        await waitFor(() => expect(screen.queryByRole('list', { name: 'History' })).toBeNull())
    })

    it('gives a failed run in the history the reason it failed, not the row\'s sentence for a task still held up', async () => {
        const now = Date.now()
        setup({
            tasks: [task({ lastError: 'session_unavailable' })],
            runs: [
                run({ id: 'r4', recordedAt: now - MINUTE, outcome: 'failed', detail: 'send_failed', runNumber: null, preview: null }),
                run({ id: 'r3', recordedAt: now - 2 * MINUTE, outcome: 'failed', detail: 'session_archived', runNumber: null, preview: null }),
                run({ id: 'r2', recordedAt: now - 3 * MINUTE, outcome: 'failed', detail: 'session_unavailable', runNumber: null, preview: null }),
                run({ id: 'r1', recordedAt: now - 4 * MINUTE, outcome: 'failed', detail: 'machine_offline', runNumber: null, preview: null })
            ]
        })
        // The row is about a task that is still trying, so it says what it is waiting for.
        const row = await screen.findByRole('listitem')
        expect(row.textContent).toContain('The session cannot be resumed right now; retrying')

        fireEvent.click(screen.getByRole('button', { name: 'History' }))
        const history = await screen.findByRole('list', { name: 'History' })
        const entries = within(history).getAllByRole('listitem')
        expect(entries.map((entry) => entry.textContent)).toEqual([
            expect.stringContaining('Failed: the send failed'),
            expect.stringContaining('Failed: the session was archived'),
            expect.stringContaining('Failed: the session could not be resumed'),
            expect.stringContaining('Failed: the machine was offline')
        ])
        // A run is over: nothing of "retrying" or of what the task does once the machine is back.
        expect(history.textContent).not.toContain('retrying')
        expect(history.textContent).not.toContain('Sends once the machine is back online')
        expect(history.textContent).not.toContain('nothing runs until it is reopened')
    })

    it('keeps the bar for the history alone once the last task is gone', async () => {
        setup({ tasks: [], runs: [run()] })
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        const history = await screen.findByRole('list', { name: 'History' })
        expect(within(history).getAllByRole('listitem')).toHaveLength(1)
        expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull()
    })

    it('says when there are no runs yet, or when the history could not be loaded', async () => {
        setup({ tasks: [task()], runs: [] })
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        expect(await screen.findByText('No runs recorded yet.')).toBeTruthy()

        cleanup()
        setup({ tasks: [task()], historyError: new ApiError('HTTP 502 Bad Gateway', 502) })
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        const alert = await screen.findByRole('alert', {}, { timeout: 6000 })
        expect(within(alert).getByText('The history could not be loaded.')).toBeTruthy()
        expect(screen.queryByText('No runs recorded yet.')).toBeNull()
    })

    it('retries a failed history load, like a failed task list', async () => {
        const { api } = setup({ tasks: [task()], historyError: new ApiError('HTTP 502 Bad Gateway', 502) })
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        const alert = await screen.findByRole('alert', {}, { timeout: 6000 })
        // The query's own policy tried the 5xx twice more before the bar gave up.
        expect(api.listSessionTaskRuns).toHaveBeenCalledTimes(3)

        vi.mocked(api.listSessionTaskRuns).mockResolvedValue({ runs: [run()] })
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
        const history = await screen.findByRole('list', { name: 'History' })
        expect(within(history).getAllByRole('listitem')).toHaveLength(1)
        expect(history.textContent).toContain('first prompt')
        expect(screen.queryByRole('alert')).toBeNull()
        expect(api.listSessionTaskRuns).toHaveBeenCalledTimes(4)
    })

    it('offers neither History, Edit nor Run now on a hub that has no history route', async () => {
        const { api } = setup({ tasks: [task()], historyError: new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404) })
        await waitFor(() => expect(api.listSessionTaskRuns).toHaveBeenCalled())
        await waitFor(() => expect(screen.queryByRole('button', { name: 'History' })).toBeNull())
        const row = screen.getByRole('listitem')
        // The three controls that need the later routes are not offered where they cannot work...
        expect(within(row).queryByRole('button', { name: 'Edit task' })).toBeNull()
        expect(within(row).queryByRole('button', { name: 'Run now' })).toBeNull()
        // ...while the task and its pause and delete stay.
        expect(row.textContent).toContain('check progress')
        expect(within(row).getByRole('button', { name: 'Pause task' })).toBeTruthy()
        expect(within(row).getByRole('button', { name: 'Delete task' })).toBeTruthy()
        // Not an error: there is nothing to retry, and nothing to say.
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    })

    it('offers Run now, Edit and History only once the hub has said whether it has the history route', async () => {
        const hub = fakeHub({ tasks: [task()] })
        let answerHistory!: () => void
        hub.api.listSessionTaskRuns.mockImplementation(() => new Promise((resolve) => {
            answerHistory = () => resolve({ runs: [] })
        }))
        mount(hub)
        // The task list is in while the history request is still out: the row shows, without the controls that need the route.
        const row = await screen.findByRole('listitem')
        expect(within(row).getByRole('button', { name: 'Pause task' })).toBeTruthy()
        expect(within(row).getByRole('button', { name: 'Delete task' })).toBeTruthy()
        expect(within(row).queryByRole('button', { name: 'Run now' })).toBeNull()
        expect(within(row).queryByRole('button', { name: 'Edit task' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()

        // Shown at once, they would appear and vanish again on a hub without the route; a hub that has it gets them once.
        await act(async () => {
            answerHistory()
            await Promise.resolve()
        })
        await waitFor(() => expect(within(row).getByRole('button', { name: 'Run now' })).toBeTruthy())
        expect(within(row).getByRole('button', { name: 'Edit task' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'History' })).toBeTruthy()
    })

    it('never shows Run now, Edit or History on a hub that answers the history request with 404, not even for a frame', async () => {
        const hub = fakeHub({ tasks: [task()] })
        let refuseHistory!: () => void
        hub.api.listSessionTaskRuns.mockImplementation(() => new Promise((_resolve, reject) => {
            refuseHistory = () => reject(new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404))
        }))
        mount(hub)
        const row = await screen.findByRole('listitem')
        expect(within(row).queryByRole('button', { name: 'Run now' })).toBeNull()
        expect(within(row).queryByRole('button', { name: 'Edit task' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()

        await act(async () => {
            refuseHistory()
            await Promise.resolve()
        })
        await act(async () => { await Promise.resolve() })
        expect(within(row).queryByRole('button', { name: 'Run now' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
        expect(within(row).getByRole('button', { name: 'Pause task' })).toBeTruthy()
    })

    it('keeps Run now, Edit and History hidden on a hub without the route while its history is asked for again', async () => {
        const notFound = new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404)
        const hub = fakeHub({ tasks: [task()], historyError: notFound })
        const { queryClient } = mount(hub)
        await screen.findByRole('listitem')
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalled())
        await waitFor(() => expect(screen.queryByRole('button', { name: 'History' })).toBeNull())

        // Every task change and SSE resync asks again. The refetch clears the query's error until the
        // answer comes, which must not bring the controls back for that moment.
        let refuseAgain!: () => void
        hub.api.listSessionTaskRuns.mockImplementation(() => new Promise((_resolve, reject) => {
            refuseAgain = () => reject(notFound)
        }))
        await act(async () => {
            void queryClient.invalidateQueries({ queryKey: ['session-tasks', 'session-1'] })
            await Promise.resolve()
        })
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalledTimes(2))
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
        expect(within(screen.getByRole('listitem')).queryByRole('button', { name: 'Edit task' })).toBeNull()

        await act(async () => {
            refuseAgain()
            await Promise.resolve()
        })
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
    })

    it('says why when the hub refuses to resume a task because the session already holds too many active tasks', async () => {
        const refused = new ApiError('HTTP 400 Bad Request', 400, 'too_many_tasks', '{"error":"A session may hold at most 20 active tasks","code":"too_many_tasks"}')
        setup({ tasks: [task({ state: 'paused', nextRunAt: null })], updateError: refused })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Resume task' }))
        await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('This session already has 20 active tasks; pause or delete one first.'))
        await waitFor(() => expect(screen.getByRole('listitem').textContent).toContain('Paused'))
    })

    it('says why when the hub refuses "run now" because the session already holds too many active tasks', async () => {
        const refused = new ApiError('HTTP 409 Conflict', 409, 'too_many_tasks', '{"error":"A session may hold at most 20 active tasks","code":"too_many_tasks"}')
        const { api } = setup({ tasks: [task({ state: 'paused', nextRunAt: null })], runError: refused })
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
        await waitFor(() => expect(api.runSessionTask).toHaveBeenCalled())
        await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('This session already has 20 active tasks; pause or delete one first.'))
        await waitFor(() => expect(screen.getByRole('listitem').textContent).toContain('Paused'))
    })

    it.each<[string, Parameters<typeof setup>[0]]>([
        ['resume', { tasks: [task({ state: 'paused', nextRunAt: null })], updateError: new ApiError('HTTP 400 Bad Request', 400, undefined, '{"error":"The session is read-only"}') }],
        ['run now', { tasks: [task()], runError: new ApiError('HTTP 400 Bad Request', 400, undefined, '{"error":"The session is read-only"}') }]
    ])('shows the hub\'s own sentence for any other refusal of a %s', async (action, options) => {
        setup(options)
        await screen.findByRole('listitem')
        fireEvent.click(screen.getByRole('button', { name: action === 'resume' ? 'Resume task' : 'Run now' }))
        await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('The session is read-only'))
    })

    it('gives the icon buttons a 32 px target and a wider gap under a coarse pointer only', async () => {
        setup({ tasks: [task()] })
        const row = await screen.findByRole('listitem')
        // jsdom applies no media query, so the classes are what is checked: 28 px and gap 1 by default,
        // 32 px and gap 1.5 under (pointer: coarse).
        const group = within(row).getByRole('button', { name: 'Pause task' }).parentElement as HTMLElement
        expect(group.className.split(/\s+/)).toEqual(expect.arrayContaining(['gap-1', 'pointer-coarse:gap-1.5']))
        for (const name of ['Pause task', 'Run now', 'Edit task', 'Delete task']) {
            const classes = within(row).getByRole('button', { name }).className.split(/\s+/)
            expect(classes, name).toEqual(expect.arrayContaining(['h-7', 'w-7', 'pointer-coarse:h-8', 'pointer-coarse:w-8']))
        }
    })
})
