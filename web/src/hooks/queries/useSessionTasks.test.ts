import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionTask, SessionTaskDeleteResponse, SessionTaskRun, UpdateSessionTaskRequest } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import {
    applySessionTaskPaused,
    applySessionTaskRunNow,
    isSessionTaskGone,
    isSessionTasksUnsupported,
    removeSessionTask,
    shouldRetrySessionTasksQuery,
    upsertSessionTask,
    useSessionTaskHistory,
    useSessionTaskMutations,
    useSessionTasks
} from './useSessionTasks'

function task(id: string, overrides: Partial<SessionTask> = {}): SessionTask {
    return {
        id,
        sessionId: 's1',
        kind: 'repeat',
        state: 'active',
        items: [{ text: 'ping' }],
        intervalMs: 60_000,
        maxRuns: null,
        runCount: 0,
        totalRuns: null,
        nextRunAt: 1_000,
        pending: false,
        startAt: 1,
        lastRunAt: null,
        lastError: null,
        createdAt: Number(id),
        updatedAt: 1,
        ...overrides
    }
}

function run(overrides: Partial<SessionTaskRun> = {}): SessionTaskRun {
    return {
        id: 'r1',
        sessionId: 's1',
        taskId: '1',
        taskKind: 'repeat',
        runNumber: null,
        outcome: 'sent',
        scheduledFor: 1_000,
        recordedAt: 1_000,
        takenAt: null,
        detail: null,
        preview: 'ping',
        ...overrides
    }
}

describe('session tasks query retry policy', () => {
    it('does not retry a hub that has no task routes', () => {
        expect(shouldRetrySessionTasksQuery(0, new ApiError('HTTP 404 Not Found', 404))).toBe(false)
    })

    it('retries other failures twice', () => {
        expect(shouldRetrySessionTasksQuery(0, new ApiError('HTTP 502 Bad Gateway', 502))).toBe(true)
        expect(shouldRetrySessionTasksQuery(2, new ApiError('HTTP 502 Bad Gateway', 502))).toBe(false)
        expect(shouldRetrySessionTasksQuery(1, new Error('Network request failed'))).toBe(true)
    })

    it('recognises only a 404 as an unsupported hub, and the same 404 as a task that is gone', () => {
        expect(isSessionTasksUnsupported(new ApiError('HTTP 404 Not Found', 404))).toBe(true)
        expect(isSessionTasksUnsupported(new ApiError('HTTP 403 Forbidden', 403))).toBe(false)
        expect(isSessionTasksUnsupported(new Error('HTTP 404 Not Found'))).toBe(false)
        expect(isSessionTaskGone(new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404))).toBe(true)
        expect(isSessionTaskGone(new ApiError('HTTP 409 Conflict', 409))).toBe(false)
    })
})

describe('session tasks cache edits', () => {
    it('pause flips only the named task and drops its next run', () => {
        const tasks = [task('1'), task('2', { nextRunAt: 5_000 })]
        const next = applySessionTaskPaused(tasks, '2', true)
        expect(next).not.toBe(tasks)
        expect(next[0]).toBe(tasks[0])
        expect(next[1]).toMatchObject({ id: '2', state: 'paused', nextRunAt: null })
        // Already in that state: the same array comes back, so nothing re-renders.
        expect(applySessionTaskPaused(next, '2', true)).toBe(next)
        expect(applySessionTaskPaused(tasks, 'missing', true)).toBe(tasks)
    })

    it('resume keeps the stored next run until the hub answers, but not the error the pause was saved with', () => {
        const paused = [task('1', { state: 'paused', nextRunAt: 5_000, lastError: 'session_unavailable' })]
        expect(applySessionTaskPaused(paused, '1', false)[0]).toMatchObject({ state: 'active', nextRunAt: 5_000, lastError: null })
    })

    it('run now makes the task active, due at once, with its error cleared', () => {
        const now = 7_000
        const [next] = applySessionTaskRunNow([task('1', { state: 'paused', nextRunAt: null, lastError: 'machine_offline' })], '1', now)
        expect(next).toMatchObject({ state: 'active', nextRunAt: now, lastError: null })
        // Already exactly so: the same array comes back.
        const same = [task('1', { state: 'active', nextRunAt: now })]
        expect(applySessionTaskRunNow(same, '1', now)).toBe(same)
        expect(applySessionTaskRunNow(same, 'missing', now)).toBe(same)
    })

    it('remove drops the task only when it is there', () => {
        const tasks = [task('1'), task('2')]
        expect(removeSessionTask(tasks, '1').map((entry) => entry.id)).toEqual(['2'])
        expect(removeSessionTask(tasks, 'missing')).toBe(tasks)
    })

    it('upsert replaces in place or appends', () => {
        const tasks = [task('1'), task('2')]
        expect(upsertSessionTask(tasks, task('1', { runCount: 3 })).map((entry) => entry.runCount)).toEqual([3, 0])
        expect(upsertSessionTask(tasks, task('3')).map((entry) => entry.id)).toEqual(['1', '2', '3'])
    })
})

function setupHub(options: { list?: SessionTask[]; listRefetch?: unknown } = {}) {
    let current = options.list ?? [task('1'), task('2')]
    let listCalls = 0
    const api = {
        listSessionTasks: vi.fn(async () => {
            listCalls += 1
            if (options.listRefetch && listCalls > 1) throw options.listRefetch
            return { tasks: current }
        }),
        createSessionTask: vi.fn(async (request: { kind: 'repeat' | 'queue' }) => {
            const created = task('new', { kind: request.kind, createdAt: 9 })
            current = [...current, created]
            return { task: created }
        }),
        updateSessionTask: vi.fn(async (_sessionId: string, taskId: string, request: UpdateSessionTaskRequest) => {
            const entry = current.find((item) => item.id === taskId)
            if (!entry) throw new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404)
            const updated: SessionTask = {
                ...entry,
                state: request.paused === undefined ? entry.state : request.paused ? 'paused' as const : 'active' as const,
                nextRunAt: request.paused === true ? null : entry.nextRunAt,
                items: request.text !== undefined ? [{ text: request.text }]
                    : request.items !== undefined ? [...entry.items.slice(0, entry.runCount), ...request.items] : entry.items,
                intervalMs: request.intervalMs ?? entry.intervalMs,
                maxRuns: request.maxRuns === undefined ? entry.maxRuns : request.maxRuns
            }
            current = current.map((item) => item.id === taskId ? updated : item)
            return { task: updated }
        }),
        runSessionTask: vi.fn(async (_sessionId: string, taskId: string) => {
            const entry = current.find((item) => item.id === taskId)
            if (!entry) throw new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404)
            const updated: SessionTask = { ...entry, state: 'active', nextRunAt: 42 }
            current = current.map((item) => item.id === taskId ? updated : item)
            return { task: updated }
        }),
        deleteSessionTask: vi.fn(async (_sessionId: string, taskId: string): Promise<SessionTaskDeleteResponse> => {
            if (!current.some((item) => item.id === taskId)) throw new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404)
            current = current.filter((item) => item.id !== taskId)
            return { ok: true, prompt: 'cancelled' }
        }),
        listSessionTaskRuns: vi.fn(async (): Promise<{ runs: SessionTaskRun[] }> => ({ runs: [] })),
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
    return { api, queryClient, wrapper, current: () => current }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

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

const readTasks = (queryClient: QueryClient) => queryClient.getQueryData<{ tasks: SessionTask[] }>(queryKeys.sessionTasks('s1'))?.tasks

describe('useSessionTasks', () => {
    it('loads the list, and reports a failed load with the task rows it still has', async () => {
        const hub = setupHub({ listRefetch: new ApiError('HTTP 502 Bad Gateway', 502) })
        const { result } = renderHook(() => useSessionTasks(hub.api as unknown as ApiClient, 's1'), { wrapper: hub.wrapper })
        await waitFor(() => expect(result.current.tasks.map((entry) => entry.id)).toEqual(['1', '2']))
        expect(result.current.error).toBeNull()
        expect(result.current.unsupported).toBe(false)

        await act(async () => {
            await hub.queryClient.invalidateQueries({ queryKey: queryKeys.sessionTasks('s1') })
        })
        await waitFor(() => expect(result.current.error).toBe('HTTP 502 Bad Gateway'))
        expect(result.current.tasks.map((entry) => entry.id)).toEqual(['1', '2'])

        hub.api.listSessionTasks.mockRejectedValue(new ApiError('HTTP 404 Not Found', 404))
        await act(async () => {
            await result.current.refetch()
        })
        await waitFor(() => expect(result.current.unsupported).toBe(true))
        expect(result.current.error).toBeNull()
    })

    it('fetches the run history under the task key, only when enabled', async () => {
        const hub = setupHub()
        const { result } = renderHook(() => useSessionTaskHistory(hub.api as unknown as ApiClient, 's1', false), { wrapper: hub.wrapper })
        await act(async () => { await Promise.resolve() })
        expect(hub.api.listSessionTaskRuns).not.toHaveBeenCalled()
        expect(result.current.runs).toEqual([])

        const opened = renderHook(() => useSessionTaskHistory(hub.api as unknown as ApiClient, 's1', true), { wrapper: hub.wrapper })
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalledWith('s1', 50))
        await waitFor(() => expect(opened.result.current.isLoading).toBe(false))
        expect(opened.result.current.error).toBeNull()
        expect(opened.result.current.unsupported).toBe(false)
    })

    it('tells a hub without the history route from a failed load, and can be asked again', async () => {
        const hub = setupHub()
        hub.api.listSessionTaskRuns.mockRejectedValue(new ApiError('HTTP 502 Bad Gateway', 502))
        const { result } = renderHook(() => useSessionTaskHistory(hub.api as unknown as ApiClient, 's1', true), { wrapper: hub.wrapper })
        // The query's own policy retries a 5xx twice before the hook gives up.
        await waitFor(() => expect(result.current.error).toBe('HTTP 502 Bad Gateway'), { timeout: 6000 })
        expect(result.current.unsupported).toBe(false)

        hub.api.listSessionTaskRuns.mockResolvedValue({ runs: [run()] })
        await act(async () => { await result.current.refetch() })
        await waitFor(() => expect(result.current.runs).toHaveLength(1))
        expect(result.current.error).toBeNull()

        hub.api.listSessionTaskRuns.mockRejectedValue(new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404))
        await act(async () => { await result.current.refetch() })
        await waitFor(() => expect(result.current.unsupported).toBe(true))
        expect(result.current.error).toBeNull()
    })

    it('says whether the hub has answered the history request at all, so the controls that need the route can wait for it', async () => {
        const hub = setupHub()
        const answer = deferred<{ runs: SessionTaskRun[] }>()
        hub.api.listSessionTaskRuns.mockImplementation(() => answer.promise)
        const { result } = renderHook(() => useSessionTaskHistory(hub.api as unknown as ApiClient, 's1', true), { wrapper: hub.wrapper })
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalledTimes(1))
        // Asked, not yet answered: nothing is known about the route, so `unsupported` is not yet a verdict.
        expect(result.current.answered).toBe(false)
        expect(result.current.unsupported).toBe(false)

        await act(async () => { answer.resolve({ runs: [run()] }) })
        await waitFor(() => expect(result.current.answered).toBe(true))
        expect(result.current.unsupported).toBe(false)
    })

    it('keeps a 404 of the history known while the history is asked for again', async () => {
        const hub = setupHub()
        hub.api.listSessionTaskRuns.mockRejectedValue(new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404))
        const { result } = renderHook(() => useSessionTaskHistory(hub.api as unknown as ApiClient, 's1', true), { wrapper: hub.wrapper })
        await waitFor(() => expect(result.current.unsupported).toBe(true))

        // A refetch clears the query's error until its answer comes; the hub has not gained the route in the meantime.
        const answer = deferred<{ runs: SessionTaskRun[] }>()
        hub.api.listSessionTaskRuns.mockImplementation(() => answer.promise)
        await act(async () => {
            void hub.queryClient.invalidateQueries({ queryKey: queryKeys.sessionTasks('s1') })
            await Promise.resolve()
        })
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalledTimes(2))
        expect(result.current.isLoading).toBe(true)
        expect(result.current.answered).toBe(true)
        expect(result.current.unsupported).toBe(true)

        await act(async () => { answer.reject(new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404)) })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.unsupported).toBe(true)
    })

    it('keeps a 404 of the task list known while the list is asked for again, so the panel does not offer tasks on such a hub', async () => {
        const hub = setupHub({ listRefetch: new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404) })
        const { result } = renderHook(() => useSessionTasks(hub.api as unknown as ApiClient, 's1'), { wrapper: hub.wrapper })
        await waitFor(() => expect(result.current.tasks).toHaveLength(2))
        await act(async () => {
            void hub.queryClient.invalidateQueries({ queryKey: queryKeys.sessionTasks('s1') })
        })
        await waitFor(() => expect(result.current.unsupported).toBe(true))

        const answer = deferred<{ tasks: SessionTask[] }>()
        hub.api.listSessionTasks.mockImplementation(() => answer.promise)
        await act(async () => {
            void hub.queryClient.invalidateQueries({ queryKey: queryKeys.sessionTasks('s1') })
            await Promise.resolve()
        })
        await waitFor(() => expect(hub.api.listSessionTasks).toHaveBeenCalledTimes(3))
        expect(result.current.unsupported).toBe(true)

        // Only the window is papered over: a hub that answers after all has the routes after all.
        await act(async () => { answer.resolve({ tasks: [task('1')] }) })
        await waitFor(() => expect(result.current.tasks.map((entry) => entry.id)).toEqual(['1']))
        expect(result.current.unsupported).toBe(false)
    })
})

describe('useSessionTaskMutations', () => {
    it('shows a created task before the refetch, and a paused task before the answer', async () => {
        const hub = setupHub()
        const { result } = renderHook(() => ({
            tasks: useSessionTasks(hub.api as unknown as ApiClient, 's1'),
            mutations: useSessionTaskMutations(hub.api as unknown as ApiClient, 's1')
        }), { wrapper: hub.wrapper })
        await waitFor(() => expect(result.current.tasks.tasks).toHaveLength(2))

        await act(async () => {
            await result.current.mutations.createTask.mutateAsync({ kind: 'queue', items: [{ text: 'a' }], intervalMs: 60_000 })
        })
        await waitFor(() => expect(readTasks(hub.queryClient)?.map((entry) => entry.id)).toContain('new'))

        const answer = deferResponse(hub.api.updateSessionTask)
        act(() => { result.current.mutations.setPaused.mutate({ taskId: '1', paused: true }) })
        await waitFor(() => expect(readTasks(hub.queryClient)?.[0]).toMatchObject({ id: '1', state: 'paused', nextRunAt: null }))
        // The hub's answer replaces the guess; the refetch that follows agrees with it.
        const listsBefore = hub.api.listSessionTasks.mock.calls.length
        await act(async () => { answer() })
        await waitFor(() => expect(hub.api.listSessionTasks.mock.calls.length).toBeGreaterThan(listsBefore))
        await act(async () => { await Promise.resolve() })
        expect(readTasks(hub.queryClient)?.[0]).toMatchObject({ id: '1', state: 'paused', nextRunAt: null })
    })

    it('rolls a refused pause back, but treats a 404 as the task being gone and removes the row', async () => {
        const refused = setupHub()
        const first = renderHook(() => useSessionTaskMutations(refused.api as unknown as ApiClient, 's1'), { wrapper: refused.wrapper })
        await refused.queryClient.fetchQuery({ queryKey: queryKeys.sessionTasks('s1'), queryFn: refused.api.listSessionTasks })
        refused.api.updateSessionTask.mockRejectedValue(new ApiError('HTTP 500 Internal Server Error', 500))
        await act(async () => {
            await first.result.current.setPaused.mutateAsync({ taskId: '1', paused: true }).catch(() => undefined)
        })
        expect(readTasks(refused.queryClient)?.[0]).toMatchObject({ id: '1', state: 'active' })

        const gone = setupHub()
        const second = renderHook(() => useSessionTaskMutations(gone.api as unknown as ApiClient, 's1'), { wrapper: gone.wrapper })
        gone.queryClient.setQueryData(queryKeys.sessionTasks('s1'), { tasks: [task('1'), task('2')] })
        gone.api.updateSessionTask.mockRejectedValue(new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404))
        gone.api.listSessionTasks.mockRejectedValue(new Error('offline'))
        await act(async () => {
            await second.result.current.setPaused.mutateAsync({ taskId: '1', paused: true }).catch(() => undefined)
        })
        await act(async () => { await Promise.resolve() })
        expect(readTasks(gone.queryClient)?.map((entry) => entry.id)).toEqual(['2'])
    })

    it('removes a deleted task at once, brings it back on a refusal, and keeps it gone on a 404 even when the refetch fails', async () => {
        const hub = setupHub()
        const { result } = renderHook(() => useSessionTaskMutations(hub.api as unknown as ApiClient, 's1'), { wrapper: hub.wrapper })
        hub.queryClient.setQueryData(queryKeys.sessionTasks('s1'), { tasks: [task('1'), task('2')] })

        const answer = deferred<SessionTaskDeleteResponse>()
        hub.api.deleteSessionTask.mockImplementationOnce(() => answer.promise)
        let pending!: Promise<SessionTaskDeleteResponse>
        act(() => { pending = result.current.deleteTask.mutateAsync('1') })
        await waitFor(() => expect(readTasks(hub.queryClient)?.map((entry) => entry.id)).toEqual(['2']))
        await act(async () => {
            answer.resolve({ ok: true, prompt: 'cancelled' })
            await pending
        })
        await expect(pending).resolves.toEqual({ ok: true, prompt: 'cancelled' })

        hub.queryClient.setQueryData(queryKeys.sessionTasks('s1'), { tasks: [task('1'), task('2')] })
        hub.api.deleteSessionTask.mockRejectedValueOnce(new ApiError('HTTP 500 Internal Server Error', 500))
        await act(async () => {
            await result.current.deleteTask.mutateAsync('1').catch(() => undefined)
        })
        expect(readTasks(hub.queryClient)?.map((entry) => entry.id)).toEqual(['1', '2'])

        hub.api.deleteSessionTask.mockRejectedValueOnce(new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404))
        hub.api.listSessionTasks.mockRejectedValue(new Error('offline'))
        await act(async () => {
            await result.current.deleteTask.mutateAsync('1').catch(() => undefined)
        })
        await act(async () => { await Promise.resolve() })
        expect(readTasks(hub.queryClient)?.map((entry) => entry.id)).toEqual(['2'])
    })

    it('applies an edit the way the hub will, then takes the hub\'s answer', async () => {
        const hub = setupHub({ list: [task('1', { kind: 'queue', items: [{ text: 'a' }, { text: 'b' }], runCount: 1, totalRuns: 2 })] })
        const { result } = renderHook(() => useSessionTaskMutations(hub.api as unknown as ApiClient, 's1'), { wrapper: hub.wrapper })
        await hub.queryClient.fetchQuery({ queryKey: queryKeys.sessionTasks('s1'), queryFn: hub.api.listSessionTasks })

        const answer = deferResponse(hub.api.updateSessionTask)
        act(() => { result.current.updateTask.mutate({ taskId: '1', request: { items: [{ text: 'b' }, { text: 'c' }], intervalMs: 120_000 } }) })
        await waitFor(() => expect(readTasks(hub.queryClient)?.[0]).toMatchObject({
            items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
            intervalMs: 120_000,
            // A new interval re-anchors a task with nothing pending to now + interval.
            nextRunAt: expect.any(Number)
        }))
        await act(async () => { answer() })
        await act(async () => { await Promise.resolve() })
        // The hub kept the stored next run (its own rule); its answer wins over the guess.
        expect(readTasks(hub.queryClient)?.[0]).toMatchObject({ items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], intervalMs: 120_000, nextRunAt: 1_000 })
    })

    it('shows a task due at once on "run now", then takes the hub\'s answer', async () => {
        const hub = setupHub({ list: [task('1', { state: 'paused', nextRunAt: null }), task('2')] })
        const { result } = renderHook(() => useSessionTaskMutations(hub.api as unknown as ApiClient, 's1'), { wrapper: hub.wrapper })
        await hub.queryClient.fetchQuery({ queryKey: queryKeys.sessionTasks('s1'), queryFn: hub.api.listSessionTasks })

        const answer = deferred<{ task: SessionTask }>()
        hub.api.runSessionTask.mockImplementationOnce(() => answer.promise)
        let pending!: Promise<SessionTask>
        act(() => { pending = result.current.runNow.mutateAsync('1') })
        await waitFor(() => expect(readTasks(hub.queryClient)?.[0]).toMatchObject({ id: '1', state: 'active', lastError: null }))
        expect(readTasks(hub.queryClient)?.[0]?.nextRunAt).toBeGreaterThan(Date.now() - 5_000)
        await act(async () => {
            answer.resolve({ task: task('1', { state: 'active', nextRunAt: 42 }) })
            await pending
        })
        await waitFor(() => expect(readTasks(hub.queryClient)?.[0]).toMatchObject({ id: '1', state: 'active', nextRunAt: 42 }))
    })

    it('puts a refused "run now" back the way it was', async () => {
        const hub = setupHub({ list: [task('1', { state: 'paused', nextRunAt: null })] })
        const { result } = renderHook(() => useSessionTaskMutations(hub.api as unknown as ApiClient, 's1'), { wrapper: hub.wrapper })
        await hub.queryClient.fetchQuery({ queryKey: queryKeys.sessionTasks('s1'), queryFn: hub.api.listSessionTasks })

        const answer = deferred<{ task: SessionTask }>()
        hub.api.runSessionTask.mockImplementationOnce(() => answer.promise)
        let pending!: Promise<SessionTask>
        act(() => { pending = result.current.runNow.mutateAsync('1') })
        await waitFor(() => expect(readTasks(hub.queryClient)?.[0]).toMatchObject({ id: '1', state: 'active' }))
        await act(async () => {
            answer.reject(new ApiError('HTTP 409 Conflict', 409, 'prompt_pending'))
            await pending.catch(() => undefined)
        })
        await waitFor(() => expect(readTasks(hub.queryClient)?.[0]).toMatchObject({ id: '1', state: 'paused', nextRunAt: null }))
    })

    it('drops a task whose "run now" or edit answers 404', async () => {
        const hub = setupHub({ list: [task('1', { state: 'paused', nextRunAt: null }), task('2')] })
        const { result } = renderHook(() => useSessionTaskMutations(hub.api as unknown as ApiClient, 's1'), { wrapper: hub.wrapper })
        await hub.queryClient.fetchQuery({ queryKey: queryKeys.sessionTasks('s1'), queryFn: hub.api.listSessionTasks })
        hub.api.listSessionTasks.mockRejectedValue(new Error('offline'))
        // The hub lost task 2 between the list and the click (it finished, or another client deleted it).
        hub.api.runSessionTask.mockImplementation(async () => { throw new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404) })
        await act(async () => {
            await result.current.runNow.mutateAsync('2').catch(() => undefined)
        })
        await act(async () => { await Promise.resolve() })
        expect(readTasks(hub.queryClient)?.map((entry) => entry.id)).toEqual(['1'])

        hub.api.updateSessionTask.mockImplementation(async () => { throw new ApiError('HTTP 404 Not Found: {"error":"Task not found"}', 404) })
        await act(async () => {
            await result.current.updateTask.mutateAsync({ taskId: '1', request: { text: 'x' } }).catch(() => undefined)
        })
        await act(async () => { await Promise.resolve() })
        expect(readTasks(hub.queryClient)).toEqual([])
    })
})
