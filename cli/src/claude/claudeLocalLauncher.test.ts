import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Metadata } from '@/api/types'

const harness = vi.hoisted(() => ({
    launches: [] as Array<Record<string, unknown>>,
    scannerOnMessage: null as ((message: Record<string, unknown>) => void) | null,
    nextLaunchError: null as Error | null
}))

vi.mock('./claudeLocal', () => ({
    claudeLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts)
        if (harness.nextLaunchError) {
            const err = harness.nextLaunchError
            harness.nextLaunchError = null
            throw err
        }
    }
}))

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: async (opts: { onMessage: (message: Record<string, unknown>) => void }) => {
        harness.scannerOnMessage = opts.onMessage
        return {
            cleanup: async () => {},
            onNewSession: () => {}
        }
    }
}))

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        constructor(private readonly opts: {
            launch: (signal: AbortSignal) => Promise<void>
            onLaunchSuccess?: () => void
        }) {}
        async run(): Promise<'exit'> {
            try {
                await this.opts.launch(new AbortController().signal)
                this.opts.onLaunchSuccess?.()
                return 'exit'
            } catch {
                return 'exit'
            }
        }
    }
}))

import { claudeLocalLauncher } from './claudeLocalLauncher'

function createSessionStub() {
    const sentMessages: Array<Record<string, unknown>> = []
    let metadata: Metadata = { path: '/tmp/test', host: 'localhost' }
    const session = {
        localPermissionBridge: { start: vi.fn(), stop: vi.fn(), onTranscript: vi.fn() },
        sessionId: 'test-session',
        thinking: false,
        localTurnStartedAt: 0,
        onThinkingChange: vi.fn(),
        path: '/tmp/test',
        startedBy: 'terminal' as const,
        startingMode: 'local' as const,
        claudeEnvVars: {},
        claudeArgs: [] as string[] | undefined,
        startupResumeSessionAt: undefined as string | undefined,
        getModel: (): string | null => 'claude-opus-4-1',
        getPermissionMode: () => 'default',
        mcpServers: [],
        allowedTools: [],
        hookSettingsPath: null,
        queue: { size: () => 0, reset: () => {}, setOnMessage: () => {} },
        client: {
            getMetadata: () => metadata,
            sendClaudeSessionMessage: (msg: Record<string, unknown>) => { sentMessages.push(msg) },
            updateMetadata: (handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            },
            rpcHandlerManager: { registerHandler: () => {} }
        },
        addSessionFoundCallback: () => {},
        removeSessionFoundCallback: () => {},
        consumeOneTimeFlags: () => {
            session.startupResumeSessionAt = undefined
        },
        consumeStartupResumeSessionAt: () => {
            session.startupResumeSessionAt = undefined
        },
        recordLocalLaunchFailure: () => {}
    }
    return {
        session,
        sentMessages,
        getMetadata: () => metadata,
        setMetadata: (value: Metadata) => { metadata = value }
    }
}

describe('claudeLocalLauncher message filtering', () => {
    afterEach(() => {
        harness.launches = []
        harness.scannerOnMessage = null
        harness.nextLaunchError = null
    })

    it('uses Claude Code summary messages as a title fallback', async () => {
        const { session, sentMessages, getMetadata } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'summary', summary: 'Native title', leafUuid: '1' })

        expect(sentMessages).toHaveLength(0)
        expect(getMetadata().summary?.text).toBe('Native title')
    })

    it('clears thinking on exit and on an Esc interrupt, which fires no Stop hook', async () => {
        const { session } = createSessionStub()
        await claudeLocalLauncher(session as never)
        expect(session.onThinkingChange).toHaveBeenCalledWith(false)

        session.onThinkingChange.mockClear()
        session.thinking = true
        harness.scannerOnMessage!({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'keep going' } })
        expect(session.onThinkingChange).not.toHaveBeenCalled()

        harness.scannerOnMessage!({
            type: 'user',
            uuid: 'u2',
            message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }
        })
        expect(session.onThinkingChange).toHaveBeenCalledWith(false)
    })

    it('ignores an interrupt marker delivered after a newer turn started', async () => {
        const { session } = createSessionStub()
        await claudeLocalLauncher(session as never)
        session.onThinkingChange.mockClear()
        session.thinking = true
        session.localTurnStartedAt = Date.parse('2026-10-27T10:00:05Z')

        harness.scannerOnMessage!({
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-10-27T10:00:04Z',
            message: { role: 'user', content: '[Request interrupted by user]' }
        })
        expect(session.onThinkingChange).not.toHaveBeenCalled()
    })

    it('passes the current session model to the local Claude process', async () => {
        const { session } = createSessionStub()

        await claudeLocalLauncher(session as never)

        expect(harness.launches[0]).toMatchObject({ model: 'claude-opus-4-1' })
        expect(session.localPermissionBridge.start).toHaveBeenCalledWith('test-session')
        expect(session.localPermissionBridge.stop).toHaveBeenCalled()
    })

    it('converts Claude Code ai-title metadata into a HAPI title', async () => {
        const { session, sentMessages, getMetadata } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'ai-title',
            aiTitle: '根据交接文档部署 HAPI 服务',
            sessionId: 'test-session'
        })

        expect(sentMessages).toHaveLength(0)
        expect(getMetadata().summary?.text).toBe('根据交接文档部署 HAPI 服务')
    })

    it('does not replace an existing HAPI title with ai-title metadata', async () => {
        const { session, sentMessages, getMetadata, setMetadata } = createSessionStub()
        setMetadata({ path: '/tmp/test', host: 'localhost', name: 'Manual title' })
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'ai-title', aiTitle: 'Native title' })

        expect(sentMessages).toHaveLength(0)
        expect(getMetadata()).toEqual({ path: '/tmp/test', host: 'localhost', name: 'Manual title' })
    })

    it('does not replace an existing HAPI title with a native summary', async () => {
        const { session, sentMessages, getMetadata, setMetadata } = createSessionStub()
        setMetadata({
            path: '/tmp/test',
            host: 'localhost',
            summary: { text: 'Existing title', updatedAt: 1 }
        })
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'summary', summary: 'Native title', leafUuid: '1' })

        expect(sentMessages).toHaveLength(0)
        expect(getMetadata().summary?.text).toBe('Existing title')
    })

    it('filters out invisible system messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'system', subtype: 'init', uuid: '1' })
        harness.scannerOnMessage!({ type: 'system', subtype: 'stop_hook_summary', uuid: '2' })
        harness.scannerOnMessage!({ type: 'system', uuid: '3' })

        expect(sentMessages).toHaveLength(0)
    })

    it('forwards visible system messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'system', subtype: 'api_error', uuid: '1' })
        harness.scannerOnMessage!({ type: 'system', subtype: 'turn_duration', uuid: '2' })

        expect(sentMessages).toHaveLength(2)
    })

    it('forwards away_summary (auto recap) system messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'system', subtype: 'away_summary', uuid: '1', content: 'recap text' })

        expect(sentMessages).toHaveLength(1)
        expect(sentMessages[0]).toMatchObject({ subtype: 'away_summary', content: 'recap text' })
    })

    it('forwards normal conversation messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'user', uuid: '1' })
        harness.scannerOnMessage!({ type: 'assistant', uuid: '2' })

        expect(sentMessages).toHaveLength(2)
    })

    it('publishes local Claude context details from assistant context_usage', async () => {
        const { session, sentMessages, getMetadata } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'assistant',
            uuid: 'assistant-context-details',
            timestamp: '2026-09-01T12:00:00.000Z',
            context_usage: {
                total_tokens: 26_697,
                raw_max_tokens: 262_144,
                mcp_tools: [{ name: 'mcp__hapi__list_peers', server_name: 'hapi' }]
            },
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'hello' }]
            }
        })

        expect(getMetadata().contextDetails).toMatchObject({
            provider: 'claude',
            contextWindow: 262_144,
            usage: { contextTokens: 26_697, sampledAt: Date.parse('2026-09-01T12:00:00.000Z'), sourceMessageUuid: 'assistant-context-details' },
            claude: {
                mcpTools: [{ name: 'mcp__hapi__list_peers', serverName: 'hapi' }]
            }
        })
        expect(sentMessages[0]).not.toHaveProperty('context_usage')
    })

    it.each([
        { explicitWindow: undefined, expectedWindow: 1_000_000 },
        { explicitWindow: 456_789, expectedWindow: 456_789 }
    ])('publishes the local assistant window before sending its message (%s)', async ({ explicitWindow, expectedWindow }) => {
        const { session, getMetadata } = createSessionStub()
        session.getModel = () => 'sonnet[1m]'
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'assistant', uuid: 'assistant-local-window',
            message: {
                role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hello' }],
                usage: { input_tokens: 100, output_tokens: 1, ...(explicitWindow ? { context_window: explicitWindow } : {}) }
            }
        })

        expect(getMetadata().contextDetails).toMatchObject({
            model: 'claude-sonnet-4-5', contextWindow: expectedWindow, usage: { contextTokens: 100 }
        })
    })

    it('does not replace context details with a synthetic API error', async () => {
        const { session, getMetadata } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'assistant',
            uuid: 'valid-context-details',
            context_usage: {
                model: 'claude-sonnet-5-5',
                total_tokens: 26_697,
                raw_max_tokens: 1_000_000
            },
            message: {
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: 'hello' }]
            }
        })
        const beforeError = getMetadata().contextDetails

        harness.scannerOnMessage!({
            type: 'assistant',
            uuid: 'synthetic-api-error',
            isApiErrorMessage: true,
            error: 'invalid_request',
            message: {
                role: 'assistant',
                model: '<synthetic>',
                content: [{ type: 'text', text: 'Prompt is too long' }],
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                }
            }
        })

        expect(getMetadata().contextDetails).toEqual(beforeError)
    })

    it('keeps the resolved assistant model when a launch uses an alias', async () => {
        const { session, getMetadata } = createSessionStub()
        session.getModel = () => 'sonnet'
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'assistant',
            uuid: 'resolved-context-details',
            context_usage: {
                model: 'claude-sonnet-5-5',
                total_tokens: 26_697,
                raw_max_tokens: 1_000_000
            },
            message: {
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: 'hello' }]
            }
        })
        harness.scannerOnMessage!({
            type: 'assistant',
            uuid: 'resolved-ordinary-reply',
            message: {
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: 'still resolved' }]
            }
        })
        harness.scannerOnMessage!({
            type: 'system',
            subtype: 'turn_duration',
            uuid: 'model-less-system-event'
        })

        expect(getMetadata().contextDetails).toMatchObject({
            model: 'claude-sonnet-5-5',
            contextWindow: 1_000_000,
            usage: { contextTokens: 26_697 }
        })
    })

    it('does not let Claude sidechain context details replace parent metadata', async () => {
        const { session, getMetadata } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'assistant',
            uuid: 'parent-assistant',
            context_usage: {
                total_tokens: 100,
                raw_max_tokens: 1_000,
                mcp_tools: [{ name: 'mcp__parent__tool', server_name: 'parent' }]
            },
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'parent' }]
            }
        })
        const parentDetails = getMetadata().contextDetails

        harness.scannerOnMessage!({
            type: 'assistant',
            uuid: 'sidechain-assistant',
            isSidechain: true,
            context_usage: {
                total_tokens: 900,
                raw_max_tokens: 9_000,
                mcp_tools: [{ name: 'mcp__child__tool', server_name: 'child' }]
            },
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'child' }]
            }
        })

        expect(getMetadata().contextDetails).toEqual(parentDetails)
    })

    it('filters out isMeta messages (e.g. skill injections)', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'user',
            isMeta: true,
            uuid: '1',
            message: { content: [{ type: 'text', text: '# Skill content...' }] }
        })

        expect(sentMessages).toHaveLength(0)
        expect(session.localPermissionBridge.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ isMeta: true }))
    })

    it('filters out isCompactSummary messages', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'assistant',
            isCompactSummary: true,
            uuid: '1',
            message: { content: 'compacted context' }
        })

        expect(sentMessages).toHaveLength(0)
    })
})

describe('claudeLocalLauncher context window seed (#1858)', () => {
    afterEach(() => {
        harness.launches = []
        harness.scannerOnMessage = null
        harness.nextLaunchError = null
    })

    function assistant(model: string, usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 1 }) {
        return { type: 'assistant', uuid: model, message: { role: 'assistant', model, content: [], usage } }
    }

    it('stamps 1M on main-model messages when launched with a [1m] alias, not on subagent models', async () => {
        const { session, sentMessages } = createSessionStub()
        session.getModel = () => 'opus[1m]'
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!(assistant('claude-opus-5'))
        harness.scannerOnMessage!(assistant('claude-haiku-4-5-20251001'))

        expect(sentMessages[0]).toMatchObject({ message: { usage: { context_window: 1_000_000 } } })
        expect((sentMessages[1].message as { usage: Record<string, unknown> }).usage.context_window).toBeUndefined()
    })

    it('stamps nothing when the launch model is not a [1m] variant', async () => {
        const { session, sentMessages } = createSessionStub()
        session.getModel = () => 'opus'
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!(assistant('claude-opus-5'))

        expect((sentMessages[0].message as { usage: Record<string, unknown> }).usage.context_window).toBeUndefined()
    })

    it.each([
        ['sonnet', undefined], ['sonnet', 350_000], [null, undefined], [null, 350_000]
    ] as const)('drops a saved 1M window on the first sample with preset %s and window %s', async (preset, explicitWindow) => {
        const { session, getMetadata, setMetadata } = createSessionStub()
        session.getModel = () => preset
        setMetadata({ ...getMetadata(), contextDetails: {
            version: 1, provider: 'claude', updatedAt: 10,
            model: 'claude-sonnet-4-6', contextWindow: 1_000_000, usage: { contextTokens: 10 }
        } })
        await claudeLocalLauncher(session as never)
        // Simulate the resolved preset, independent of the test runner's user settings.
        const local = session as typeof session & { localContextModel: string | null }
        local.localContextModel = preset

        harness.scannerOnMessage!(assistant('claude-sonnet-4-6', {
            input_tokens: 20, ...(explicitWindow ? { context_window: explicitWindow } : {})
        }))
        expect(getMetadata().contextDetails?.usage?.contextTokens).toBe(20)
        expect(getMetadata().contextDetails?.contextWindow).toBe(explicitWindow)
    })

    it.each([undefined, 350_000])('does not inherit a 1M window after switching to the bare preset (%s)', async (explicitWindow) => {
        const { session, getMetadata } = createSessionStub()
        const local = session as typeof session & { localContextModel: string | null }
        session.getModel = () => 'sonnet[1m]'
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!(assistant('claude-sonnet-4-6', { input_tokens: 10 }))
        expect(getMetadata().contextDetails?.contextWindow).toBe(1_000_000)
        local.localContextModel = 'claude-sonnet-4-6'
        harness.scannerOnMessage!(assistant('claude-sonnet-4-6', {
            input_tokens: 20, ...(explicitWindow ? { context_window: explicitWindow } : {})
        }))
        expect(getMetadata().contextDetails?.usage?.contextTokens).toBe(20)
        expect(getMetadata().contextDetails?.contextWindow).toBe(explicitWindow)
    })

    it('follows an in-session model switch (PostModelSwitch to_model) and keeps explicit windows', async () => {
        const { session, sentMessages } = createSessionStub()
        session.getModel = () => 'opus'
        await claudeLocalLauncher(session as never)

        ;(session as { localContextModel?: string | null }).localContextModel = 'claude-sonnet-5-5[1m]'
        harness.scannerOnMessage!(assistant('claude-sonnet-5-5'))
        harness.scannerOnMessage!(assistant('claude-sonnet-5-5', { input_tokens: 1, output_tokens: 1, context_window: 500_000 }))

        expect(sentMessages[0]).toMatchObject({ message: { usage: { context_window: 1_000_000 } } })
        expect(sentMessages[1]).toMatchObject({ message: { usage: { context_window: 500_000 } } })
    })

    it('strips stale --resume <sourceId> and --fork-session from spawnArgs once the child transcript materialized', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-local-fork-'))
        const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
        try {
            process.env.CLAUDE_CONFIG_DIR = root
            const projectDir = join(root, 'projects', '/tmp/test'.replace(/[^a-zA-Z0-9]/g, '-'))
            mkdirSync(projectDir, { recursive: true })
            writeFileSync(
                join(projectDir, 'child-session-id.jsonl'),
                JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n'
            )

            const { session } = createSessionStub()
            session.sessionId = 'child-session-id'
            ;(session as { claudeArgs?: string[] }).claudeArgs = [
                '--resume',
                'source-session-id',
                '--fork-session',
                '--resume-session-at',
                'fork-boundary'
            ]

            await claudeLocalLauncher(session as never)

            expect(harness.launches[0]).toMatchObject({
                sessionId: 'child-session-id',
                claudeArgs: undefined
            })
        } finally {
            if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
            else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('applies startupResumeSessionAt to the initial launch without --fork-session and consumes it before respawn', async () => {
        const { session } = createSessionStub()
        session.sessionId = 'resumed-session-id'
        session.claudeArgs = undefined
        session.startupResumeSessionAt = 'user-boundary-uuid'

        await claudeLocalLauncher(session as never)
        expect(harness.launches[0]).toMatchObject({
            sessionId: 'resumed-session-id',
            claudeArgs: ['--resume-session-at', 'user-boundary-uuid']
        })
        expect(session.startupResumeSessionAt).toBeUndefined()

        // Subsequent launch/respawn must not re-apply the startup boundary.
        await claudeLocalLauncher(session as never)
        expect(harness.launches[1]).toMatchObject({
            sessionId: 'resumed-session-id',
            claudeArgs: undefined
        })
    })

    it('retains startupResumeSessionAt across an aborted initial launch failure until launch succeeds', async () => {
        const { session } = createSessionStub()
        session.sessionId = 'resumed-session-id'
        session.claudeArgs = undefined
        session.startupResumeSessionAt = 'user-boundary-uuid'
        harness.nextLaunchError = new Error('transient launch error')

        await claudeLocalLauncher(session as never)
        expect(harness.launches[0]).toMatchObject({
            claudeArgs: ['--resume-session-at', 'user-boundary-uuid']
        })
        expect(session.startupResumeSessionAt).toBe('user-boundary-uuid')

        await claudeLocalLauncher(session as never)
        expect(harness.launches[1]).toMatchObject({
            claudeArgs: ['--resume-session-at', 'user-boundary-uuid']
        })
        expect(session.startupResumeSessionAt).toBeUndefined()
    })
})
