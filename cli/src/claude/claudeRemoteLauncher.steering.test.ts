import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

// Coverage for the opt-in steering path: a user message that arrives while a
// turn is already running is injected into that turn instead of waiting in
// session.queue for the turn's `result`. The interesting part is not that it
// works but where it must refuse to: every case the queue path models and the
// steering path does not (no live turn, mode change, process gone) has to fall
// back, or the message reaches a Claude process that cannot honour it.
type Spawn = {
    permissionMode: string
    messages: string[]
    steered: string[]
}

const harness = vi.hoisted(() => ({
    spawns: [] as Array<{ permissionMode: string; messages: string[]; steered: string[] }>,
    // Runs while the mocked claudeRemote is holding a turn open, i.e. after a
    // message was delivered and before its onReady. This is the window the
    // steering guards are meant to allow.
    duringTurn: null as ((spawn: Spawn) => void) | null,
    // Runs after onReady, when no turn is in flight any more.
    afterReady: null as ((spawn: Spawn) => void) | null,
    triggerSwitch: null as (() => void) | null
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        let current = await opts.nextMessage()
        if (!current) return

        const spawn: Spawn = {
            permissionMode: current.mode.permissionMode as string,
            messages: [current.message as string],
            steered: []
        }
        harness.spawns.push(spawn)
        opts.onSessionFound(`session-${harness.spawns.length}`)
        // Mirror the real claudeRemote: the channel is published once the
        // process exists and revoked in its finally.
        opts.onSteerReady?.((text: string) => { spawn.steered.push(text) })

        try {
            while (true) {
                harness.duringTurn?.(spawn)
                opts.onReady()
                harness.afterReady?.(spawn)
                harness.triggerSwitch?.()

                const next = await opts.nextMessage()
                if (!next) return
                spawn.messages.push(next.message as string)
            }
        } finally {
            opts.onSteerReady?.(null)
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
    const consumed: string[][] = []
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => void | Promise<void>) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        consumed,
        keepAlive: () => {},
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        emitMessagesConsumed: (localIds: string[]) => { consumed.push(localIds) },
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: () => {}
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

const DEFAULT_MODE: EnhancedMode = { permissionMode: 'default' }

describe('claudeRemoteLauncher steering', () => {
    beforeEach(() => {
        harness.spawns = []
        harness.duringTurn = null
        harness.afterReady = null
        harness.triggerSwitch = null
    })

    afterEach(() => {
        delete process.env.HAPI_CLAUDE_STEERING
        vi.clearAllMocks()
    })

    it('injects a mid-turn message into the live turn instead of queueing it', async () => {
        process.env.HAPI_CLAUDE_STEERING = '1'
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')

            let steerResult: boolean | null = null
            harness.duringTurn = () => {
                if (steerResult !== null) return
                steerResult = session.trySteer('mid-turn', DEFAULT_MODE, 'local-2')
            }
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(steerResult).toBe(true)
            expect(harness.spawns).toHaveLength(1)
            expect(harness.spawns[0].steered).toEqual(['mid-turn'])
            // It never touched the queue, so it cannot also arrive as a turn.
            expect(harness.spawns[0].messages).toEqual(['one'])
            expect(queue.size()).toBe(0)
            // ...but the hub still has to be told it is no longer pending. The
            // ack is deferred behind an OutgoingMessageQueue flush so it cannot
            // outrun this turn's agent messages, hence the tick.
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(client.consumed).toContainEqual(['local-2'])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('falls back to the queue when steering is not enabled', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')

            let steerResult: boolean | null = null
            harness.duringTurn = () => {
                if (steerResult !== null) return
                steerResult = session.trySteer('mid-turn', DEFAULT_MODE, 'local-2')
            }
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(steerResult).toBe(false)
            expect(harness.spawns[0].steered).toEqual([])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('steers when the sender asks for it even though the env default is off', async () => {
        // No HAPI_CLAUDE_STEERING: an explicit meta.steer=true from the web
        // composer must still be honoured, or the setting would do nothing
        // unless the env var were also set on the machine.
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')

            let steerResult: boolean | null = null
            harness.duringTurn = () => {
                if (steerResult !== null) return
                steerResult = session.trySteer('mid-turn', DEFAULT_MODE, 'local-2', true)
            }
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(steerResult).toBe(true)
            expect(harness.spawns[0].steered).toEqual(['mid-turn'])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('queues when the sender asks for it even though the env default is on', async () => {
        process.env.HAPI_CLAUDE_STEERING = '1'
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')

            let steerResult: boolean | null = null
            harness.duringTurn = () => {
                if (steerResult !== null) return
                steerResult = session.trySteer('mid-turn', DEFAULT_MODE, 'local-2', false)
            }
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(steerResult).toBe(false)
            expect(harness.spawns[0].steered).toEqual([])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('refuses a message whose mode needs a differently spawned process', async () => {
        process.env.HAPI_CLAUDE_STEERING = '1'
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')

            let steerResult: boolean | null = null
            harness.duringTurn = () => {
                if (steerResult !== null) return
                // 'plan' is enforced by a --permission-mode flag on the Claude
                // process, so it cannot be applied to one already running.
                steerResult = session.trySteer('planify', { permissionMode: 'plan' }, 'local-2')
            }
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(steerResult).toBe(false)
            expect(harness.spawns[0].steered).toEqual([])
            expect(client.consumed).not.toContainEqual(['local-2'])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('refuses once the turn has finished', async () => {
        process.env.HAPI_CLAUDE_STEERING = '1'
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')

            let steerResult: boolean | null = null
            harness.afterReady = () => {
                if (steerResult !== null) return
                steerResult = session.trySteer('too late', DEFAULT_MODE, 'local-2')
            }
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(steerResult).toBe(false)
            expect(harness.spawns[0].steered).toEqual([])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('refuses after an abort so the queue keeps the message', async () => {
        // The window between abort() and the teardown that revokes the channel:
        // `steer` and `turnInFlight` are both still set, but claudeRemote is
        // about to swallow the AbortError and return normally, which skips the
        // launcher's catch and therefore restoreInFlightMessage. Steering into
        // that window acks a message nothing will ever consume; the queue path
        // survives the abort, so it has to own it.
        process.env.HAPI_CLAUDE_STEERING = '1'
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')

            let steerResult: boolean | null = null
            harness.duringTurn = () => {
                if (steerResult !== null) return
                // Fire the abort RPC without awaiting: handleAbortRequest waits
                // on abortFuture, which only resolves in the launcher's finally.
                // The AbortController is signalled synchronously before that.
                void client.rpcHandlers.get(RPC_METHODS.Abort)?.()
                steerResult = session.trySteer('mid-turn', DEFAULT_MODE, 'local-2', true)
            }
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(steerResult).toBe(false)
            expect(harness.spawns[0].steered).toEqual([])
            expect(client.consumed).not.toContainEqual(['local-2'])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('uninstalls the hook once the launcher is done', async () => {
        process.env.HAPI_CLAUDE_STEERING = '1'
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            queue.push('one', DEFAULT_MODE, 'local-1')
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)

            expect(session.trySteer('after exit', DEFAULT_MODE, 'local-9')).toBe(false)
        } finally {
            session.stopKeepAlive()
        }
    })
})

describe('Session.trySteer', () => {
    it('reports not-steered when no hook is installed', () => {
        const client = createClientStub()
        const { session } = createSession(client)
        try {
            expect(session.trySteer('hello', DEFAULT_MODE, 'local-1')).toBe(false)
        } finally {
            session.stopKeepAlive()
        }
    })

    it('swallows a throwing hook so the caller still queues the message', () => {
        const client = createClientStub()
        const { session } = createSession(client)
        try {
            session.setSteerHook(() => { throw new Error('boom') })
            expect(session.trySteer('hello', DEFAULT_MODE, 'local-1')).toBe(false)
        } finally {
            session.setSteerHook(null)
            session.stopKeepAlive()
        }
    })
})
