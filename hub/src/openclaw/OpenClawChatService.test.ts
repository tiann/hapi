import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { DefaultOpenClawChatService } from './OpenClawChatService'
import type { OpenClawClient } from './client'
import type { SyncEvent } from '../sync/syncEngine'

function createClient(): OpenClawClient {
    return {
        async ensureDefaultConversation(input) {
            return {
                conversationId: `openclaw:${input.externalUserKey}`,
                title: 'OpenClaw'
            }
        },
        async sendMessage(input) {
            return {
                accepted: true,
                upstreamRequestId: `req:${input.idempotencyKey}`,
                upstreamConversationId: input.conversationId
            }
        },
        async approve(input) {
            return {
                accepted: true,
                upstreamRequestId: `approve:${input.idempotencyKey}`,
                upstreamConversationId: input.conversationId
            }
        },
        async deny(input) {
            return {
                accepted: true,
                upstreamRequestId: `deny:${input.idempotencyKey}`,
                upstreamConversationId: input.conversationId
            }
        }
    }
}

describe('DefaultOpenClawChatService', () => {
    it('stores a user message and command ack before assistant events arrive', async () => {
        const store = new Store(':memory:')
        const manager = new SSEManager(0, new VisibilityTracker())
        const service = new DefaultOpenClawChatService(store, manager, createClient())

        const conversation = await service.getOrCreateDefaultConversation({
            namespace: 'default',
            userKey: 'default:1'
        })

        const sent = await service.sendMessage({
            namespace: 'default',
            conversationId: conversation.id,
            userKey: 'default:1',
            text: 'hello'
        })

        expect(sent.role).toBe('user')

        const messagesAfterSend = await service.listMessages({
            namespace: 'default',
            userKey: 'default:1',
            conversationId: conversation.id,
            limit: 50
        })
        expect(messagesAfterSend.messages).toHaveLength(1)
        expect(messagesAfterSend.messages[0]?.role).toBe('user')
        expect(messagesAfterSend.messages[0]?.status).toBe('completed')

        const command = store.openclawCommands.getLatestCommand('default', conversation.id)
        expect(command?.status).toBe('accepted')
        expect(command?.localMessageId).toBe(sent.id)

        await service.ingestInboundEvent({
            type: 'message',
            eventId: 'evt-1',
            occurredAt: 1,
            namespace: 'default',
            conversationId: conversation.id,
            externalMessageId: 'ext-1',
            role: 'assistant',
            content: { mode: 'replace', text: 'world' },
            status: 'completed'
        })

        const messagesAfterEvent = await service.listMessages({
            namespace: 'default',
            userKey: 'default:1',
            conversationId: conversation.id,
            limit: 50
        })
        expect(messagesAfterEvent.messages).toHaveLength(2)
        expect(messagesAfterEvent.messages[1]?.role).toBe('assistant')
        expect(messagesAfterEvent.messages[1]?.text).toBe('world')
    })

    it('rebinds an existing default conversation to the ensured upstream session key', async () => {
        const store = new Store(':memory:')
        const manager = new SSEManager(0, new VisibilityTracker())
        let lastSentConversationId: string | null = null
        const service = new DefaultOpenClawChatService(store, manager, {
            ...createClient(),
            async sendMessage(input) {
                lastSentConversationId = input.conversationId
                return {
                    accepted: true,
                    upstreamRequestId: `req:${input.idempotencyKey}`,
                    upstreamConversationId: input.conversationId
                }
            }
        })

        const existing = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'legacy-thread-1',
            title: 'Legacy title'
        })

        const conversation = await service.getOrCreateDefaultConversation({
            namespace: 'default',
            userKey: 'default:1'
        })

        expect(conversation.id).toBe(existing.id)

        const rebound = store.openclawConversations.getConversationByNamespace(existing.id, 'default')
        expect(rebound?.externalId).toBe('openclaw:default:1')
        expect(rebound?.title).toBe('OpenClaw')

        await service.sendMessage({
            namespace: 'default',
            conversationId: conversation.id,
            userKey: 'default:1',
            text: 'hello'
        })

        expect(lastSentConversationId).not.toBeNull()
        expect(lastSentConversationId!).toBe('openclaw:default:1')
    })

    it('persists inbound state updates so refetch returns the same values', async () => {
        const store = new Store(':memory:')
        const manager = new SSEManager(0, new VisibilityTracker())
        const events: SyncEvent[] = []

        manager.subscribe({
            id: 'openclaw',
            namespace: 'default',
            openclawConversationId: 'placeholder',
            send: (event) => {
                events.push(event)
            },
            sendHeartbeat: () => {}
        })

        const service = new DefaultOpenClawChatService(store, manager, createClient())
        const conversation = await service.getOrCreateDefaultConversation({
            namespace: 'default',
            userKey: 'default:1'
        })

        manager.unsubscribe('openclaw')
        manager.subscribe({
            id: 'openclaw',
            namespace: 'default',
            openclawConversationId: conversation.id,
            send: (event) => {
                events.push(event)
            },
            sendHeartbeat: () => {}
        })

        await service.ingestInboundEvent({
            type: 'state',
            eventId: 'evt-state-1',
            occurredAt: 1,
            namespace: 'default',
            conversationId: conversation.id,
            connected: false,
            thinking: true,
            lastError: 'upstream offline'
        })

        const state = await service.getState({
            namespace: 'default',
            userKey: 'default:1',
            conversationId: conversation.id
        })

        expect(state.connected).toBe(false)
        expect(state.thinking).toBe(true)
        expect(state.lastError).toBe('upstream offline')

        const stateEvent = events.find((event): event is Extract<SyncEvent, { type: 'openclaw-state' }> => event.type === 'openclaw-state')
        expect(stateEvent?.state.connected).toBe(false)
        expect(stateEvent?.state.thinking).toBe(true)
        expect(stateEvent?.state.lastError).toBe('upstream offline')
    })

    it('rejects access to another user conversation', async () => {
        const store = new Store(':memory:')
        const manager = new SSEManager(0, new VisibilityTracker())
        const service = new DefaultOpenClawChatService(store, manager, createClient())

        const conversation = await service.getOrCreateDefaultConversation({
            namespace: 'default',
            userKey: 'default:1'
        })

        expect(await service.verifyConversationAccess({
            namespace: 'default',
            userKey: 'default:2',
            conversationId: conversation.id
        })).toBe(false)

        await expect(service.getState({
            namespace: 'default',
            userKey: 'default:2',
            conversationId: conversation.id
        })).rejects.toThrow('Conversation not found')
    })

    it('keeps approvals pending when upstream approve fails', async () => {
        const store = new Store(':memory:')
        const manager = new SSEManager(0, new VisibilityTracker())
        const service = new DefaultOpenClawChatService(store, manager, {
            ...createClient(),
            async approve() {
                throw new Error('upstream failed')
            }
        })

        const conversation = await service.getOrCreateDefaultConversation({
            namespace: 'default',
            userKey: 'default:1'
        })

        store.openclawApprovals.upsertApproval({
            id: 'req-1',
            conversationId: conversation.id,
            namespace: 'default',
            title: 'Approve action'
        })

        await expect(service.approve({
            namespace: 'default',
            userKey: 'default:1',
            conversationId: conversation.id,
            requestId: 'req-1'
        })).rejects.toThrow('upstream failed')

        const state = await service.getState({
            namespace: 'default',
            userKey: 'default:1',
            conversationId: conversation.id
        })
        expect(state.pendingApprovals ?? []).toHaveLength(1)
        expect(state.pendingApprovals?.[0]?.id).toBe('req-1')

        const command = store.openclawCommands.getLatestCommand('default', conversation.id)
        expect(command?.status).toBe('failed')
        expect(command?.approvalRequestId).toBe('req-1')
    })

    it('keeps a failed user message visible when upstream send rejects', async () => {
        const store = new Store(':memory:')
        const manager = new SSEManager(0, new VisibilityTracker())
        const service = new DefaultOpenClawChatService(store, manager, {
            ...createClient(),
            async sendMessage() {
                throw new Error('upstream busy')
            }
        })

        const conversation = await service.getOrCreateDefaultConversation({
            namespace: 'default',
            userKey: 'default:1'
        })

        await expect(service.sendMessage({
            namespace: 'default',
            conversationId: conversation.id,
            userKey: 'default:1',
            text: 'hello'
        })).rejects.toThrow('upstream busy')

        const messages = await service.listMessages({
            namespace: 'default',
            userKey: 'default:1',
            conversationId: conversation.id,
            limit: 50
        })
        expect(messages.messages).toHaveLength(1)
        expect(messages.messages[0]?.role).toBe('user')
        expect(messages.messages[0]?.text).toBe('hello')
        expect(messages.messages[0]?.status).toBe('failed')

        const command = store.openclawCommands.getLatestCommand('default', conversation.id)
        expect(command?.status).toBe('failed')

        const state = await service.getState({
            namespace: 'default',
            userKey: 'default:1',
            conversationId: conversation.id
        })
        expect(state.lastError).toBe('upstream busy')
    })
})
