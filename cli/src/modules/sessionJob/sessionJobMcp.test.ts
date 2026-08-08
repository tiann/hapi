import { describe, expect, it, vi } from 'vitest'
import { handleSessionJobTool, SESSION_JOB_TOOL_DESCRIPTION } from './sessionJobMcp'

vi.mock('./sessionJob', () => ({
    SessionJobError: class SessionJobError extends Error {
        code: string
        constructor(code: string, message: string) {
            super(message)
            this.code = code
        }
    },
    setSessionJob: vi.fn(async () => ({
        sessionId: 'sid-1',
        job: {
            key: 'beets',
            label: 'beets import',
            status: 'running',
            remaining: 12,
            heartbeatAt: 1,
            startedAt: 1,
            updatedAt: 1
        }
    })),
    updateSessionJob: vi.fn(async () => ({
        sessionId: 'sid-1',
        job: {
            key: 'beets',
            label: 'beets import',
            status: 'running',
            remaining: 11,
            heartbeatAt: 2,
            startedAt: 1,
            updatedAt: 2
        }
    })),
    clearSessionJob: vi.fn(async () => ({ sessionId: 'sid-1' })),
    listSessionJobs: vi.fn(async () => ({ sessionId: 'sid-1', jobs: [], primary: null }))
}))

describe('sessionJobMcp', () => {
    it('description steers outliving batch work and honest progress', () => {
        expect(SESSION_JOB_TOOL_DESCRIPTION).toMatch(/OUTLIVES/i)
        expect(SESSION_JOB_TOOL_DESCRIPTION).toMatch(/Never invent a percent/i)
        expect(SESSION_JOB_TOOL_DESCRIPTION).toContain('hapi job run')
    })

    it('set requires label and always targets the caller session id', async () => {
        const { setSessionJob } = await import('./sessionJob')
        const result = await handleSessionJobTool(
            { action: 'set', jobKey: 'beets', label: 'beets import', remaining: 12 },
            'sid-1'
        )
        expect(result.isError).toBe(false)
        expect(result.text).toContain('set beets')
        expect(setSessionJob).toHaveBeenCalledWith(
            expect.objectContaining({ sessionIdPrefix: 'sid-1' })
        )
    })

    it('description claims own-session only', () => {
        expect(SESSION_JOB_TOOL_DESCRIPTION).toMatch(/Own-session only/i)
    })

    it('rejects update with empty patch', async () => {
        const result = await handleSessionJobTool(
            { action: 'update', jobKey: 'beets' },
            'sid-1'
        )
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/at least one/i)
    })
})
