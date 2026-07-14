import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

// runClaude.ts orchestrates a lot of infrastructure (bootstrap, MCP/hook HTTP
// servers, runner lifecycle). This test only cares about ONE thing: that the
// PreToolUse-hook back-sync path (claude self-reporting its live permission
// mode) updates HAPI's bookkeeping WITHOUT notifying the PTY launcher's
// respawn machinery, while every other permissionMode-changing path (here:
// the SetSessionConfig RPC) DOES notify it — regression guard for hostile-review
// finding #1 (back-sync re-entering the respawn path -> thrash).
//
// Every dependency below is a real side-effecting subsystem (HTTP servers,
// filesystem, process lifecycle) and is mocked out; `./loop` (which owns the
// actual claude-flavor `Session` instance) is mocked so the test supplies its
// own spy-able fake session via `onSessionReady`.

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({}))
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
        logFilePath: '/tmp/hapi-test.log'
    }
}))

vi.mock('@/claude/sdk/metadataExtractor', () => ({
    extractSDKMetadataAsync: vi.fn()
}))

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async () => ({
        url: 'http://127.0.0.1:0/mcp',
        toolNames: [] as string[],
        stop: vi.fn()
    }))
}))

const hookServerCapture: { opts: any } = { opts: null }
vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async (opts: any) => {
        hookServerCapture.opts = opts
        return { port: 1, token: 'test-token', stop: vi.fn() }
    })
}))

vi.mock('@/modules/common/hooks/generateHookSettings', () => ({
    generateHookSettingsFile: vi.fn(() => '/tmp/hapi-test-hooks.json'),
    cleanupHookSettingsFile: vi.fn()
}))

vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
}))

vi.mock('@/agent/localHandoff', () => ({
    registerLocalHandoffHandler: vi.fn()
}))

vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: vi.fn(() => ({
        registerProcessHandlers: vi.fn(),
        markCrash: vi.fn(),
        setExitCode: vi.fn(),
        setArchiveReason: vi.fn(),
        setSessionEndReason: vi.fn(),
        cleanup: vi.fn(async () => {}),
        cleanupAndExit: vi.fn(async () => {})
    })),
    createModeChangeHandler: vi.fn(() => () => {}),
    setControlledByUser: vi.fn()
}))

let loopSessionReadyHandler: ((session: unknown) => void) | null = null
const loopMock = vi.fn(async (opts: { onSessionReady?: (session: unknown) => void }) => {
    loopSessionReadyHandler = opts.onSessionReady ?? null
    loopSessionReadyHandler?.(fakeClaudeSession)
})
vi.mock('@/claude/loop', () => ({
    loop: (...args: unknown[]) => loopMock(...(args as [{ onSessionReady?: (session: unknown) => void }]))
}))

const bootstrapSessionMock = vi.fn()
vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: (...args: unknown[]) => bootstrapSessionMock(...args),
    bootstrapExistingSession: vi.fn()
}))

// The claude-flavor `Session` instance (normally constructed inside ./loop).
// Only the surface runClaude.ts actually touches is faked.
let fakeClaudeSession: {
    getPermissionMode: () => string
    getModel: () => null
    getEffort: () => undefined
    setPermissionMode: ReturnType<typeof vi.fn>
    setModel: ReturnType<typeof vi.fn>
    setEffort: ReturnType<typeof vi.fn>
    pushKeepAlive: ReturnType<typeof vi.fn>
}

function createFakeClaudeSession(initialMode: string) {
    let permissionMode = initialMode
    return {
        getPermissionMode: () => permissionMode,
        getModel: () => null,
        getEffort: () => undefined,
        setPermissionMode: vi.fn((mode: string) => { permissionMode = mode }),
        setModel: vi.fn(),
        setEffort: vi.fn(),
        pushKeepAlive: vi.fn()
    }
}

function createFakeApiSessionClient() {
    const rpcHandlers = new Map<string, (payload: unknown) => unknown>()
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: (payload: unknown) => unknown) => {
                rpcHandlers.set(method, handler)
            }
        },
        _rpcHandlers: rpcHandlers,
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn((fn: (state: Record<string, unknown>) => Record<string, unknown>) => fn({})),
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    }
}

import { runClaude } from './runClaude'

describe('runClaude PTY permissionMode: back-sync vs HAPI-driven changes', () => {
    afterEach(() => {
        hookServerCapture.opts = null
        loopSessionReadyHandler = null
        loopMock.mockClear()
        bootstrapSessionMock.mockReset()
    })

    it('does NOT notify the launcher respawn path when adopting claude-reported mode from the PreToolUse hook (back-sync)', async () => {
        fakeClaudeSession = createFakeClaudeSession('default')
        const apiSessionClient = createFakeApiSessionClient()
        bootstrapSessionMock.mockResolvedValue({
            api: {},
            session: apiSessionClient,
            sessionInfo: { id: 'sess-backsync' }
        })

        await runClaude({ interactive: true, permissionMode: 'default', workingDirectory: '/tmp/hapi-test-proj' })

        expect(hookServerCapture.opts?.onPreToolUse).toBeTypeOf('function')
        fakeClaudeSession.setPermissionMode.mockClear()

        // claude self-reports it is now in 'plan' mode (e.g. the user pressed
        // Shift+Tab directly in the terminal, or claude auto-exited a state on
        // its own). HAPI must adopt this into its own bookkeeping WITHOUT
        // notifying the PTY launcher (it's already running in that mode -
        // notifying would re-enter the respawn path pointlessly).
        await hookServerCapture.opts.onPreToolUse({ tool_name: 'Read', permission_mode: 'plan' })

        expect(fakeClaudeSession.setPermissionMode).toHaveBeenCalledWith('plan', { notify: false })
    })

    it('DOES notify the launcher respawn path for a HAPI-driven change via the SetSessionConfig RPC', async () => {
        fakeClaudeSession = createFakeClaudeSession('default')
        const apiSessionClient = createFakeApiSessionClient()
        bootstrapSessionMock.mockResolvedValue({
            api: {},
            session: apiSessionClient,
            sessionInfo: { id: 'sess-rpc' }
        })

        await runClaude({ interactive: true, permissionMode: 'default', workingDirectory: '/tmp/hapi-test-proj' })

        const setSessionConfig = apiSessionClient._rpcHandlers.get(RPC_METHODS.SetSessionConfig)
        expect(setSessionConfig).toBeTypeOf('function')
        fakeClaudeSession.setPermissionMode.mockClear()

        await setSessionConfig!({ permissionMode: 'acceptEdits' })

        expect(fakeClaudeSession.setPermissionMode).toHaveBeenCalledWith('acceptEdits', { notify: true })
    })
})
