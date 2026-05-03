import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import { ACTION_APPROVE, ACTION_DENY, parseCallbackData, findSessionByPrefix } from './renderer'
import { buildSystemReplyCard, sessionUrl } from './sessionView'
import type {
    EventMessageWith,
    TemplateCard,
    TemplateCardEventData,
    WsFrame
} from './types'

export interface CallbackCtx {
    syncEngine: SyncEngine
    store: Store
    publicUrl: string
    /**
     * Send an update_template_card reply for the given callback frame.
     *
     * The implementation must thread {@link frame}`.headers.req_id` onto the
     * outgoing frame — WeCom requires update replies to reuse the callback's
     * req_id (and to fire within 5 seconds). The SDK's `updateTemplateCard`
     * handles this transparently; the bot-side implementation delegates to it.
     */
    sendUpdate: (payload: {
        frame: WsFrame<EventMessageWith<TemplateCardEventData>>
        card: TemplateCard
        userids?: string[]
    }) => void
}

function findRequestByPrefix(session: Session, prefix: string): string | null {
    if (!prefix) return null
    const requests = session.agentState?.requests
    if (!requests) return null
    for (const id of Object.keys(requests)) {
        if (id.startsWith(prefix)) return id
    }
    return null
}

function reply(
    ctx: CallbackCtx,
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
    title: string,
    taskId?: string,
    sessionId?: string
): void {
    const url = sessionId ? sessionUrl(ctx.publicUrl, sessionId) : ctx.publicUrl
    const card = buildSystemReplyCard(title, url)
    // WeCom requires the update-card's template_card.task_id to match the
    // original card's task_id; otherwise the server silently discards the
    // response and the original card never gets replaced in the client.
    if (taskId) card.task_id = taskId
    ctx.sendUpdate({ frame, card })
}

export async function handleTemplateCardEvent(
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
    ctx: CallbackCtx
): Promise<void> {
    const event = frame.body?.event
    if (!event || event.eventtype !== 'template_card_event') return
    if (!frame.headers?.req_id) return

    // WeCom's live wire format nests click details under `event.template_card_event`.
    // Fall back to flat fields on the event itself for older payloads (and for
    // the shape the SDK's own .d.ts declares).
    const details =
        (event as { template_card_event?: { event_key?: string; task_id?: string } })
            .template_card_event ?? {}
    const rawKey = details.event_key ?? event.event_key ?? ''
    const taskId = details.task_id ?? event.task_id

    const userid = frame.body?.from?.userid
    const parsed = parseCallbackData(rawKey)
    if (parsed.action !== ACTION_APPROVE && parsed.action !== ACTION_DENY) {
        return
    }

    if (!userid) {
        reply(ctx, frame, 'Not bound', taskId)
        return
    }

    const user = ctx.store.users.getUser('wecom', userid)
    if (!user) {
        reply(ctx, frame, 'Not bound', taskId)
        return
    }

    const sessions = ctx.syncEngine.getSessionsByNamespace(user.namespace)
    const session = findSessionByPrefix(sessions, parsed.sessionPrefix)
    if (!session) {
        reply(ctx, frame, 'Session not found', taskId)
        return
    }
    if (!session.active) {
        reply(ctx, frame, 'Session inactive', taskId, session.id)
        return
    }
    const requestId = findRequestByPrefix(session, parsed.extra ?? '')
    if (!requestId) {
        reply(ctx, frame, 'Already processed', taskId, session.id)
        return
    }

    try {
        if (parsed.action === ACTION_APPROVE) {
            await ctx.syncEngine.approvePermission(session.id, requestId)
            reply(ctx, frame, 'Permission approved.', taskId, session.id)
        } else {
            await ctx.syncEngine.denyPermission(session.id, requestId)
            reply(ctx, frame, 'Permission denied.', taskId, session.id)
        }
    } catch (err) {
        console.error('[WecomBot] callback failed:', err)
        reply(ctx, frame, 'An error occurred', taskId, session.id)
    }
}
