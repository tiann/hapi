import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import type { SessionTask } from '@hapi/protocol'
import {
    applySessionTaskPaused,
    isSessionTasksUnsupported,
    removeSessionTask,
    shouldRetrySessionTasksQuery,
    upsertSessionTask
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
        lastRunAt: null,
        lastError: null,
        createdAt: Number(id),
        updatedAt: 1,
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

    it('recognises only a 404 as an unsupported hub', () => {
        expect(isSessionTasksUnsupported(new ApiError('HTTP 404 Not Found', 404))).toBe(true)
        expect(isSessionTasksUnsupported(new ApiError('HTTP 403 Forbidden', 403))).toBe(false)
        expect(isSessionTasksUnsupported(new Error('HTTP 404 Not Found'))).toBe(false)
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

    it('resume keeps the stored next run until the hub answers', () => {
        const paused = [task('1', { state: 'paused', nextRunAt: null })]
        expect(applySessionTaskPaused(paused, '1', false)[0]).toMatchObject({ state: 'active', nextRunAt: null })
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
