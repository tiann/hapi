import { randomUUID } from 'node:crypto'

import type {
    HapiCallbackEvent,
    OpenClawAdapterRuntime,
    PluginRuntimeApproveAction,
    PluginRuntimeDenyAction,
    PluginRuntimeSendMessageAction
} from './types'

export class MockOpenClawRuntime implements OpenClawAdapterRuntime {
    readonly supportsApprovals = true

    constructor(private readonly namespace: string) {}

    async ensureDefaultConversation(externalUserKey: string): Promise<{ conversationId: string; title: string }> {
        return {
            conversationId: `openclaw-plugin:${externalUserKey}`,
            title: 'OpenClaw'
        }
    }

    async sendMessage(action: PluginRuntimeSendMessageAction): Promise<HapiCallbackEvent[]> {
        return await this.sendMessageReserved(action)
    }

    async sendMessageReserved(action: PluginRuntimeSendMessageAction): Promise<HapiCallbackEvent[]> {
        const now = Date.now()

        if (action.text.toLowerCase().includes('approval')) {
            const requestId = `approval:${randomUUID()}`
            return [
                {
                    type: 'state',
                    eventId: randomUUID(),
                    occurredAt: now,
                    namespace: this.namespace,
                    conversationId: action.conversationId,
                    connected: true,
                    thinking: true,
                    lastError: null
                },
                {
                    type: 'approval-request',
                    eventId: randomUUID(),
                    occurredAt: now + 1,
                    namespace: this.namespace,
                    conversationId: action.conversationId,
                    requestId,
                    title: 'Approve OpenClaw action',
                    description: action.text,
                    createdAt: now + 1
                },
                {
                    type: 'state',
                    eventId: randomUUID(),
                    occurredAt: now + 2,
                    namespace: this.namespace,
                    conversationId: action.conversationId,
                    connected: true,
                    thinking: false,
                    lastError: null
                }
            ]
        }

        const externalMessageId = `assistant:${randomUUID()}`
        return [
            {
                type: 'state',
                eventId: randomUUID(),
                occurredAt: now,
                namespace: this.namespace,
                conversationId: action.conversationId,
                connected: true,
                thinking: true,
                lastError: null
            },
            {
                type: 'message',
                eventId: randomUUID(),
                occurredAt: now + 1,
                namespace: this.namespace,
                conversationId: action.conversationId,
                externalMessageId,
                role: 'assistant',
                content: { mode: 'replace', text: 'OpenClaw plugin echo: ' },
                createdAt: now + 1,
                status: 'streaming'
            },
            {
                type: 'message',
                eventId: randomUUID(),
                occurredAt: now + 2,
                namespace: this.namespace,
                conversationId: action.conversationId,
                externalMessageId,
                role: 'assistant',
                content: { mode: 'append', delta: action.text.trim() || '(empty message)' },
                createdAt: now + 2,
                status: 'completed'
            },
            {
                type: 'state',
                eventId: randomUUID(),
                occurredAt: now + 3,
                namespace: this.namespace,
                conversationId: action.conversationId,
                connected: true,
                thinking: false,
                lastError: null
            }
        ]
    }

    async approve(action: PluginRuntimeApproveAction): Promise<HapiCallbackEvent[]> {
        const now = Date.now()

        return [{
            type: 'approval-resolved',
            eventId: randomUUID(),
            occurredAt: now,
            namespace: this.namespace,
            conversationId: action.conversationId,
            requestId: action.requestId,
            status: 'approved'
        }]
    }

    async deny(action: PluginRuntimeDenyAction): Promise<HapiCallbackEvent[]> {
        const now = Date.now()

        return [{
            type: 'approval-resolved',
            eventId: randomUUID(),
            occurredAt: now,
            namespace: this.namespace,
            conversationId: action.conversationId,
            requestId: action.requestId,
            status: 'denied'
        }]
    }
}
