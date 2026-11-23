import { describe, expect, it, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import type { AgentActivitySession } from '@hapi/protocol/apiTypes'
import {
    ACTIVITY_REPORT_SCHEMA,
    ActivityError,
    exitCodeForActivityError,
    fetchActivity,
    formatActivityReport,
    parseTimeArg,
    workedMs
} from './activity'

vi.mock('@/persistence', () => ({
    readSettings: vi.fn(async () => ({ machineId: 'local-machine' }))
}))

type MockResponse = { status: number; data: unknown }

function createHttp(activity: MockResponse, auth: MockResponse = { status: 200, data: { token: 'jwt' } }) {
    return {
        post: vi.fn(async () => auth),
        get: vi.fn(async (_url: string, _config?: { params?: Record<string, unknown>; headers?: Record<string, string> }) => activity)
    }
}

const session: AgentActivitySession = {
    id: 'session-1',
    flavor: 'codex',
    agentSessionId: 'thread-1',
    machineId: 'remote-machine',
    host: 'build-box',
    machineName: 'Build box',
    path: '/srv/project',
    title: 'Port the runner',
    turns: [
        { start: 0, end: 600_000, endReason: 'idle', startedBy: 'hub_prompt' },
        { start: 900_000, end: null, endReason: null, startedBy: 'agent' }
    ],
    waits: [{ start: 100_000, end: 160_000, kind: 'permission', tool: 'Bash' }]
}

describe('parseTimeArg', () => {
    const now = Date.UTC(2026, 9, 29, 12)

    it('reads relative times, ISO dates and epoch milliseconds', () => {
        expect(parseTimeArg('30m', now)).toBe(now - 30 * 60_000)
        expect(parseTimeArg('24h', now)).toBe(now - 24 * 3_600_000)
        expect(parseTimeArg('7d', now)).toBe(now - 7 * 86_400_000)
        expect(parseTimeArg('2026-10-01T00:00:00Z', now)).toBe(Date.UTC(2026, 9, 1))
        expect(parseTimeArg('1793000000000', now)).toBe(1_793_000_000_000)
    })

    it('rejects anything else', () => {
        expect(() => parseTimeArg('yesterday', now)).toThrow(ActivityError)
    })
})

describe('fetchActivity', () => {
    it('wraps the hub response in a versioned report', async () => {
        const http = createHttp({ status: 200, data: { since: 1, until: 2, generatedAt: 3, sessions: [session] } })
        const report = await fetchActivity({
            since: 1, until: 2, apiUrl: 'https://hub.example', accessToken: 'token',
            http: http as unknown as AxiosInstance, now: () => 42
        })

        expect(report).toEqual({
            schema: ACTIVITY_REPORT_SCHEMA,
            generatedAt: 42,
            hubUrl: 'https://hub.example',
            localMachineId: 'local-machine',
            since: 1,
            until: 2,
            sessions: [session]
        })
        const [url, config] = http.get.mock.calls[0]!
        expect(url).toBe('https://hub.example/api/activity')
        expect(config?.params).toEqual({ since: 1, until: 2 })
        expect(config?.headers?.Authorization).toBe('Bearer jwt')
    })

    it('says when the hub is too old, the token is refused, or the request fails', async () => {
        const run = (activity: MockResponse, auth?: MockResponse) => fetchActivity({
            since: 1, until: 2, apiUrl: 'https://hub.example', accessToken: 'token',
            http: createHttp(activity, auth) as unknown as AxiosInstance
        }).catch((error: ActivityError) => error.code)

        expect(await run({ status: 404, data: 'Not Found' })).toBe('hub_too_old')
        expect(await run({ status: 200, data: {} }, { status: 401, data: { error: 'Invalid token' } })).toBe('auth_failed')
        expect(await run({ status: 400, data: { error: 'The window can be at most 31 days' } })).toBe('request_failed')
    })

    it('rejects an empty window before asking the hub', async () => {
        const http = createHttp({ status: 200, data: { sessions: [] } })
        await expect(fetchActivity({ since: 5, until: 5, http: http as unknown as AxiosInstance })).rejects.toThrow(ActivityError)
        expect(http.post).not.toHaveBeenCalled()
    })

    it('maps errors to documented exit codes', () => {
        expect(exitCodeForActivityError(new ActivityError('bad_args', ''))).toBe(2)
        expect(exitCodeForActivityError(new ActivityError('auth_failed', ''))).toBe(3)
        expect(exitCodeForActivityError(new ActivityError('hub_too_old', ''))).toBe(4)
        expect(exitCodeForActivityError(new ActivityError('request_failed', ''))).toBe(1)
    })
})

describe('reporting', () => {
    it('counts turns minus waits, open turns up to the end of the window', () => {
        // 600s turn minus a 60s wait, plus an open turn from 900s to 1000s.
        expect(workedMs(session, { since: 0, until: 1_000_000 })).toBe(540_000 + 100_000)
    })

    it('only counts the part of a turn inside the window', () => {
        const long: AgentActivitySession = {
            ...session,
            turns: [{ start: 0, end: 3 * 3_600_000, endReason: 'idle', startedBy: 'agent' }],
            waits: [{ start: 3_600_000 - 600_000, end: 3_600_000 + 600_000, kind: 'permission', tool: 'Bash' }]
        }
        // One hour out of a three-hour turn, minus the ten minutes of the wait inside it.
        expect(workedMs(long, { since: 3_600_000, until: 2 * 3_600_000 })).toBe(3_600_000 - 600_000)
        // An open turn in an earlier window stops at that window's end.
        const open: AgentActivitySession = { ...session, turns: [{ start: 0, end: null, endReason: null, startedBy: 'agent' }], waits: [] }
        expect(workedMs(open, { since: 0, until: 60_000 })).toBe(60_000)
    })

    it('subtracts overlapping waits once', () => {
        const minute = 60_000
        const parallel: AgentActivitySession = {
            ...session,
            turns: [{ start: 0, end: 10 * minute, endReason: 'idle', startedBy: 'agent' }],
            waits: [
                { start: 2 * minute, end: 6 * minute, kind: 'permission', tool: 'Bash' },
                { start: 4 * minute, end: 8 * minute, kind: 'input', tool: 'AskUserQuestion' }
            ]
        }
        expect(workedMs(parallel, { since: 0, until: 20 * minute })).toBe(4 * minute)
    })

    it('lists sessions busiest first, saying where they ran', () => {
        const local: AgentActivitySession = {
            ...session, id: 'session-2', machineId: 'local-machine', title: 'Short one',
            turns: [{ start: 0, end: 60_000, endReason: 'idle', startedBy: 'agent' }], waits: []
        }
        const text = formatActivityReport({
            schema: ACTIVITY_REPORT_SCHEMA, generatedAt: 1_000_000, hubUrl: 'https://hub.example',
            localMachineId: 'local-machine', since: 0, until: 1_000_000, sessions: [local, session]
        })
        const lines = text.split('\n')
        expect(lines[0]).toBe('Agents worked 12m across 2 sessions:')
        expect(lines[1]).toContain('Port the runner · codex · Build box · 2 turns (working now)')
        expect(lines[2]).toContain('Short one · codex · this machine · 1 turn')
    })

    it('says so when nothing happened', () => {
        expect(formatActivityReport({
            schema: ACTIVITY_REPORT_SCHEMA, generatedAt: 0, hubUrl: '', localMachineId: null, since: 0, until: 1, sessions: []
        })).toBe('No agent activity in this period.')
    })
})
