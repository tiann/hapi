import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

// Regression coverage for the mode gate in the relaunch loop: an attempt whose
// first batch arrives via `pending` (i.e. the previous attempt parked it on a
// mode change) must still seed modeHash/mode. Before the fix it left
// modeHash=null, so the NEXT mode switch passed the `(modeHash && hash !==
// modeHash)` check and was fed into a process spawned with the old
// --permission-mode — e.g. an 'auto' turn silently running as 'default'
// (tiann/hapi permission "Auto 完全无效" report).
const harness = vi.hoisted(() => ({
    // One entry per claudeRemote() call that actually received an initial
    // message: the mode it would spawn with plus every message it consumed.
    spawns: [] as Array<{ permissionMode: string; effort?: string; messages: string[] }>,
    // Live effort applier handed to the launcher; null keeps the restart path.
    effortApplier: null as null | ((effort: string | null) => Promise<boolean>),
    // Resolving this ends the current mock process while nextMessage() is pending.
    exitProcess: null as null | (() => void),
    bailouts: 0,
    triggerSwitch: null as (() => void) | null,
    // Message text that, once consumed, ends the test by firing the switch RPC.
    finalMessage: 'three'
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        const initial = await opts.nextMessage()
        if (!initial) {
            harness.bailouts += 1
            return
        }
        const spawn = {
            permissionMode: initial.mode.permissionMode as string,
            effort: initial.mode.effort as string | undefined,
            messages: [initial.message as string]
        }
        harness.spawns.push(spawn)
        if (harness.effortApplier) opts.setEffortApplier?.(harness.effortApplier)
        opts.onSessionFound(`session-${harness.spawns.length}`)
        // Mirror the real claudeRemote: a single call keeps consuming turns
        // until nextMessage() resolves null (mode change parked / abort).
        while (true) {
            if (spawn.messages.includes(harness.finalMessage)) {
                harness.triggerSwitch?.()
            }
            const exited = new Promise<'exited'>((resolve) => {
                harness.exitProcess = () => resolve('exited')
            })
            const next = await Promise.race([opts.nextMessage(), exited])
            if (next === 'exited' || !next) {
                return
            }
            spawn.messages.push(next.message as string)
        }
    }
}))

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        setOnPermissionRequest(): void {}
        getResponses(): Map<string, unknown> { return new Map() }
        onMessage(): void {}
        handleToolCall = async () => ({ behavior: 'allow', updatedInput: {} })
        reset(): void {}
        isAborted(): boolean { return false }
        handleModeChange(): void {}
    }
}))

vi.mock('./utils/sdkToLogConverter', () => ({
    SDKToLogConverter: class {
        updateSessionId(): void {}
        resetParentChain(): void {}
        convert(): null { return null }
        convertSidechainUserMessage(): null { return null }
        updateSelectedModel(): void {}
        generateInterruptedToolResult(): null { return null }
    }
}))

vi.mock('./utils/OutgoingMessageQueue', () => ({
    OutgoingMessageQueue: class {
        releaseToolCall(): void {}
        enqueue(): void {}
        async flush(): Promise<void> {}
        destroy(): void {}
    }
}))

import { claudeRemoteLauncher } from './claudeRemoteLauncher'
import { Session } from './session'

function createClientStub() {
    const rpcHandlers = new Map<string, () => void | Promise<void>>()
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => void | Promise<void>) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        keepAlive: () => {},
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        emitMessagesConsumed: () => {},
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: () => {},
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {}
    }
}

function createSession(client: ReturnType<typeof createClientStub>) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
    const session = new Session({
        api: {} as any,
        client: client as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        sessionId: null,
        claudeEnvVars: {},
        claudeArgs: undefined,
        mcpServers: {},
        messageQueue: queue,
        onModeChange: () => {},
        allowedTools: [],
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hook.json',
        permissionMode: 'default'
    })
    return { session, queue }
}

describe('claudeRemoteLauncher mode gate after pending delivery', () => {
    afterEach(() => {
        harness.spawns = []
        harness.bailouts = 0
        harness.triggerSwitch = null
        harness.effortApplier = null
        harness.exitProcess = null
        harness.finalMessage = 'three'
        vi.clearAllMocks()
    })

    it('a mode switch after a pending-delivered batch still forces a relaunch', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            // default -> auto -> default: the middle switch parks 'two', so the
            // second attempt starts from `pending`. The third message then
            // switches modes again and must NOT be fed into the auto process.
            queue.push('one', { permissionMode: 'default' }, 'local-1')
            queue.push('two', { permissionMode: 'auto' }, 'local-2')
            queue.push('three', { permissionMode: 'default' }, 'local-3')
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.spawns).toEqual([
                { permissionMode: 'default', effort: undefined, messages: ['one'] },
                { permissionMode: 'auto', effort: undefined, messages: ['two'] },
                { permissionMode: 'default', effort: undefined, messages: ['three'] }
            ])
        } finally {
            session.stopKeepAlive()
        }
    })
})

describe('claudeRemoteLauncher live effort changes', () => {
    afterEach(() => {
        harness.spawns = []
        harness.bailouts = 0
        harness.triggerSwitch = null
        harness.effortApplier = null
        harness.exitProcess = null
        harness.finalMessage = 'three'
        vi.clearAllMocks()
    })

    async function run(pushes: Array<[string, EnhancedMode]>, finalMessage: string) {
        const client = createClientStub()
        const { session, queue } = createSession(client)
        try {
            pushes.forEach(([message, mode], index) => queue.push(message, mode, `local-${index}`))
            harness.finalMessage = finalMessage
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }
            await claudeRemoteLauncher(session as any)
        } finally {
            session.stopKeepAlive()
        }
    }

    it('applies an effort-only change to the running Claude process', async () => {
        const applied: Array<string | null> = []
        harness.effortApplier = async (effort) => {
            applied.push(effort)
            return true
        }

        await run([
            ['one', { permissionMode: 'default', effort: 'high' }],
            ['two', { permissionMode: 'default', effort: 'low' }],
            ['three', { permissionMode: 'default' }]
        ], 'three')

        expect(applied).toEqual(['low', null])
        expect(harness.spawns).toEqual([
            { permissionMode: 'default', effort: 'high', messages: ['one', 'two', 'three'] }
        ])
    })

    it('restarts Claude when it refuses the live effort change', async () => {
        harness.effortApplier = async () => false

        await run([
            ['one', { permissionMode: 'default', effort: 'high' }],
            ['two', { permissionMode: 'default', effort: 'low' }]
        ], 'two')

        expect(harness.spawns).toEqual([
            { permissionMode: 'default', effort: 'high', messages: ['one'] },
            { permissionMode: 'default', effort: 'low', messages: ['two'] }
        ])
    })

    it('keeps the prompt for the next process when Claude exits during the effort change', async () => {
        const applied: Array<string | null> = []
        harness.effortApplier = async (effort) => {
            applied.push(effort)
            // The process dies before answering; the applier then reports it closed.
            harness.exitProcess?.()
            await new Promise((resolve) => setTimeout(resolve, 0))
            return false
        }

        await run([
            ['one', { permissionMode: 'default', effort: 'high' }],
            ['two', { permissionMode: 'default', effort: 'low' }]
        ], 'two')

        expect(applied).toEqual(['low'])
        expect(harness.spawns).toEqual([
            { permissionMode: 'default', effort: 'high', messages: ['one'] },
            { permissionMode: 'default', effort: 'low', messages: ['two'] }
        ])
    })

    it('restarts without a live apply when another process setting changes too', async () => {
        const applier = vi.fn(async () => true)
        harness.effortApplier = applier

        await run([
            ['one', { permissionMode: 'default', effort: 'high' }],
            ['two', { permissionMode: 'default', effort: 'low', model: 'claude-sonnet-5-5' }]
        ], 'two')

        expect(applier).not.toHaveBeenCalled()
        expect(harness.spawns).toEqual([
            { permissionMode: 'default', effort: 'high', messages: ['one'] },
            { permissionMode: 'default', effort: 'low', messages: ['two'] }
        ])
    })
})
