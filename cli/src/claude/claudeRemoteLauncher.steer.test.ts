import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

// The steer RPC takes a queued message out of the waiting queue and writes it
// into the running Claude turn. claudeRemote() is replaced by a turn that stays
// open until the test ends it, so the RPC can be exercised mid-turn.
type SteerCallbacks = { onStarted: () => void | Promise<void>; onDropped: () => void }

const harness = vi.hoisted(() => ({
    steered: [] as Array<{ message: string; callbacks: SteerCallbacks; settled: boolean }>,
    steerAccepts: true,
    failAfterResult: false,
    runs: 0,
    respawnMessage: undefined as unknown,
    turnStarted: null as (() => void) | null,
    endTurn: null as (() => void) | null,
    triggerSwitch: null as (() => void) | null
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        harness.runs += 1
        if (harness.runs > 1) {
            // Respawn after a failure: leave remote mode and record what the
            // new process would have been handed.
            harness.triggerSwitch?.()
            harness.respawnMessage = await opts.nextMessage()
            return
        }
        const initial = await opts.nextMessage()
        if (!initial) {
            return
        }
        opts.onSteerableChange((message: string, callbacks: SteerCallbacks) => {
            if (!harness.steerAccepts) {
                return false
            }
            harness.steered.push({ message, callbacks, settled: false })
            return true
        })
        await new Promise<void>((resolve) => {
            harness.endTurn = resolve
            harness.turnStarted?.()
        })
        opts.onSteerableChange(null)
        if (harness.failAfterResult) {
            opts.onResult()
        }
        // Like claudeRemote(), prompts Claude never started go with the process.
        for (const steer of harness.steered) {
            if (!steer.settled) {
                steer.settled = true
                steer.callbacks.onDropped()
            }
        }
        if (harness.failAfterResult) {
            throw new Error('Claude exited')
        }
        harness.triggerSwitch?.()
    }
}))

/** Claude takes the steered prompt into the turn. */
async function startSteer(index: number): Promise<void> {
    const steer = harness.steered[index]
    steer.settled = true
    await steer.callbacks.onStarted()
}

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

type SteerResponse = { steered: boolean; error?: string }

function createClientStub() {
    const rpcHandlers = new Map<string, (payload?: unknown) => unknown>()
    const agentStates: Array<Record<string, unknown>> = []
    let agentState: Record<string, unknown> = {}
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: (payload?: unknown) => unknown) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        agentStates,
        keepAlive: () => {},
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        updateAgentState: (handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
            agentState = handler(agentState)
            agentStates.push(agentState)
        },
        emitMessagesConsumed: vi.fn(),
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: () => {},
        notePendingHubPromptEcho: vi.fn(),
        discardPendingHubPromptEcho: vi.fn(),
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

/** Start the launcher with one running turn; returns helpers to steer and finish. */
async function startTurn() {
    const client = createClientStub()
    const { session, queue } = createSession(client)
    queue.push('first', { permissionMode: 'default' }, 'local-1')
    harness.triggerSwitch = () => {
        void client.rpcHandlers.get(RPC_METHODS.Switch)?.()
    }
    const turnStarted = new Promise<void>((resolve) => { harness.turnStarted = resolve })
    const launched = claudeRemoteLauncher(session as any)
    await turnStarted

    return {
        client,
        session,
        queue,
        steer: async (localId: string) =>
            await client.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId }) as SteerResponse,
        finish: async () => {
            harness.endTurn?.()
            await launched
            session.stopKeepAlive()
        }
    }
}

describe('claudeRemoteLauncher steer RPC', () => {
    afterEach(() => {
        harness.steered = []
        harness.steerAccepts = true
        harness.failAfterResult = false
        harness.runs = 0
        harness.respawnMessage = undefined
        harness.turnStarted = null
        harness.endTurn = null
        harness.triggerSwitch = null
    })

    it('holds a steered message until Claude takes it, then marks it consumed', async () => {
        const turn = await startTurn()
        try {
            expect(turn.client.agentStates.at(-1)?.steeringActive).toBe(true)
            turn.queue.push('also check the tests', { permissionMode: 'default' }, 'local-2')

            expect(await turn.steer('local-2')).toEqual({ steered: true })

            expect(harness.steered.map((steer) => steer.message)).toEqual(['also check the tests'])
            expect(turn.queue.size()).toBe(0)
            expect(turn.client.notePendingHubPromptEcho).toHaveBeenCalledWith('also check the tests', 'local-2')
            expect(turn.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['local-2'], { steered: true })
            // Claude holds it but has not run it: it cannot be cancelled, and
            // it is not consumed yet.
            expect(turn.queue.cancelByLocalId('local-2')).toBe('in-flight')

            await startSteer(0)

            expect(turn.client.emitMessagesConsumed).toHaveBeenCalledWith(['local-2'], { steered: true })
            expect(turn.queue.cancelByLocalId('local-2')).toBe('consumed')
        } finally {
            await turn.finish()
        }
        expect(turn.client.agentStates.at(-1)?.steeringActive).toBe(false)
    })

    it('puts a steered message back in the queue when Claude never starts it', async () => {
        const turn = await startTurn()
        turn.queue.push('earlier', { permissionMode: 'default' }, 'local-2')
        turn.queue.push('also check the tests', { permissionMode: 'default' }, 'local-3')
        turn.queue.push('later', { permissionMode: 'default' }, 'local-4')
        try {
            expect(await turn.steer('local-3')).toEqual({ steered: true })
        } finally {
            // The turn is interrupted before Claude reaches the prompt.
            await turn.finish()
        }

        expect(turn.queue.queue.map((item) => item.localId)).toEqual(['local-2', 'local-3', 'local-4'])
        expect(turn.client.discardPendingHubPromptEcho).toHaveBeenCalledWith('local-3')
        expect(turn.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['local-3'], { steered: true })
    })

    it('does not replay the delivered message when Claude fails after its result', async () => {
        vi.stubEnv('CLAUDE_REMOTE_RESPAWN_BACKOFF_MS', '0')
        harness.failAfterResult = true
        const turn = await startTurn()
        await turn.finish()
        vi.unstubAllEnvs()

        expect(harness.runs).toBe(2)
        expect(harness.respawnMessage).toBeNull()
        expect(turn.queue.size()).toBe(0)
    })

    it('leaves a message queued when its mode differs from the running turn', async () => {
        const turn = await startTurn()
        try {
            turn.queue.push('plan this', { permissionMode: 'plan' }, 'local-2')

            const response = await turn.steer('local-2')

            expect(response.steered).toBe(false)
            expect(response.error).toMatch(/mode differs/)
            expect(turn.queue.peekByLocalId('local-2')).not.toBeNull()
            expect(harness.steered).toEqual([])
        } finally {
            await turn.finish()
        }
    })

    it('leaves slash commands queued', async () => {
        const turn = await startTurn()
        try {
            turn.queue.push('/review', { permissionMode: 'default' }, 'local-2')

            const response = await turn.steer('local-2')

            expect(response.steered).toBe(false)
            expect(turn.queue.peekByLocalId('local-2')).not.toBeNull()
            expect(harness.steered).toEqual([])
        } finally {
            await turn.finish()
        }
    })

    it('puts the message back when the turn ends before it is written', async () => {
        const turn = await startTurn()
        try {
            turn.queue.push('too late', { permissionMode: 'default' }, 'local-2')
            harness.steerAccepts = false

            const response = await turn.steer('local-2')

            expect(response.steered).toBe(false)
            expect(turn.queue.peekByLocalId('local-2')).not.toBeNull()
            expect(turn.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['local-2'], { steered: true })
        } finally {
            await turn.finish()
        }
    })

    it('rejects steering once no turn is running', async () => {
        const turn = await startTurn()
        await turn.finish()
        turn.queue.push('after the turn', { permissionMode: 'default' }, 'local-2')

        const response = await turn.steer('local-2')

        expect(response).toEqual({ steered: false, error: 'No active steerable turn' })
        expect(turn.queue.peekByLocalId('local-2')).not.toBeNull()
    })
})
