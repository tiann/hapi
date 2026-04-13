import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('OpenClaw store', () => {
    it('creates a per-user conversation and stores messages and approvals', () => {
        const store = new Store(':memory:')

        const conversation = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'openclaw:default:1',
            title: 'OpenClaw'
        })

        expect(conversation.namespace).toBe('default')
        expect(conversation.userKey).toBe('default:1')

        const userMessage = store.openclawMessages.addMessage({
            conversationId: conversation.id,
            namespace: 'default',
            role: 'user',
            text: 'hello'
        })
        const assistantMessage = store.openclawMessages.addMessage({
            conversationId: conversation.id,
            namespace: 'default',
            role: 'assistant',
            text: 'world'
        })

        const messages = store.openclawMessages.getMessages('default', conversation.id)
        expect(messages.map((message) => message.id)).toEqual([userMessage.id, assistantMessage.id])

        const approval = store.openclawApprovals.upsertApproval({
            id: 'req-1',
            conversationId: conversation.id,
            namespace: 'default',
            title: 'Approve action',
            description: 'Need approval'
        })

        expect(approval.status).toBe('pending')
        expect(store.openclawApprovals.listPending('default', conversation.id)).toHaveLength(1)

        const resolved = store.openclawApprovals.resolve('default', conversation.id, 'req-1', 'approved')
        expect(resolved?.status).toBe('approved')
        expect(store.openclawApprovals.listPending('default', conversation.id)).toHaveLength(0)
    })

    it('persists conversation state fields', () => {
        const store = new Store(':memory:')

        const conversation = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'openclaw:default:1',
            title: 'OpenClaw'
        })

        expect(conversation.connected).toBe(true)
        expect(conversation.thinking).toBe(false)
        expect(conversation.lastError).toBeNull()

        const updated = store.openclawConversations.updateConversation(conversation.id, 'default', {
            connected: false,
            thinking: true,
            lastError: 'socket lost'
        })

        expect(updated?.connected).toBe(false)
        expect(updated?.thinking).toBe(true)
        expect(updated?.lastError).toBe('socket lost')
    })

    it('rebinds an existing conversation to a new external id', () => {
        const store = new Store(':memory:')

        const conversation = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'legacy-thread-1',
            title: 'Old title'
        })

        const rebound = store.openclawConversations.rebindConversation(
            conversation.id,
            'default',
            'agent:main:hapi-openclaw:default:default%3A1',
            'OpenClaw'
        )

        expect(rebound?.id).toBe(conversation.id)
        expect(rebound?.externalId).toBe('agent:main:hapi-openclaw:default:default%3A1')
        expect(rebound?.title).toBe('OpenClaw')
    })

    it('updates a message when a later chunk reuses the external id', () => {
        const store = new Store(':memory:')

        const conversation = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'openclaw:default:1',
            title: 'OpenClaw'
        })

        const first = store.openclawMessages.addMessage({
            conversationId: conversation.id,
            namespace: 'default',
            externalId: 'ext-1',
            role: 'assistant',
            text: 'partial',
            status: 'streaming'
        })

        const second = store.openclawMessages.addMessage({
            conversationId: conversation.id,
            namespace: 'default',
            externalId: 'ext-1',
            role: 'assistant',
            text: 'final answer',
            status: 'completed'
        })

        expect(second.id).toBe(first.id)
        expect(second.seq).toBe(first.seq)
        expect(second.text).toBe('final answer')
        expect(second.status).toBe('completed')

        const messages = store.openclawMessages.getMessages('default', conversation.id)
        expect(messages).toHaveLength(1)
        expect(messages[0]?.text).toBe('final answer')
        expect(messages[0]?.status).toBe('completed')
    })

    it('updates a stored message status in place', () => {
        const store = new Store(':memory:')

        const conversation = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'openclaw:default:1',
            title: 'OpenClaw'
        })

        const message = store.openclawMessages.addMessage({
            conversationId: conversation.id,
            namespace: 'default',
            role: 'user',
            text: 'hello',
            status: 'failed'
        })

        const updated = store.openclawMessages.updateStatus('default', message.id, 'completed')

        expect(updated?.id).toBe(message.id)
        expect(updated?.status).toBe('completed')
        expect(store.openclawMessages.getMessages('default', conversation.id)[0]?.status).toBe('completed')
    })

    it('appends delta chunks to one logical assistant message row', () => {
        const store = new Store(':memory:')

        const conversation = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'openclaw:default:1',
            title: 'OpenClaw'
        })

        const first = store.openclawMessages.appendOrReplaceMessageContent({
            conversationId: conversation.id,
            namespace: 'default',
            externalId: 'ext-2',
            role: 'assistant',
            content: { mode: 'replace', text: 'hel' },
            status: 'streaming'
        })

        const second = store.openclawMessages.appendOrReplaceMessageContent({
            conversationId: conversation.id,
            namespace: 'default',
            externalId: 'ext-2',
            role: 'assistant',
            content: { mode: 'append', delta: 'lo' },
            status: 'completed'
        })

        expect(second.id).toBe(first.id)
        expect(second.text).toBe('hello')
        expect(second.status).toBe('completed')
    })

    it('stores command and receipt ledgers', () => {
        const store = new Store(':memory:')

        const conversation = store.openclawConversations.getOrCreateConversation('default', 'default:1', {
            externalId: 'openclaw:default:1',
            title: 'OpenClaw'
        })

        const command = store.openclawCommands.createCommand({
            namespace: 'default',
            conversationId: conversation.id,
            type: 'send-message',
            localMessageId: 'msg-1',
            idempotencyKey: 'idem-1',
            upstreamConversationId: conversation.externalId
        })

        expect(command.status).toBe('queued')
        expect(store.openclawCommands.getCommandByIdempotencyKey('default', 'idem-1')?.id).toBe(command.id)

        const accepted = store.openclawCommands.markAccepted({
            id: command.id,
            namespace: 'default',
            upstreamRequestId: 'req-1'
        })
        expect(accepted?.status).toBe('accepted')
        expect(accepted?.upstreamRequestId).toBe('req-1')

        const receipt = store.openclawReceipts.recordReceipt({
            namespace: 'default',
            eventId: 'evt-1',
            upstreamConversationId: conversation.externalId,
            eventType: 'message'
        })
        expect(receipt.processedAt).toBeNull()
        expect(store.openclawReceipts.hasProcessedReceipt('default', 'evt-1')).toBe(false)

        const processed = store.openclawReceipts.markProcessed('default', 'evt-1')
        expect(processed?.processedAt).not.toBeNull()
        expect(store.openclawReceipts.hasProcessedReceipt('default', 'evt-1')).toBe(true)
    })
})
