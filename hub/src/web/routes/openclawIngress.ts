import { Hono } from 'hono'
import { getOpenClawTransportSettings } from '../../openclaw/config'
import { parseOfficialOpenClawEvent, verifyOfficialOpenClawSignature } from '../../openclaw/protocol'
import type { OpenClawChatService } from '../../openclaw/types'
import type { Store } from '../../store'

export function createOpenClawIngressRoutes(
    getService: () => OpenClawChatService | null,
    getStore: () => Store | null
): Hono {
    const app = new Hono()

    app.post('/openclaw/channel/events', async (c) => {
        const service = getService()
        const store = getStore()
        if (!service || !store) {
            return c.json({ error: 'OpenClaw service unavailable' }, 503)
        }

        const config = getOpenClawTransportSettings()
        const rawBody = await c.req.text().catch(() => '')
        if (!rawBody) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        let event
        try {
            if (!config.sharedSecret) {
                return c.json({ error: 'OpenClaw shared secret not configured' }, 503)
            }

            const verification = verifyOfficialOpenClawSignature({
                headers: c.req.raw.headers,
                rawBody,
                signingSecret: config.sharedSecret,
                now: Date.now(),
                allowedTimestampSkewMs: config.allowedTimestampSkewMs
            })
            if (!verification.ok) {
                return c.json({ error: verification.reason }, 401)
            }

            event = parseOfficialOpenClawEvent({
                rawBody,
                namespaceResolver: (conversationId) => {
                    const record = store.openclawConversations.findConversationByExternalId(conversationId)
                    return record?.namespace ?? null
                }
            })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Invalid body' }, 400)
        }

        const existingReceipt = store.openclawReceipts.getReceipt(event.namespace, event.eventId)
        if (existingReceipt?.processedAt) {
            return c.json({ ok: true, duplicate: true })
        }

        store.openclawReceipts.recordReceipt({
            namespace: event.namespace,
            eventId: event.eventId,
            upstreamConversationId: event.conversationId,
            eventType: event.type
        })

        await service.ingestInboundEvent(event)
        store.openclawReceipts.markProcessed(event.namespace, event.eventId)
        return c.json({ ok: true })
    })

    return app
}
