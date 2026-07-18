import { afterEach, describe, expect, it, vi } from 'vitest'

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
    return {
        session: {
            sessionId: 'test-session',
            path: '/tmp/test',
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            claudeEnvVars: {},
            claudeArgs: [],
            mcpServers: [],
            allowedTools: [],
            hookSettingsPath: null,
            queue: { size: () => 0, reset: () => {}, setOnMessage: () => {} },
            client: {
                sendClaudeSessionMessage: (msg: Record<string, unknown>) => { sentMessages.push(msg) },
                hasSessionTitle: () => false,
                rpcHandlerManager: { registerHandler: () => {} }
            },
            addSessionFoundCallback: () => {},
            removeSessionFoundCallback: () => {},
            consumeOneTimeFlags: () => {},
            recordLocalLaunchFailure: () => {}
        },
        sentMessages
    }
}

describe('claudeLocalLauncher message filtering', () => {
    afterEach(() => {
        harness.launches = []
        harness.scannerOnMessage = null
    })

    it('uses Claude Code summary messages as a title fallback', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'summary', summary: 'Native title', leafUuid: '1' })

        expect(sentMessages).toEqual([{ type: 'summary', summary: 'Native title', leafUuid: '1' }])
    })

    it('converts Claude Code ai-title metadata into a HAPI title', async () => {
        const { session, sentMessages } = createSessionStub()
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({
            type: 'ai-title',
            aiTitle: '根据交接文档部署 HAPI 服务',
            sessionId: 'test-session'
        })

        expect(sentMessages).toHaveLength(1)
        expect(sentMessages[0]).toEqual(expect.objectContaining({
            type: 'summary',
            summary: '根据交接文档部署 HAPI 服务'
        }))
    })

    it('does not replace an existing HAPI title with ai-title metadata', async () => {
        const { session, sentMessages } = createSessionStub()
        session.client.hasSessionTitle = () => true
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'ai-title', aiTitle: 'Native title' })

        expect(sentMessages).toHaveLength(0)
    })

    it('does not replace an existing HAPI title with a native summary', async () => {
        const { session, sentMessages } = createSessionStub()
        session.client.hasSessionTitle = () => true
        await claudeLocalLauncher(session as never)

        harness.scannerOnMessage!({ type: 'summary', summary: 'Native title', leafUuid: '1' })

        expect(sentMessages).toHaveLength(0)
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
