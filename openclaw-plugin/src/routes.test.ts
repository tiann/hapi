import { describe, expect, it } from 'bun:test'
import { createPluginApp } from './routes'
import { HapiCallbackClient } from './hapiClient'
import { MockOpenClawRuntime } from './openclawRuntime'
import { adapterState } from './adapterState'
import type { HapiCallbackEvent, OpenClawAdapterRuntime, PluginCommandAck } from './types'

function createLogger() {
    return {
        infoMessages: [] as string[],
        warnMessages: [] as string[],
        errorMessages: [] as string[],
        info(message: string) {
            this.infoMessages.push(message)
        },
        warn(message: string) {
            this.warnMessages.push(message)
        },
        error(message: string) {
            this.errorMessages.push(message)
        }
    }
}

class StubCallbackClient extends HapiCallbackClient {
    events: unknown[] = []

    constructor() {
        super('http://127.0.0.1:3006', 'shared-secret')
    }

    override async postEvent(event: HapiCallbackEvent): Promise<void> {
        this.events.push(event)
    }
}

class FailingCallbackClient extends HapiCallbackClient {
    constructor(private readonly errorMessage: string) {
        super('http://127.0.0.1:3006', 'shared-secret')
    }

    override async postEvent(_event: HapiCallbackEvent): Promise<void> {
        throw new Error(this.errorMessage)
    }
}

class RetryableCallbackClient extends HapiCallbackClient {
    attempts = 0
    events: HapiCallbackEvent[] = []

    constructor(private readonly failuresBeforeSuccess: number) {
        super('http://127.0.0.1:3006', 'shared-secret')
    }

    override async postEvent(event: HapiCallbackEvent): Promise<void> {
        this.attempts += 1
        if (this.attempts <= this.failuresBeforeSuccess) {
            throw new Error(`retryable failure ${this.attempts}`)
        }
        this.events.push(event)
    }
}

async function flushTimers(turns: number = 1): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
}

function createApp(
    runtime: OpenClawAdapterRuntime = new MockOpenClawRuntime('default'),
    options: {
        callbackClient?: HapiCallbackClient
        idempotencyCache?: Map<string, PluginCommandAck>
        idempotencyTtlMs?: number
        callbackRetryBaseDelayMs?: number
    } = {}
) {
    const callbackClient = options.callbackClient ?? new StubCallbackClient()
    const idempotencyCache = options.idempotencyCache ?? new Map()
    const logger = createLogger()
    const app = createPluginApp({
        sharedSecret: 'plugin-secret',
        namespace: 'default',
        callbackClient,
        runtime,
        idempotencyCache,
        idempotencyTtlMs: options.idempotencyTtlMs,
        callbackRetryBaseDelayMs: options.callbackRetryBaseDelayMs,
        prototypeCaptureSessionKey: null,
        prototypeCaptureFileName: 'transcript-capture.jsonl',
        logger
    })
    return { app, callbackClient, idempotencyCache, logger }
}

class BusyRuntime implements OpenClawAdapterRuntime {
    readonly supportsApprovals = false

    async ensureDefaultConversation(): Promise<{ conversationId: string; title: string }> {
        return { conversationId: 'thread-1', title: 'OpenClaw' }
    }

    isConversationBusy(): boolean {
        return true
    }

    async sendMessage(): Promise<void> {
        throw new Error('sendMessage should not be called when busy')
    }

    async sendMessageReserved(): Promise<void> {
        throw new Error('sendMessageReserved should not be called when busy')
    }

    async approve(): Promise<void> {
        throw new Error('approve should not be called')
    }

    async deny(): Promise<void> {
        throw new Error('deny should not be called')
    }
}

class ApprovalRuntime implements OpenClawAdapterRuntime {
    readonly supportsApprovals = true

    constructor(
        private readonly mode: 'ok' | 'fail-approve' | 'fail-deny' = 'ok'
    ) {}

    async ensureDefaultConversation(): Promise<{ conversationId: string; title: string }> {
        return { conversationId: 'thread-1', title: 'OpenClaw' }
    }

    async sendMessage(): Promise<void> {
        throw new Error('sendMessage should not be called')
    }

    async sendMessageReserved(): Promise<void> {
        throw new Error('sendMessageReserved should not be called')
    }

    async approve(): Promise<[{ type: 'approval-resolved'; eventId: string; occurredAt: number; namespace: string; conversationId: string; requestId: string; status: 'approved' }]> {
        if (this.mode === 'fail-approve') {
            throw new Error('approve failed')
        }
        return [{
            type: 'approval-resolved',
            eventId: 'evt-approve',
            occurredAt: 1,
            namespace: 'default',
            conversationId: 'thread-1',
            requestId: 'request-1',
            status: 'approved'
        }]
    }

    async deny(): Promise<[{ type: 'approval-resolved'; eventId: string; occurredAt: number; namespace: string; conversationId: string; requestId: string; status: 'denied' }]> {
        if (this.mode === 'fail-deny') {
            throw new Error('deny failed')
        }
        return [{
            type: 'approval-resolved',
            eventId: 'evt-deny',
            occurredAt: 1,
            namespace: 'default',
            conversationId: 'thread-1',
            requestId: 'request-1',
            status: 'denied'
        }]
    }
}

describe('openclaw plugin routes', () => {
    it('rejects a second same-conversation send before the worker starts', async () => {
        adapterState.resetForTests()

        let releaseRun: () => void = () => {}
        let reservedCalls = 0
        class ReservingRuntime extends MockOpenClawRuntime {
            override async sendMessageReserved(action: Parameters<MockOpenClawRuntime['sendMessageReserved']>[0]) {
                reservedCalls += 1
                await new Promise<void>((resolve) => {
                    releaseRun = resolve
                })
                return await super.sendMessageReserved(action)
            }
        }

        const { app } = createApp(new ReservingRuntime('default'))
        const firstRequest = app.request('/hapi/channel/messages', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-race-1'
            },
            body: JSON.stringify({
                conversationId: 'thread-1',
                text: 'hello',
                localMessageId: 'msg-1'
            })
        })

        const secondResponse = await app.request('/hapi/channel/messages', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-race-2'
            },
            body: JSON.stringify({
                conversationId: 'thread-1',
                text: 'hello again',
                localMessageId: 'msg-2'
            })
        })

        const firstResponse = await firstRequest
        expect(firstResponse.status).toBe(200)
        expect(secondResponse.status).toBe(409)
        expect(await secondResponse.json()).toEqual({
            error: 'Conversation already has an active OpenClaw run',
            retryAfterMs: 1000
        })
        expect(reservedCalls).toBe(1)

        releaseRun()
        await flushTimers()
        adapterState.resetForTests()
    })

    it('rejects unauthorized command requests', async () => {
        const { app } = createApp()
        const response = await app.request('/hapi/channel/messages', { method: 'POST' })
        expect(response.status).toBe(401)
    })

    it('reports prototype capture status from health', async () => {
        const { app } = createApp()
        const response = await app.request('/hapi/health')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            pluginVersion: '0.1.0',
            openclawConnected: true,
            prototypeCapture: {
                enabled: false,
                sessionKey: null,
                fileName: 'transcript-capture.jsonl'
            }
        })
    })

    it('does not expose the legacy non-/hapi routes', async () => {
        const { app } = createApp()
        const response = await app.request('/channel/messages', { method: 'POST' })
        expect(response.status).toBe(404)
    })

    it('returns idempotent acknowledgements for repeated send-message calls', async () => {
        const { app, callbackClient } = createApp()
        const init = {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-1'
            },
            body: JSON.stringify({
                conversationId: 'thread-1',
                text: 'hello',
                localMessageId: 'msg-1'
            })
        }

        const first = await app.request('/hapi/channel/messages', init)
        const firstJson = await first.json() as { upstreamRequestId: string }
        const second = await app.request('/hapi/channel/messages', init)
        const secondJson = await second.json() as { upstreamRequestId: string }

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(secondJson.upstreamRequestId).toBe(firstJson.upstreamRequestId)

        await flushTimers()
        expect((callbackClient as StubCallbackClient).events.length).toBeGreaterThan(0)
    })

    it('creates approval-request events when message text contains approval', async () => {
        const { app, callbackClient } = createApp()
        await app.request('/hapi/channel/messages', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-approval-1'
            },
            body: JSON.stringify({
                conversationId: 'thread-1',
                text: 'please ask for approval',
                localMessageId: 'msg-1'
            })
        })

        await flushTimers()
        expect((callbackClient as StubCallbackClient).events.some((event) => {
            return typeof event === 'object'
                && event !== null
                && 'type' in event
                && event.type === 'approval-request'
        })).toBe(true)
    })

    it('rejects send-message when the conversation already has an active run', async () => {
        const { app } = createApp(new BusyRuntime())
        const response = await app.request('/hapi/channel/messages', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-busy-1'
            },
            body: JSON.stringify({
                conversationId: 'thread-1',
                text: 'hello',
                localMessageId: 'msg-1'
            })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Conversation already has an active OpenClaw run',
            retryAfterMs: 1000
        })
    })

    it('returns 501 for approval endpoints when real approval bridge is not implemented', async () => {
        const { app } = createApp(new BusyRuntime())

        const approveResponse = await app.request('/hapi/channel/approvals/request-1/approve', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-approve-1'
            },
            body: JSON.stringify({
                conversationId: 'thread-1'
            })
        })

        const denyResponse = await app.request('/hapi/channel/approvals/request-1/deny', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-deny-1'
            },
            body: JSON.stringify({
                conversationId: 'thread-1'
            })
        })

        expect(approveResponse.status).toBe(501)
        expect(await approveResponse.json()).toEqual({
            error: 'OpenClaw approval bridge is not implemented yet'
        })
        expect(denyResponse.status).toBe(501)
        expect(await denyResponse.json()).toEqual({
            error: 'OpenClaw approval bridge is not implemented yet'
        })
    })

    it('logs and clears idempotency cache when approve runtime fails', async () => {
        const idempotencyCache = new Map()
        const { app, logger } = createApp(new ApprovalRuntime('fail-approve'), { idempotencyCache })

        const response = await app.request('/hapi/channel/approvals/request-1/approve', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-approve-fail'
            },
            body: JSON.stringify({
                conversationId: 'thread-1'
            })
        })

        expect(response.status).toBe(200)

        await flushTimers()
        expect(idempotencyCache.has('idem-approve-fail')).toBe(false)
        expect(logger.errorMessages.some((message) => message.includes('approve task failed'))).toBe(true)
    })

    it('retries approve callbacks before giving up', async () => {
        const callbackClient = new RetryableCallbackClient(2)
        const { app, logger } = createApp(new ApprovalRuntime(), {
            callbackClient,
            callbackRetryBaseDelayMs: 0
        })

        const response = await app.request('/hapi/channel/approvals/request-1/approve', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-approve-retry'
            },
            body: JSON.stringify({
                conversationId: 'thread-1'
            })
        })

        expect(response.status).toBe(200)

        await flushTimers(4)
        expect(callbackClient.attempts).toBe(3)
        expect(callbackClient.events).toHaveLength(1)
        expect(logger.errorMessages.some((message) => message.includes('approve callback failed'))).toBe(false)
    })

    it('logs callback failures without clearing idempotency cache after approve succeeds', async () => {
        const idempotencyCache = new Map()
        const { app, logger } = createApp(new ApprovalRuntime(), {
            idempotencyCache,
            callbackClient: new FailingCallbackClient('callback offline'),
            callbackRetryBaseDelayMs: 0
        })

        const response = await app.request('/hapi/channel/approvals/request-1/approve', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-approve-callback'
            },
            body: JSON.stringify({
                conversationId: 'thread-1'
            })
        })

        expect(response.status).toBe(200)

        await flushTimers(4)
        expect(idempotencyCache.has('idem-approve-callback')).toBe(true)
        expect(logger.errorMessages.some((message) => message.includes('approve callback failed'))).toBe(true)
    })

    it('logs and clears idempotency cache when deny runtime fails', async () => {
        const idempotencyCache = new Map()
        const { app, logger } = createApp(new ApprovalRuntime('fail-deny'), { idempotencyCache })

        const response = await app.request('/hapi/channel/approvals/request-1/deny', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-deny-fail'
            },
            body: JSON.stringify({
                conversationId: 'thread-1'
            })
        })

        expect(response.status).toBe(200)

        await flushTimers()
        expect(idempotencyCache.has('idem-deny-fail')).toBe(false)
        expect(logger.errorMessages.some((message) => message.includes('deny task failed'))).toBe(true)
    })

    it('evicts remembered send-message acknowledgements after the TTL', async () => {
        const idempotencyCache = new Map()
        const { app } = createApp(new MockOpenClawRuntime('default'), {
            idempotencyCache,
            idempotencyTtlMs: 1
        })

        const response = await app.request('/hapi/channel/messages', {
            method: 'POST',
            headers: {
                authorization: 'Bearer plugin-secret',
                'content-type': 'application/json',
                'idempotency-key': 'idem-ttl-1'
            },
            body: JSON.stringify({
                conversationId: 'thread-1',
                text: 'hello',
                localMessageId: 'msg-1'
            })
        })

        expect(response.status).toBe(200)
        expect(idempotencyCache.has('idem-ttl-1')).toBe(true)

        await flushTimers(3)
        expect(idempotencyCache.has('idem-ttl-1')).toBe(false)
    })
})
