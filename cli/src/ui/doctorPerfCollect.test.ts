import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    execFileSyncMock,
    fetchMock,
    listRunnerSessionsMock,
    psListMock,
    readRunnerStateMock,
    readSettingsMock
} = vi.hoisted(() => ({
    execFileSyncMock: vi.fn(() => '[]'),
    fetchMock: vi.fn(),
    listRunnerSessionsMock: vi.fn(),
    psListMock: vi.fn(),
    readRunnerStateMock: vi.fn(),
    readSettingsMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
    execFileSync: execFileSyncMock
}))

vi.mock('ps-list', () => ({
    default: psListMock
}))

vi.mock('@/persistence', () => ({
    readRunnerState: readRunnerStateMock,
    readSettings: readSettingsMock
}))

vi.mock('@/runner/controlClient', () => ({
    listRunnerSessions: listRunnerSessionsMock
}))

import { collectPerfSnapshot } from './doctorPerf'

describe('collectPerfSnapshot', () => {
    beforeEach(() => {
        execFileSyncMock.mockClear()
        fetchMock.mockReset()
        listRunnerSessionsMock.mockReset()
        psListMock.mockReset()
        readRunnerStateMock.mockReset()
        readSettingsMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
    })

    it('does not count app servers for hidden-by-limit sessions as untracked', async () => {
        readSettingsMock.mockResolvedValue({ cliApiToken: 'access-token' })
        readRunnerStateMock.mockResolvedValue({ pid: 33246 })
        listRunnerSessionsMock.mockResolvedValue([
            { happySessionId: 'shown', pid: 100 },
            { happySessionId: 'hidden', pid: 200 }
        ])
        psListMock.mockResolvedValue([
            { pid: 100, ppid: 1, name: 'bun', cmd: 'runner session shown' },
            { pid: 101, ppid: 100, name: 'node', cmd: 'codex app-server' },
            { pid: 200, ppid: 1, name: 'bun', cmd: 'runner session hidden' },
            { pid: 201, ppid: 200, name: 'node', cmd: 'codex app-server' }
        ])
        fetchMock.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('/api/auth')
                ? { token: 'jwt' }
                : {
                    sessions: [
                        { id: 'shown', title: 'Shown', active: true, thinking: false, pendingRequestsCount: 0, updatedAt: 20 },
                        { id: 'hidden', title: 'Hidden', active: true, thinking: false, pendingRequestsCount: 0, updatedAt: 10 }
                    ]
                }
        }))

        const snapshot = await collectPerfSnapshot({ limit: 1 })

        expect(snapshot.sessions.map((session) => session.id)).toEqual(['shown'])
        expect(snapshot.untrackedAppServerPids).toEqual([])
    })

    it('recognizes Claude runner children instead of warning about missing Codex app-server', async () => {
        readSettingsMock.mockResolvedValue({ cliApiToken: 'access-token' })
        readRunnerStateMock.mockResolvedValue({ pid: 33246 })
        listRunnerSessionsMock.mockResolvedValue([
            { happySessionId: 'claude-session', pid: 300 }
        ])
        psListMock.mockResolvedValue([
            { pid: 300, ppid: 1, name: 'bun', cmd: 'hapi claude --model opus[1m]' },
            { pid: 301, ppid: 300, name: 'claude', cmd: 'claude --output-format stream-json --model opus[1m]' },
            { pid: 302, ppid: 301, name: 'bun', cmd: 'bun run --cwd /Users/example/.claude/plugins/cache/telegram start' }
        ])
        fetchMock.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('/api/auth')
                ? { token: 'jwt' }
                : {
                    sessions: [
                        {
                            id: 'claude-session',
                            title: 'Claude Thread',
                            active: true,
                            thinking: false,
                            pendingRequestsCount: 0,
                            updatedAt: 20,
                            model: 'opus[1m]'
                        }
                    ]
                }
        }))

        const snapshot = await collectPerfSnapshot({ limit: 1 })
        const [claudeSession] = snapshot.sessions

        expect(claudeSession.backendKind).toBe('claude')
        expect(claudeSession.backendProcessPids).toEqual([301])
        expect(claudeSession.appServerPids).toEqual([])
        expect(claudeSession.warnings).not.toContain('runner session has no Codex app-server child')
    })

    it('recognizes Antigravity agy sessions by flavor even when the model label starts with Gemini', async () => {
        readSettingsMock.mockResolvedValue({ cliApiToken: 'access-token' })
        readRunnerStateMock.mockResolvedValue({ pid: 33246 })
        listRunnerSessionsMock.mockResolvedValue([
            { happySessionId: 'agy-session', pid: 350 }
        ])
        psListMock.mockResolvedValue([
            { pid: 350, ppid: 1, name: 'bun', cmd: 'hapi agy --model Gemini 3.5 Flash (High)' },
            { pid: 351, ppid: 350, name: 'agy', cmd: 'agy --model Gemini 3.5 Flash (High) --print hello' }
        ])
        fetchMock.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('/api/auth')
                ? { token: 'jwt' }
                : {
                    sessions: [
                        {
                            id: 'agy-session',
                            title: 'Agy Thread',
                            active: true,
                            thinking: true,
                            pendingRequestsCount: 0,
                            updatedAt: 20,
                            model: 'Gemini 3.5 Flash (High)',
                            metadata: { flavor: 'agy' }
                        }
                    ]
                }
        }))

        const snapshot = await collectPerfSnapshot({ limit: 1 })
        const [agySession] = snapshot.sessions

        expect(agySession.backendKind).toBe('agy')
        expect(agySession.backendProcessPids).toEqual([351])
        expect(agySession.appServerPids).toEqual([])
        expect(agySession.warnings).not.toContain('runner session has no Codex app-server child')
    })

    it('does not warn when an idle Claude session has no transient claude child process', async () => {
        readSettingsMock.mockResolvedValue({ cliApiToken: 'access-token' })
        readRunnerStateMock.mockResolvedValue({ pid: 33246 })
        listRunnerSessionsMock.mockResolvedValue([
            { happySessionId: 'claude-idle', pid: 400 }
        ])
        psListMock.mockResolvedValue([
            { pid: 400, ppid: 1, name: 'bun', cmd: 'hapi claude --resume claude-thread --model opus[1m]' }
        ])
        fetchMock.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('/api/auth')
                ? { token: 'jwt' }
                : {
                    sessions: [
                        {
                            id: 'claude-idle',
                            title: 'Idle Claude Thread',
                            active: true,
                            thinking: false,
                            pendingRequestsCount: 0,
                            updatedAt: 20,
                            model: 'opus[1m]'
                        }
                    ]
                }
        }))

        const snapshot = await collectPerfSnapshot({ limit: 1 })
        const [claudeSession] = snapshot.sessions

        expect(claudeSession.backendKind).toBe('claude')
        expect(claudeSession.backendProcessPids).toEqual([])
        expect(claudeSession.warnings).not.toContain('runner session has no Claude child')
    })

    it('keeps external Codex app servers out of HAPI untracked warnings', async () => {
        readSettingsMock.mockResolvedValue({ cliApiToken: 'access-token' })
        readRunnerStateMock.mockResolvedValue({ pid: 33246 })
        listRunnerSessionsMock.mockResolvedValue([])
        psListMock.mockResolvedValue([
            { pid: 500, ppid: 1, name: 'Codex', cmd: '/Applications/Codex.app/Contents/MacOS/Codex' },
            { pid: 501, ppid: 500, name: 'codex', cmd: '/Applications/Codex.app/Contents/Resources/codex app-server' },
            { pid: 600, ppid: 1, name: 'node', cmd: '/path/to/codex-im/bin/codex-im.js feishu-bot' },
            { pid: 601, ppid: 600, name: 'node', cmd: 'node /opt/homebrew/bin/codex app-server' },
            { pid: 700, ppid: 1, name: 'bun', cmd: '/path/to/hapi-source/cli/src/index.ts codex --started-by runner' },
            { pid: 701, ppid: 700, name: 'node', cmd: 'node /opt/homebrew/bin/codex app-server' },
            { pid: 702, ppid: 701, name: 'codex', cmd: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex app-server' }
        ])
        fetchMock.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => url.includes('/api/auth') ? { token: 'jwt' } : { sessions: [] }
        }))

        const snapshot = await collectPerfSnapshot({ limit: 8 })

        expect(snapshot.untrackedAppServerPids).toEqual([701, 702])
        expect(snapshot.externalAppServerPids).toEqual([501, 601])
        expect(snapshot.warnings).toEqual(['2 untracked HAPI Codex app-server processes'])
    })
})
