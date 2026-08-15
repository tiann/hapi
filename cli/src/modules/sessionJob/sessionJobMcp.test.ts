import { describe, expect, it, vi } from 'vitest'
import {
    handleSessionJobTool,
    SESSION_JOB_RUN_RECIPE,
    SESSION_JOB_SET_REFUSED_TEXT,
    SESSION_JOB_TOOL_DESCRIPTION
} from './sessionJobMcp'

vi.mock('./sessionJob', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sessionJob')>()
    return {
        ...actual,
        setSessionJob: vi.fn(async () => {
            throw new Error('setSessionJob must not be called from MCP')
        }),
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
    }
})

describe('sessionJobMcp', () => {
    it('description steers to job run and forbids MCP set', () => {
        expect(SESSION_JOB_TOOL_DESCRIPTION).toMatch(/OUTLIVES/i)
        expect(SESSION_JOB_TOOL_DESCRIPTION).toMatch(/do NOT use action=set/i)
        expect(SESSION_JOB_TOOL_DESCRIPTION).toContain('hapi job run')
        expect(SESSION_JOB_TOOL_DESCRIPTION).toMatch(/Own-session only/i)
    })

    it('hard-refuses action=set and never calls setSessionJob', async () => {
        const { setSessionJob } = await import('./sessionJob')
        const result = await handleSessionJobTool(
            { action: 'set', jobKey: 'beets', label: 'beets import', remaining: 12 },
            'sid-1'
        )
        expect(result.isError).toBe(true)
        expect(result.text).toBe(SESSION_JOB_SET_REFUSED_TEXT)
        expect(result.text).toContain(SESSION_JOB_RUN_RECIPE)
        expect(setSessionJob).not.toHaveBeenCalled()
    })

    it('treats empty update as a heartbeat-only patch', async () => {
        const { updateSessionJob } = await import('./sessionJob')
        const result = await handleSessionJobTool(
            { action: 'update', jobKey: 'beets' },
            'sid-1'
        )
        expect(result.isError).toBe(false)
        expect(result.text).toContain('updated')
        expect(updateSessionJob).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionIdPrefix: 'sid-1',
                jobKey: 'beets',
                body: {}
            })
        )
    })

    it('rejects startedAt on update', async () => {
        const result = await handleSessionJobTool(
            { action: 'update', jobKey: 'beets', startedAt: 1_785_304_595_000 },
            'sid-1'
        )
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/startedAt is not valid over MCP/)
    })

    it('steers update-before-create to job run recipe', async () => {
        const { SessionJobError, updateSessionJob } = await import('./sessionJob')
        vi.mocked(updateSessionJob).mockRejectedValueOnce(
            new SessionJobError('not_found', 'job not found')
        )
        const result = await handleSessionJobTool(
            { action: 'update', jobKey: 'beets', remaining: 2 },
            'sid-1'
        )
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/session_job failed:/)
        expect(result.text).toMatch(/hapi job run/)
        expect(result.text).toMatch(/sleep stub/)
    })

    it('forwards null remaining so done/total can take over after a leftover meter', async () => {
        const { updateSessionJob } = await import('./sessionJob')
        vi.mocked(updateSessionJob).mockClear()
        const result = await handleSessionJobTool(
            {
                action: 'update',
                jobKey: 'beets',
                remaining: null,
                done: 3,
                total: 10
            },
            'sid-1'
        )
        expect(result.isError).toBe(false)
        expect(updateSessionJob).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    remaining: null,
                    done: 3,
                    total: 10
                })
            })
        )
    })
})
