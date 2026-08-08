import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return {
        ...actual,
        execFileSync: execFileSyncMock
    }
})

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => 'claude'
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

const SESSION_ID = '6f0c4551-1111-4222-8333-444455556666'

function rosterJson(entries: Array<Record<string, unknown>>): string {
    return JSON.stringify(entries)
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('getLiveAgentKind', () => {
    it('returns "background" when the session is alive as a background agent', async () => {
        execFileSyncMock.mockReturnValue(rosterJson([
            { pid: 1, kind: 'background', sessionId: SESSION_ID }
        ]))
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind(SESSION_ID)).toBe('background')
    })

    it('returns "interactive" when the session is alive as an interactive agent', async () => {
        execFileSyncMock.mockReturnValue(rosterJson([
            { pid: 2, kind: 'interactive', sessionId: SESSION_ID }
        ]))
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind(SESSION_ID)).toBe('interactive')
    })

    it('returns null when the session is not in the roster (dead -> resume directly)', async () => {
        execFileSyncMock.mockReturnValue(rosterJson([
            { pid: 3, kind: 'background', sessionId: 'some-other-session' }
        ]))
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind(SESSION_ID)).toBeNull()
    })

    it('returns null when the roster is empty', async () => {
        execFileSyncMock.mockReturnValue(rosterJson([]))
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind(SESSION_ID)).toBeNull()
    })

    it('returns null when "claude agents --json" fails (command unavailable / timeout)', async () => {
        execFileSyncMock.mockImplementation(() => {
            throw new Error('claude: command not found')
        })
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind(SESSION_ID)).toBeNull()
    })

    it('returns null when the output is not valid JSON', async () => {
        execFileSyncMock.mockReturnValue('not json at all')
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind(SESSION_ID)).toBeNull()
    })

    it('returns null for an empty sessionId without querying the roster', async () => {
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind('')).toBeNull()
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('treats an in-roster session with an unknown kind as held open (fork)', async () => {
        execFileSyncMock.mockReturnValue(rosterJson([
            { pid: 4, kind: 'something-new', sessionId: SESSION_ID }
        ]))
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        expect(getLiveAgentKind(SESSION_ID)).toBe('background')
    })

    it('passes "agents --json" to the resolved claude executable', async () => {
        execFileSyncMock.mockReturnValue(rosterJson([]))
        const { getLiveAgentKind } = await import('./getLiveAgentKind')
        getLiveAgentKind(SESSION_ID)
        expect(execFileSyncMock).toHaveBeenCalledTimes(1)
        const [command, args] = execFileSyncMock.mock.calls[0]
        expect(command).toBe('claude')
        expect(args).toEqual(['agents', '--json'])
    })
})
