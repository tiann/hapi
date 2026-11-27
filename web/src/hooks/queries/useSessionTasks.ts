import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
    CreateSessionTaskRequest,
    SessionTask,
    SessionTaskDeleteResponse,
    SessionTaskRun,
    UpdateSessionTaskRequest
} from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { applySessionTaskEdit } from '@/lib/sessionTasks'

/** Runs shown when the History toggle is open; the hub caps a page at 200. */
export const SESSION_TASK_HISTORY_LIMIT = 50

/** A hub without the task routes answers 404; retrying cannot change that. */
export function shouldRetrySessionTasksQuery(failureCount: number, error: unknown): boolean {
    if (isSessionTasksUnsupported(error)) return false
    return failureCount < 2
}

export function isSessionTasksUnsupported(error: unknown): boolean {
    return error instanceof ApiError && error.status === 404
}

/**
 * A 404 stays known while a request is out after it. A background refetch of
 * an errored query clears its error until the answer comes (the query is
 * pending again), so without this the UI a 404 hides would show for that
 * moment on every refetch. Once the hub answers again, its answer counts.
 */
function useUnsupportedOnceSeen(error: unknown, pending: boolean): boolean {
    const seen = useRef(false)
    const unsupported = isSessionTasksUnsupported(error)
    if (unsupported) seen.current = true
    return unsupported || (seen.current && pending)
}

/** The hub refused a change to one task because it no longer exists (finished, or deleted elsewhere). */
export function isSessionTaskGone(error: unknown): boolean {
    return isSessionTasksUnsupported(error)
}

export function applySessionTaskPaused(tasks: SessionTask[], taskId: string, paused: boolean): SessionTask[] {
    let changed = false
    const next = tasks.map((task) => {
        if (task.id !== taskId || task.state === (paused ? 'paused' : 'active')) return task
        changed = true
        return {
            ...task,
            state: paused ? 'paused' as const : 'active' as const,
            // The hub has no next run to show while the task is paused, and reports
            // a resumed one; its last error does not survive the resume.
            nextRunAt: paused ? null : task.nextRunAt,
            lastError: paused ? task.lastError : null
        }
    })
    return changed ? next : tasks
}

/** "Run now" makes the task active and due at once, with its error cleared; the hub answers with the real task. */
export function applySessionTaskRunNow(tasks: SessionTask[], taskId: string, now: number): SessionTask[] {
    let changed = false
    const next = tasks.map((task) => {
        if (task.id !== taskId) return task
        if (task.state === 'active' && task.lastError === null && task.nextRunAt === now) return task
        changed = true
        return { ...task, state: 'active' as const, lastError: null, nextRunAt: now }
    })
    return changed ? next : tasks
}

export function removeSessionTask(tasks: SessionTask[], taskId: string): SessionTask[] {
    return tasks.some((task) => task.id === taskId) ? tasks.filter((task) => task.id !== taskId) : tasks
}

export function upsertSessionTask(tasks: SessionTask[], task: SessionTask): SessionTask[] {
    return tasks.some((existing) => existing.id === task.id)
        ? tasks.map((existing) => (existing.id === task.id ? task : existing))
        : [...tasks, task]
}

type TasksCache = { tasks: SessionTask[] }

export function useSessionTasks(api: ApiClient | null, sessionId: string): {
    tasks: SessionTask[]
    /** Set when the list could not be loaded on a hub that has the routes. */
    error: string | null
    /** The hub predates session tasks, so the task UI stays hidden. */
    unsupported: boolean
    refetch: () => unknown
} {
    const query = useQuery({
        queryKey: queryKeys.sessionTasks(sessionId),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.listSessionTasks(sessionId)
        },
        enabled: Boolean(api),
        // `session-tasks-changed` on the SSE stream invalidates this; unprompted
        // refetches (window focus, remount) have nothing new to find for a while.
        staleTime: 30_000,
        retry: shouldRetrySessionTasksQuery
    })

    const unsupported = useUnsupportedOnceSeen(query.error, query.isPending)
    return {
        tasks: query.data?.tasks ?? [],
        error: query.error instanceof Error && !isSessionTasksUnsupported(query.error)
            ? query.error.message
            : null,
        unsupported,
        refetch: () => query.refetch()
    }
}

/** The newest runs of the session's tasks, fetched while the History toggle is open. */
export function useSessionTaskHistory(api: ApiClient | null, sessionId: string, enabled: boolean): {
    runs: SessionTaskRun[]
    isLoading: boolean
    /** The hub has answered the history request at least once (a failed attempt being retried counts), so `unsupported` is known; until then, the controls that need the route stay hidden. */
    answered: boolean
    /** Set when the runs could not be loaded on a hub that has the route. */
    error: string | null
    /** The hub predates the history route (and with it, editing and "run now"), so their UI stays hidden. */
    unsupported: boolean
    refetch: () => unknown
} {
    const query = useQuery({
        queryKey: queryKeys.sessionTaskHistory(sessionId),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.listSessionTaskRuns(sessionId, SESSION_TASK_HISTORY_LIMIT)
        },
        enabled: Boolean(api) && enabled,
        staleTime: 15_000,
        retry: shouldRetrySessionTasksQuery
    })
    // A failed attempt that is being retried counts as an answer too: only the wait for the very first one hides the controls.
    const answered = query.isFetched || query.failureCount > 0
    const unsupported = useUnsupportedOnceSeen(query.error, query.isPending)
    return {
        runs: query.data?.runs ?? [],
        isLoading: query.isFetching && query.data === undefined,
        answered,
        error: query.error instanceof Error && !isSessionTasksUnsupported(query.error) ? query.error.message : null,
        unsupported,
        refetch: () => query.refetch()
    }
}

/** Reads and writes the task list so an edit shows before the hub answers. */
function editTasks(queryClient: QueryClient, key: readonly unknown[], edit: (tasks: SessionTask[]) => SessionTask[]) {
    queryClient.setQueryData<TasksCache>(key, (current) => ({ tasks: edit(current?.tasks ?? []) }))
}

/**
 * Create, pause / resume, edit, run now and delete. Every change is applied to
 * the cached list first and rolled back when the hub refuses it, except that a
 * 404 for one task means it is gone: the row then stays removed or paused
 * instead of coming back with buttons that cannot work.
 */
export function useSessionTaskMutations(api: ApiClient | null, sessionId: string) {
    const queryClient = useQueryClient()
    const key = queryKeys.sessionTasks(sessionId)
    const requireApi = (): ApiClient => {
        if (!api) throw new Error('API unavailable')
        return api
    }
    /** Snapshot and clear the way for an optimistic edit. */
    const begin = async () => {
        await queryClient.cancelQueries({ queryKey: key })
        return queryClient.getQueryData<TasksCache>(key)
    }
    const rollback = (previous: TasksCache | undefined) => {
        if (previous) queryClient.setQueryData(key, previous)
    }
    /** A 404 keeps the optimistic removal of the task; any other refusal restores the list. */
    const rollbackUnlessGone = (error: unknown, taskId: string, previous: TasksCache | undefined) => {
        if (isSessionTaskGone(error)) {
            editTasks(queryClient, key, (tasks) => removeSessionTask(tasks, taskId))
            return
        }
        rollback(previous)
    }
    const resync = () => {
        void queryClient.invalidateQueries({ queryKey: key })
    }

    const createTask = useMutation({
        mutationFn: async (request: CreateSessionTaskRequest): Promise<SessionTask> => {
            const { task } = await requireApi().createSessionTask(sessionId, request)
            return task
        },
        onSuccess: (task) => {
            editTasks(queryClient, key, (tasks) => upsertSessionTask(tasks, task))
        },
        onSettled: resync
    })

    const setPaused = useMutation({
        mutationFn: async (input: { taskId: string; paused: boolean }): Promise<SessionTask> => {
            const { task } = await requireApi().updateSessionTask(sessionId, input.taskId, { paused: input.paused })
            return task
        },
        onMutate: async ({ taskId, paused }) => {
            const previous = await begin()
            editTasks(queryClient, key, (tasks) => applySessionTaskPaused(tasks, taskId, paused))
            return { previous }
        },
        onError: (error, { taskId }, context) => {
            rollbackUnlessGone(error, taskId, context?.previous)
        },
        onSuccess: (task) => {
            editTasks(queryClient, key, (tasks) => upsertSessionTask(tasks, task))
        },
        onSettled: resync
    })

    const updateTask = useMutation({
        mutationFn: async (input: { taskId: string; request: UpdateSessionTaskRequest }): Promise<SessionTask> => {
            const { task } = await requireApi().updateSessionTask(sessionId, input.taskId, input.request)
            return task
        },
        onMutate: async ({ taskId, request }) => {
            const previous = await begin()
            editTasks(queryClient, key, (tasks) => tasks.map((task) => task.id === taskId
                ? applySessionTaskEdit(task, request)
                : task))
            return { previous }
        },
        onError: (error, { taskId }, context) => {
            rollbackUnlessGone(error, taskId, context?.previous)
        },
        onSuccess: (task) => {
            editTasks(queryClient, key, (tasks) => upsertSessionTask(tasks, task))
        },
        onSettled: resync
    })

    const runNow = useMutation({
        mutationFn: async (taskId: string): Promise<SessionTask> => {
            const { task } = await requireApi().runSessionTask(sessionId, taskId)
            return task
        },
        onMutate: async (taskId) => {
            const previous = await begin()
            editTasks(queryClient, key, (tasks) => applySessionTaskRunNow(tasks, taskId, Date.now()))
            return { previous }
        },
        onError: (error, taskId, context) => {
            // 409 prompt_pending: the hub keeps one prompt per task, so the list simply stays as it was.
            rollbackUnlessGone(error, taskId, context?.previous)
        },
        onSuccess: (task) => {
            editTasks(queryClient, key, (tasks) => upsertSessionTask(tasks, task))
        },
        onSettled: resync
    })

    const deleteTask = useMutation({
        mutationFn: async (taskId: string): Promise<SessionTaskDeleteResponse> => {
            return await requireApi().deleteSessionTask(sessionId, taskId)
        },
        onMutate: async (taskId) => {
            const previous = await begin()
            editTasks(queryClient, key, (tasks) => removeSessionTask(tasks, taskId))
            return { previous }
        },
        onError: (error, taskId, context) => {
            rollbackUnlessGone(error, taskId, context?.previous)
        },
        onSettled: resync
    })

    return { createTask, setPaused, updateTask, runNow, deleteTask }
}
