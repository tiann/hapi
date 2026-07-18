import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@/agent/types'
import { GrokAcpBackend, type GrokTransport } from './grokBackend'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

class FakeTransport implements GrokTransport {
    notifications: ((method: string, params: unknown) => void) | null = null
    requestHandlers = new Map<string, (params: unknown, requestId: string | number | null) => Promise<unknown>>()
    fallbackRequestHandler: ((method: string, params: unknown, requestId: string | number | null) => Promise<{ handled: boolean; result?: unknown }>) | null = null
    requests: Array<{ method: string; params: unknown }> = []
    notificationsSent: Array<{ method: string; params: unknown }> = []
    promptResponse: Promise<unknown> | null = null
    onClose: (() => void) | null = null
    terminalHandler: ((error: Error) => void) | null = null
    closeResponse: Promise<void> | null = null
    open = true
    closeCalls = 0
    loadResponse: unknown = { sessionId: 'grok-session-1' }

    onNotification(handler: ((method: string, params: unknown) => void) | null): void {
        this.notifications = handler
    }

    onStderrError(): void {}

    onTerminal(handler: ((error: Error) => void) | null): void {
        this.terminalHandler = handler
    }

    isOpen(): boolean {
        return this.open
    }

    triggerTerminal(error: Error): void {
        this.open = false
        this.terminalHandler?.(error)
    }

    registerRequestHandler(method: string, handler: (params: unknown, requestId: string | number | null) => Promise<unknown>): void {
        this.requestHandlers.set(method, handler)
    }

    registerFallbackRequestHandler(handler: ((method: string, params: unknown, requestId: string | number | null) => Promise<{ handled: boolean; result?: unknown }>) | null): void {
        this.fallbackRequestHandler = handler
    }

    async sendRequest(method: string, params?: unknown): Promise<unknown> {
        this.requests.push({ method, params })
        if (method === 'session/prompt' && this.promptResponse) return this.promptResponse
        if (method === 'initialize') {
            return {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
                _meta: {
                    agentVersion: '0.2.93',
                    modelState: {
                        currentModelId: 'grok-4.5',
                        availableModels: [{
                            modelId: 'grok-4.5',
                            name: 'Grok 4.5',
                            _meta: { reasoningEfforts: [{ id: 'high', label: 'High', default: true }] }
                        }]
                    }
                }
            }
        }
        if (method === 'session/new') {
            return { sessionId: 'grok-session-1' }
        }
        if (method === 'session/load') return this.loadResponse
        if (method === 'session/prompt') {
            this.notifications?.('session/update', {
                sessionId: 'grok-session-1',
                update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } }
            })
            this.notifications?.('session/update', {
                sessionId: 'grok-session-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }
            })
            this.notifications?.('_x.ai/session_notification', {
                sessionId: 'grok-session-1',
                update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }
            })
            return { stopReason: 'end_turn' }
        }
        return {}
    }

    sendNotification(method: string, params?: unknown): void {
        this.notificationsSent.push({ method, params })
    }

    async close(): Promise<void> {
        this.closeCalls += 1
        this.triggerTerminal(new Error('ACP transport closed'))
        this.onClose?.()
        if (this.closeResponse) await this.closeResponse
    }
}

describe('GrokAcpBackend', () => {
    it('uses the dedicated Grok ACP process and captures live capabilities', async () => {
        const transport = new FakeTransport()
        const factory = vi.fn(() => transport)
        const backend = new GrokAcpBackend({ transportFactory: factory })

        await backend.initialize()

        expect(factory).toHaveBeenCalledWith({
            command: 'grok',
            args: ['--sandbox', 'workspace', 'agent', '--no-leader', 'stdio'],
            env: expect.any(Object)
        })
        expect(backend.getCapabilities()).toMatchObject({
            version: '0.2.93',
            currentModelId: 'grok-4.5',
            currentEffort: 'high'
        })
    })

    it.each([
        ['default', 'workspace'],
        ['read-only', 'read-only'],
        ['safe-yolo', 'workspace'],
        ['yolo', 'off']
    ] as const)('starts permission mode %s with native sandbox %s', async (permissionMode, sandbox) => {
        const transport = new FakeTransport()
        const factory = vi.fn(() => transport)
        const backend = new GrokAcpBackend({ transportFactory: factory, permissionMode })

        await backend.initialize()

        expect(factory).toHaveBeenCalledWith(expect.objectContaining({
            command: 'grok',
            args: ['--sandbox', sandbox, 'agent', '--no-leader', 'stdio']
        }))
    })

    it('does not expose HAPI or unrelated-provider credentials to Grok ACP', async () => {
        const transport = new FakeTransport()
        const factory = vi.fn(() => transport)
        const backend = new GrokAcpBackend({
            transportFactory: factory,
            env: {
                PATH: '/usr/bin',
                HOME: '/home/user',
                GROK_HOME: '/home/user/.grok',
                XAI_API_KEY: 'grok-provider-key',
                CLI_API_TOKEN: 'hapi-control-secret',
                HAPI_EXTRA_HEADERS_JSON: '{"Authorization":"secret"}',
                OPENAI_API_KEY: 'other-provider-secret'
            }
        })

        await backend.initialize()

        expect(factory).toHaveBeenCalledWith(expect.objectContaining({
            env: {
                PATH: '/usr/bin',
                HOME: '/home/user',
                GROK_HOME: '/home/user/.grok',
                XAI_API_KEY: 'grok-provider-key'
            }
        }))
    })

    it('creates, loads and configures the same native Grok session', async () => {
        const transport = new FakeTransport()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        await backend.initialize()

        await expect(backend.newSession({ cwd: '/repo', mcpServers: [] })).resolves.toBe('grok-session-1')
        await expect(backend.resumeSession('grok-session-1', { cwd: '/repo', mcpServers: [] }))
            .resolves.toEqual({ sessionId: 'grok-session-1', resumeSessionId: 'grok-session-1' })
        await backend.setSessionConfig('grok-session-1', { model: 'grok-4.5', effort: 'high' })

        expect(transport.requests).toEqual(expect.arrayContaining([
            { method: 'session/new', params: { cwd: '/repo', mcpServers: [] } },
            { method: 'session/load', params: { sessionId: 'grok-session-1', cwd: '/repo', mcpServers: [] } },
            { method: 'session/set_model', params: { sessionId: 'grok-session-1', modelId: 'grok-4.5' } },
            { method: 'session/set_mode', params: { sessionId: 'grok-session-1', modeId: 'high' } }
        ]))
    })

    it.each([
        ['non-object', null],
        ['missing session id', {}],
        ['conflicting session id', { sessionId: 'replacement-session' }]
    ])('rejects a %s session/load response without adopting a new identity', async (_label, loadResponse) => {
        const transport = new FakeTransport()
        transport.loadResponse = loadResponse
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        await backend.initialize()

        await expect(backend.resumeSession('grok-session-1', { cwd: '/repo', mcpServers: [] }))
            .rejects.toThrow(/session\/load|identity/i)
    })

    it('resolves auto model and effort to discovered native defaults', async () => {
        const transport = new FakeTransport()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        await backend.initialize()
        await expect(backend.setSessionConfig('grok-session-1', { model: null, effort: null }))
            .resolves.toEqual({ model: 'grok-4.5', effort: 'high' })
        expect(transport.requests).toEqual(expect.arrayContaining([
            { method: 'session/set_model', params: { sessionId: 'grok-session-1', modelId: 'grok-4.5' } },
            { method: 'session/set_mode', params: { sessionId: 'grok-session-1', modeId: 'high' } }
        ]))
    })

    it('reports the effective default effort after a model-only change', async () => {
        const transport = new FakeTransport()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        await backend.initialize()
        await expect(backend.setSessionConfig('grok-session-1', { model: 'grok-4.5' }))
            .resolves.toEqual({ model: 'grok-4.5', effort: 'high' })
    })

    it('rejects undiscovered model or effort before changing native state', async () => {
        const transport = new FakeTransport()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        await backend.initialize()
        await expect(backend.setSessionConfig('grok-session-1', { model: 'missing' })).rejects.toThrow('Unknown Grok model')
        await expect(backend.setSessionConfig('grok-session-1', { effort: 'ultra' })).rejects.toThrow('Unsupported Grok effort')
        expect(transport.requests.some((request) => request.method === 'session/set_model' || request.method === 'session/set_mode')).toBe(false)
    })

    it('streams reasoning and text once and routes Grok reverse requests', async () => {
        const transport = new FakeTransport()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        const messages: AgentMessage[] = []
        backend.onAskUserQuestion(async (request) => ({
            outcome: 'accepted',
            answers: { [request.questions[0]?.question ?? '0']: ['Alpha'] }
        }))
        backend.onPlanApproval(async () => ({ outcome: 'approved' }))
        await backend.initialize()
        await backend.newSession({ cwd: '/repo', mcpServers: [] })

        await backend.prompt('grok-session-1', [{ type: 'text', text: 'hello' }], (message) => messages.push(message))

        expect(messages).toEqual([
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'answer' },
            { type: 'turn_complete', stopReason: 'end_turn' }
        ])
        await expect(transport.requestHandlers.get('_x.ai/ask_user_question')?.({
            sessionId: 'grok-session-1',
            toolCallId: 'tool-1',
            questions: [{ question: 'Choose', options: [{ label: 'Alpha' }] }]
        }, 1)).resolves.toEqual({ outcome: 'accepted', answers: { Choose: ['Alpha'] } })
        await expect(transport.requestHandlers.get('_x.ai/exit_plan_mode')?.({
            sessionId: 'grok-session-1',
            toolCallId: 'tool-2',
            planContent: '# Plan'
        }, 2)).resolves.toEqual({ outcome: 'approved' })
    })

    it('cancels with the standard ACP notification and preserves unknown extensions', async () => {
        const transport = new FakeTransport()
        const unknown = vi.fn()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        backend.onUnknownExtension(unknown)
        await backend.initialize()

        transport.notifications?.('_x.ai/future/event', { value: 1 })
        await expect(transport.fallbackRequestHandler?.('_x.ai/future/request', { value: 2 }, 99))
            .resolves.toEqual({ handled: true, result: null })
        await backend.cancelPrompt('grok-session-1')

        expect(unknown).toHaveBeenCalledWith('_x.ai/future/event', { value: 1 })
        expect(unknown).toHaveBeenCalledWith('_x.ai/future/request', { value: 2 })
        expect(transport.notificationsSent).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'grok-session-1' }
        })
    })

    it('waits for an active prompt to settle after sending cancellation', async () => {
        const transport = new FakeTransport()
        const pendingPrompt = deferred<unknown>()
        transport.promptResponse = pendingPrompt.promise
        const backend = new GrokAcpBackend({ transportFactory: () => transport, cancelTimeoutMs: 100 })
        await backend.initialize()

        const prompt = backend.prompt('grok-session-1', [{ type: 'text', text: 'wait' }], () => {})
        let cancelSettled = false
        const cancel = backend.cancelPrompt('grok-session-1').finally(() => { cancelSettled = true })

        expect(cancelSettled).toBe(false)
        expect(transport.notificationsSent).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'grok-session-1' }
        })
        expect(transport.closeCalls).toBe(0)
        pendingPrompt.resolve({ stopReason: 'cancelled' })
        await expect(cancel).resolves.toBeUndefined()
        await expect(prompt).resolves.toBeUndefined()
        expect(transport.closeCalls).toBe(0)
    })

    it('force-closes a prompt that ignores cancellation and returns a typed timeout', async () => {
        const transport = new FakeTransport()
        const pendingPrompt = deferred<unknown>()
        transport.promptResponse = pendingPrompt.promise
        transport.onClose = () => pendingPrompt.reject(new Error('ACP transport closed by timeout'))
        const backend = new GrokAcpBackend({ transportFactory: () => transport, cancelTimeoutMs: 10 })
        await backend.initialize()
        expect(backend.isConnected()).toBe(true)

        const prompt = backend.prompt('grok-session-1', [{ type: 'text', text: 'hang' }], () => {})
        const promptOutcome = prompt.then(
            () => ({ error: null }),
            (error: unknown) => ({ error })
        )

        await expect(backend.cancelPrompt('grok-session-1')).rejects.toMatchObject({
            name: 'GrokCancelTimeoutError',
            timeoutMs: 10
        })
        const outcome = await promptOutcome
        expect(outcome.error).toBeInstanceOf(Error)
        expect((outcome.error as Error).message).toContain('ACP transport closed by timeout')
        expect(transport.closeCalls).toBe(1)
        expect(backend.isConnected()).toBe(false)
        expect(transport.notificationsSent).toContainEqual({
            method: 'session/cancel',
            params: { sessionId: 'grok-session-1' }
        })
    })

    it('reports an unexpected terminal transport before the prompt rejection is observed', async () => {
        const transport = new FakeTransport()
        const pendingPrompt = deferred<unknown>()
        const terminal = vi.fn()
        transport.promptResponse = pendingPrompt.promise
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        backend.onTerminalError(terminal)
        await backend.initialize()

        const prompt = backend.prompt('grok-session-1', [{ type: 'text', text: 'wait' }], () => {})
        const error = new Error('ACP process exited unexpectedly')
        transport.triggerTerminal(error)
        expect(backend.isConnected()).toBe(false)
        expect(terminal).toHaveBeenCalledWith(error)

        pendingPrompt.reject(error)
        await expect(prompt).rejects.toBe(error)
    })

    it('becomes disconnected before a force-close promise settles', async () => {
        const transport = new FakeTransport()
        const pendingPrompt = deferred<unknown>()
        const closeGate = deferred<void>()
        const terminal = vi.fn()
        transport.promptResponse = pendingPrompt.promise
        transport.closeResponse = closeGate.promise
        transport.onClose = () => pendingPrompt.reject(new Error('ACP transport closed by timeout'))
        const backend = new GrokAcpBackend({ transportFactory: () => transport, cancelTimeoutMs: 1 })
        backend.onTerminalError(terminal)
        await backend.initialize()

        const prompt = backend.prompt('grok-session-1', [{ type: 'text', text: 'hang' }], () => {})
        const promptOutcome = prompt.catch((error) => error)
        const cancel = backend.cancelPrompt('grok-session-1')
        await vi.waitFor(() => expect(transport.closeCalls).toBe(1))

        expect(backend.isConnected()).toBe(false)
        expect(terminal).toHaveBeenCalledTimes(1)
        await expect(promptOutcome).resolves.toBeInstanceOf(Error)

        closeGate.resolve()
        await expect(cancel).rejects.toBeInstanceOf(Error)
    })

    it('does not report an intentional disconnect as an unexpected terminal failure', async () => {
        const transport = new FakeTransport()
        const terminal = vi.fn()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        backend.onTerminalError(terminal)
        await backend.initialize()

        await backend.disconnect()

        expect(backend.isConnected()).toBe(false)
        expect(terminal).not.toHaveBeenCalled()
    })

    it('refreshes model and effort capabilities from live Grok model updates', async () => {
        const transport = new FakeTransport()
        const changed = vi.fn()
        const backend = new GrokAcpBackend({ transportFactory: () => transport })
        backend.onCapabilitiesChanged(changed)
        await backend.initialize()
        transport.notifications?.('_x.ai/models/update', {
            currentModelId: 'grok-next',
            availableModels: [{
                modelId: 'grok-next', name: 'Grok Next',
                _meta: { reasoningEfforts: [{ id: 'medium', label: 'Medium', default: true }] }
            }]
        })
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
            currentModelId: 'grok-next', currentEffort: 'medium'
        }))
    })
})
