import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@/api/types'

const harness = vi.hoisted(() => ({
    launches: [] as Array<Record<string, unknown>>,
    scannerOnMessage: null as ((message: Record<string, unknown>) => void) | null
}))

vi.mock('./claudeLocal', () => ({
    claudeLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts)
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
        constructor(private readonly opts: { launch: (signal: AbortSignal) => Promise<void> }) {}
        async run(): Promise<'exit'> {
            await this.opts.launch(new AbortController().signal)
            return 'exit'
        }
    }
}))

import { claudeLocalLauncher } from './claudeLocalLauncher'

function createSessionStub() {
    const sentMessages: Array<Record<string, unknown>> = []
    let metadata: Metadata = { path: '/tmp/test', host: 'localhost' }
    return {
        session: {
            localPermissionBridge: { start: vi.fn(), stop: vi.fn(), onTranscript: vi.fn() },
            sessionId: 'test-session',
            thinking: false,
            localTurnStartedAt: 0,
            onThinkingChange: vi.fn(),
            path: '/tmp/test',
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            claudeEnvVars: {},
            claudeArgs: [],
            getModel: () => 'claude-opus-4-1',
            getPermissionMode: () => 'default',
            mcpServers: [],
            allowedTools: [],
            hookSettingsPath: null,
            queue: { size: () => 0, reset: () => {}, setOnMessage: () => {} },
            client: {
                sendClaudeSessionMessage: (msg: Record<string, unknown>) => { sentMessages.push(msg) },
                updateMetadata: (handler: (current: Metadata) => Metadata) => {
                    metadata = handler(metadata)
                },
                rpcHandlerManager: { registerHandler: () => {} }
            },
            addSessionFoundCallback: () => {},
            removeSessionFoundCallback: () => {},
            consumeOneTimeFlags: () => {},
            recordLocalLaunchFailure: () => {}
        },
        sentMessages,
        getMetadata: () => metadata,
        setMetadata: (value: Metadata) => { metadata = value }
    }
}

describe('claudeLocalLauncher message filtering', () => {
    afterEach(() => {
        harness.launches = []
        harness.scannerOnMessage = null
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
})
