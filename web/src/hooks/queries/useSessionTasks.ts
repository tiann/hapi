import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateSessionTaskRequest, SessionTask } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

/** A hub without the task routes answers 404; retrying cannot change that. */
export function shouldRetrySessionTasksQuery(failureCount: number, error: unknown): boolean {
    if (isSessionTasksUnsupported(error)) return false
    return failureCount < 2
}

export function isSessionTasksUnsupported(error: unknown): boolean {
    return error instanceof ApiError && error.status === 404
}

export function applySessionTaskPaused(tasks: SessionTask[], taskId: string, paused: boolean): SessionTask[] {
    let changed = false
    const next = tasks.map((task) => {
        if (task.id !== taskId || task.state === (paused ? 'paused' : 'active')) return task
        changed = true
        return {
            ...task,
            state: paused ? 'paused' as const : 'active' as const,
            // The hub has no next run to show while the task is paused.
            nextRunAt: paused ? null : task.nextRunAt
        }
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

export function useSessionTasks(api: ApiClient | null, sessionId: string): {
    tasks: SessionTask[]
    isLoading: boolean
    error: string | null
    /** The hub predates session tasks, so the task UI stays hidden. */
    unsupported: boolean
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

    return {
        tasks: query.data?.tasks ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error && !isSessionTasksUnsupported(query.error)
            ? query.error.message
            : null,
        unsupported: isSessionTasksUnsupported(query.error)
    }
}

export function useSessionTaskMutations(api: ApiClient | null, sessionId: string) {
    const queryClient = useQueryClient()
    const key = queryKeys.sessionTasks(sessionId)
    const requireApi = (): ApiClient => {
        if (!api) throw new Error('API unavailable')
        return api
    }
    const readTasks = (): SessionTask[] => queryClient.getQueryData<{ tasks: SessionTask[] }>(key)?.tasks ?? []

    const createTask = useMutation({
        mutationFn: async (request: CreateSessionTaskRequest): Promise<SessionTask> => {
            const { task } = await requireApi().createSessionTask(sessionId, request)
            return task
        },
        onSuccess: (task) => {
            queryClient.setQueryData<{ tasks: SessionTask[] }>(key, (previous) => ({
                tasks: upsertSessionTask(previous?.tasks ?? [], task)
            }))
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: key })
        }
    })

    const setPaused = useMutation({
        mutationFn: async (input: { taskId: string; paused: boolean }): Promise<SessionTask> => {
            const { task } = await requireApi().updateSessionTask(sessionId, input.taskId, { paused: input.paused })
            return task
        },
        onMutate: async ({ taskId, paused }) => {
            await queryClient.cancelQueries({ queryKey: key })
            const previous = queryClient.getQueryData<{ tasks: SessionTask[] }>(key)
            queryClient.setQueryData<{ tasks: SessionTask[] }>(key, (current) => ({
                tasks: applySessionTaskPaused(current?.tasks ?? [], taskId, paused)
            }))
            return { previous }
        },
        onError: (_error, _input, context) => {
            if (context?.previous) queryClient.setQueryData(key, context.previous)
        },
        onSuccess: (task) => {
            queryClient.setQueryData<{ tasks: SessionTask[] }>(key, (current) => ({
                tasks: upsertSessionTask(current?.tasks ?? [], task)
            }))
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: key })
        }
    })

    const deleteTask = useMutation({
        mutationFn: async (taskId: string): Promise<void> => {
            await requireApi().deleteSessionTask(sessionId, taskId)
        },
        onMutate: async (taskId) => {
            await queryClient.cancelQueries({ queryKey: key })
            const previous = queryClient.getQueryData<{ tasks: SessionTask[] }>(key)
            queryClient.setQueryData<{ tasks: SessionTask[] }>(key, (current) => ({
                tasks: removeSessionTask(current?.tasks ?? [], taskId)
            }))
            return { previous }
        },
        onError: (_error, _taskId, context) => {
            if (context?.previous) queryClient.setQueryData(key, context.previous)
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: key })
        }
    })

    return { createTask, setPaused, deleteTask }
}
