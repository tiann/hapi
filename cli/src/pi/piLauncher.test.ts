import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    piSessionMock: null as {
        sessionId: string
        subscribe: (cb: (event: unknown) => void) => () => void
        prompt: (message: string) => Promise<void>
        abort: () => Promise<void>
        dispose: () => void
        setThinkingLevel: (level: string) => void
        setModel: (model: unknown) => Promise<void>
        modelRegistry: {
            getAll: () => Array<{ provider: string; id: string }>
        }
    } | null,
    subscribeCallback: null as ((event: unknown) => void) | null,
    promptCalls: [] as string[],
    abortCalls: 0,
    disposeCalls: 0,
    thinkingLevelCalls: [] as string[],
    setModelCalls: [] as unknown[]
}))

vi.mock('@mariozechner/pi-coding-agent', () => ({
    createAgentSession: async () => {
        harness.piSessionMock = {
            sessionId: 'pi-session-123',
            subscribe: (cb) => {
                harness.subscribeCallback = cb
                return () => { harness.subscribeCallback = null }
            },
            prompt: async (message) => {
                harness.promptCalls.push(message)
            },
            abort: async () => {
                harness.abortCalls++
            },
            dispose: () => {
                harness.disposeCalls++
            },
            setThinkingLevel: (level) => {
                harness.thinkingLevelCalls.push(level)
            },
            setModel: async (model) => {
                harness.setModelCalls.push(model)
            },
            modelRegistry: {
                getAll: () => [
                    { provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
                    { provider: 'anthropic', id: 'claude-opus-4-20250514' },
                    { provider: 'openai', id: 'gpt-4o' }
                ]
            }
        }
        return { session: harness.piSessionMock }
    }
}))

vi.mock('./utils/piEventConverter', () => ({
    PiEventConverter: class {
        convert = vi.fn().mockReturnValue([])
        reset = vi.fn()
    }
}))

import { PiLauncher } from './piLauncher'

const createSessionStub = () => {
    const agentMessages: unknown[] = []
    const sessionEvents: unknown[] = []
    let sessionFoundId: string | null = null
    let thinkingState = false
    let waitResolve: ((value: unknown) => void) | null = null

    return {
        session: {
            path: '/tmp/test-project',
            queue: {
                waitForMessagesAndGetAsString: async (signal: AbortSignal) => {
                    return new Promise((resolve) => {
                        waitResolve = resolve
                        signal.addEventListener('abort', () => resolve(null))
                    })
                },
                reset: vi.fn()
            },
            onSessionFound: (id: string) => { sessionFoundId = id },
            onThinkingChange: (state: boolean) => { thinkingState = state },
            sendAgentMessage: (msg: unknown) => { agentMessages.push(msg) },
            sendSessionEvent: (event: unknown) => { sessionEvents.push(event) }
        },
        agentMessages,
        sessionEvents,
        getSessionFoundId: () => sessionFoundId,
        getThinkingState: () => thinkingState,
        pushMessage: (msg: { message: string; mode: { permissionMode: string; model?: string; thinkingLevel?: string }; isolate: boolean; hash: string }) => {
            waitResolve?.(msg)
        },
        triggerAbort: () => {
            waitResolve?.(null)
        }
    }
}

describe('PiLauncher', () => {
    beforeEach(() => {
        harness.piSessionMock = null
        harness.subscribeCallback = null
        harness.promptCalls = []
        harness.abortCalls = 0
        harness.disposeCalls = 0
        harness.thinkingLevelCalls = []
        harness.setModelCalls = []
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    describe('initialization', () => {
        it('creates pi session and subscribes to events', async () => {
            const { session } = createSessionStub()
            const launcher = new PiLauncher(session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            expect(harness.subscribeCallback).not.toBeNull()

            launcher.requestExit()
            await runPromise
        })

        it('reports session ID via onSessionFound', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(stub.getSessionFoundId()).toBe('pi-session-123'))

            launcher.requestExit()
            await runPromise
        })

        it('sends ready event after initialization', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(stub.sessionEvents).toContainEqual({ type: 'ready' }))

            launcher.requestExit()
            await runPromise
        })
    })

    describe('message processing', () => {
        it('calls prompt with message content', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            stub.pushMessage({
                message: 'Hello Pi',
                mode: { permissionMode: 'default' },
                isolate: false,
                hash: 'abc'
            })

            await vi.waitFor(() => expect(harness.promptCalls).toContain('Hello Pi'))

            launcher.requestExit()
            await runPromise
        })

        it('sets thinking state during prompt', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            stub.pushMessage({
                message: 'test',
                mode: { permissionMode: 'default' },
                isolate: false,
                hash: 'abc'
            })

            await vi.waitFor(() => expect(harness.promptCalls).toHaveLength(1))
            await vi.waitFor(() => expect(stub.sessionEvents.filter(e => (e as { type: string }).type === 'ready')).toHaveLength(2))

            launcher.requestExit()
            await runPromise
        })
    })

    describe('mode changes', () => {
        it('applies thinking level changes', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            stub.pushMessage({
                message: 'test',
                mode: { permissionMode: 'default', thinkingLevel: 'high' },
                isolate: false,
                hash: 'abc'
            })

            await vi.waitFor(() => expect(harness.thinkingLevelCalls).toContain('high'))

            launcher.requestExit()
            await runPromise
        })

        it('does not reapply same thinking level', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            stub.pushMessage({
                message: 'first',
                mode: { permissionMode: 'default', thinkingLevel: 'medium' },
                isolate: false,
                hash: 'a'
            })
            await vi.waitFor(() => expect(harness.promptCalls).toHaveLength(1))

            stub.pushMessage({
                message: 'second',
                mode: { permissionMode: 'default', thinkingLevel: 'medium' },
                isolate: false,
                hash: 'b'
            })
            await vi.waitFor(() => expect(harness.promptCalls).toHaveLength(2))

            expect(harness.thinkingLevelCalls).toHaveLength(1)

            launcher.requestExit()
            await runPromise
        })

        it('finds and sets model by provider/id', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            stub.pushMessage({
                message: 'test',
                mode: { permissionMode: 'default', model: 'openai/gpt-4o' },
                isolate: false,
                hash: 'abc'
            })

            await vi.waitFor(() => expect(harness.setModelCalls).toHaveLength(1))
            expect(harness.setModelCalls[0]).toEqual({ provider: 'openai', id: 'gpt-4o' })

            launcher.requestExit()
            await runPromise
        })

        it('defaults to anthropic provider when no slash in model', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            stub.pushMessage({
                message: 'test',
                mode: { permissionMode: 'default', model: 'claude-sonnet-4-20250514' },
                isolate: false,
                hash: 'abc'
            })

            await vi.waitFor(() => expect(harness.setModelCalls).toHaveLength(1))
            expect(harness.setModelCalls[0]).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-20250514' })

            launcher.requestExit()
            await runPromise
        })

        it('does not set model if not found in registry', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            stub.pushMessage({
                message: 'test',
                mode: { permissionMode: 'default', model: 'unknown/model' },
                isolate: false,
                hash: 'abc'
            })

            await vi.waitFor(() => expect(harness.promptCalls).toHaveLength(1))
            expect(harness.setModelCalls).toHaveLength(0)

            launcher.requestExit()
            await runPromise
        })
    })

    describe('abort', () => {
        it('aborts pi session and resets state', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            await launcher.abort()

            expect(harness.abortCalls).toBe(1)
            expect(stub.session.queue.reset).toHaveBeenCalled()

            launcher.requestExit()
            await runPromise
        })
    })

    describe('cleanup', () => {
        it('disposes pi session on exit', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.piSessionMock).not.toBeNull())

            launcher.requestExit()
            await runPromise

            expect(harness.disposeCalls).toBe(1)
        })

        it('unsubscribes from events on exit', async () => {
            const stub = createSessionStub()
            const launcher = new PiLauncher(stub.session as never)

            const runPromise = launcher.run()
            await vi.waitFor(() => expect(harness.subscribeCallback).not.toBeNull())

            launcher.requestExit()
            await runPromise

            expect(harness.subscribeCallback).toBeNull()
        })
    })
})
