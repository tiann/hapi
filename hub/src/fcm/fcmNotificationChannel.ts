import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import { formatToolArgumentsCompact, formatToolArgumentsDetailed } from '../notifications/toolArgs'
import { extractAssistantPlainText, extractNotifySummary, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Store } from '../store'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { FcmSendPayload, FcmService } from './fcmService'

const CONTRACT_VERSION = '1'

/**
 * `ready` body content limit for the wrist-glance line on the watch.
 * BigTextStyle still expands when the operator taps, so this cap only
 * affects the collapsed glance. ~280 chars matches the watch's three-line
 * collapsed render at default font scale.
 */
const READY_BODY_GLANCE_LIMIT = 280

export class FcmNotificationChannel implements NotificationChannel {
    constructor(
        private readonly fcmService: FcmService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        private readonly store?: Store
    ) {}

    async sendPermissionRequest(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const agentName = getAgentName(session)
        const requests = session.agentState?.requests ?? null
        const requestEntries = requests ? Object.entries(requests) : []
        const [requestId, request] = requestEntries[0] ?? [undefined, null]

        // Glance line: keep brutally short so the wrist-collapsed
        // notification still shows the first ~40 chars without truncation.
        // Format: "<agent> <tool>: <one-liner-arg>" e.g. "Claude Edit: .../hub/server.ts"
        // Fallback when args aren't useful: "<agent> <tool>" e.g. "Cursor Bash"
        const toolName = request?.tool ?? ''
        const compact = request ? formatToolArgumentsCompact(request.tool, request.arguments) : ''
        const glance = toolName
            ? (compact ? `${agentName} ${toolName}: ${compact}` : `${agentName} ${toolName}`)
            : `${agentName} - ${name}`

        // Detailed body: rendered when the operator taps the notification on
        // Wear OS (BigTextStyle on the watch side). Lines after the first
        // are hidden in the collapsed glance, so we can be generous here.
        const detailed = request
            ? formatToolArgumentsDetailed(request.tool, request.arguments, { maxArgLength: 120 })
            : ''
        const bodyLines = [glance]
        if (name && name !== glance) {
            bodyLines.push(`Session: ${name}`)
        }
        if (detailed) {
            bodyLines.push(detailed)
        }

        const path = this.buildSessionPath(session.id)

        const payload = this.buildPayload({
            title: 'Permission Request',
            body: bodyLines.join('\n'),
            tag: `permission-${session.id}`,
            type: 'permission-request',
            sessionId: session.id,
            sessionName: name,
            url: path,
            requestId,
            severity: 'warning'
        })

        await this.deliver(session, payload, ctx)
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const path = this.buildSessionPath(session.id)

        const composed = this.composeReadyBody(session, agentName, name)

        const payload = this.buildPayload({
            title: composed.title,
            body: composed.body,
            tag: `ready-${session.id}`,
            type: 'ready',
            sessionId: session.id,
            sessionName: name,
            url: path,
            severity: 'info'
        })

        if (composed.notifySummary) {
            payload.data.notifySummary = JSON.stringify(composed.notifySummary)
        }

        await this.deliver(session, payload, ctx)
    }

    /**
     * Build the title/body for a `ready` notification.
     *
     * Strategy:
     *  1. If the operator's `AGENTS.md` has the agent emit
     *     `AGENT_NOTIFY_SUMMARY {...json...}` as the trailing line, parse it
     *     and use `summary` (+ `action` on a second line) for the body.
     *     Title becomes `<agent> - <session>` so the summary text owns the
     *     body.
     *  2. Otherwise fall back to the first ~280 chars of the most recent
     *     assistant text. Same title pattern.
     *  3. If no assistant text can be found at all (cold start, store
     *     unavailable, all recent messages are tool calls), fall back to
     *     the previous "<agent> is waiting in <session>" content so we
     *     never regress to a worse notification than today.
     */
    private composeReadyBody(
        session: Session,
        agentName: string,
        sessionName: string
    ): { title: string; body: string; notifySummary?: Record<string, unknown> } {
        const fallback = {
            title: 'Ready for input',
            body: `${agentName} is waiting in ${sessionName}`
        }

        if (!this.store) return fallback

        const lastText = this.findLastAssistantPlainText(session.id)
        if (!lastText) return fallback

        const summary = extractNotifySummary(lastText)
        const headerTitle = `${agentName} - ${sessionName}`

        if (summary?.summary) {
            const summaryLine = this.truncateReadyText(summary.summary, READY_BODY_GLANCE_LIMIT)
            const actionLine = summary.action && summary.action !== summary.summary
                ? this.truncateReadyText(
                    `-> ${summary.action}`,
                    Math.max(0, READY_BODY_GLANCE_LIMIT - summaryLine.length - 1)
                )
                : ''
            const body = [summaryLine, actionLine].filter(Boolean).join('\n')
            return {
                title: headerTitle,
                body,
                notifySummary: {
                    ...summary,
                    summary: summaryLine,
                    ...(summary.action
                        ? { action: this.truncateReadyText(summary.action, READY_BODY_GLANCE_LIMIT) }
                        : {})
                }
            }
        }

        const trimmed = lastText.trim()
        if (trimmed.length === 0) return fallback

        // -3 leaves room for the '...' suffix so the body still fits the
        // glance limit. Without this it would tip over by 2 characters.
        const body = trimmed.length > READY_BODY_GLANCE_LIMIT
            ? trimmed.slice(0, READY_BODY_GLANCE_LIMIT - 3).trimEnd() + '...'
            : trimmed

        return { title: headerTitle, body }
    }

    private truncateReadyText(text: string, limit: number): string {
        const trimmed = text.trim()
        if (limit <= 0 || trimmed.length === 0) {
            return ''
        }
        if (trimmed.length <= limit) {
            return trimmed
        }
        return trimmed.slice(0, limit - 3).trimEnd() + '...'
    }

    /**
     * Walk the most recent stored messages and return the plain text of
     * the latest assistant message that *has* text content. Tool calls,
     * tool results, and reasoning blocks are skipped (they have no
     * text body, they would just show as `null` and force the fallback).
     */
    private findLastAssistantPlainText(sessionId: string): string | null {
        if (!this.store) return null

        let messages
        try {
            // 20 is generous: most ready events fire 1-3 messages after
            // the latest assistant text, and we cap to 20 to avoid
            // pathological scans on long sessions.
            messages = this.store.messages.getMessages(sessionId, 20)
        } catch {
            return null
        }

        // getMessages returns the LAST `limit` rows in ASCENDING seq order
        // (it queries DESC then reverses for caller convenience), so the
        // freshest message lives at the END of the array. Walk backwards
        // so we hit the latest assistant text first.
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const msg = messages[i]
            const record = unwrapRoleWrappedRecordEnvelope(msg.content)
            if (record?.role !== 'agent') continue
            const text = extractAssistantPlainText(record.content)
            if (text && text.trim().length > 0) {
                return text
            }
        }
        return null
    }

    async sendTaskNotification(session: Session, notification: TaskNotification, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const normalizedStatus = notification.status?.trim().toLowerCase()
        const isFailure = normalizedStatus === 'failed'
            || normalizedStatus === 'error'
            || normalizedStatus === 'killed'
            || normalizedStatus === 'aborted'
        const path = this.buildSessionPath(session.id)

        const payload = this.buildPayload({
            title: isFailure ? 'Task failed' : 'Task completed',
            body: `${agentName} · ${name} · ${notification.summary}`,
            type: 'task-notification',
            sessionId: session.id,
            sessionName: name,
            url: path,
            severity: isFailure ? 'error' : 'success'
        })

        await this.deliver(session, payload, ctx)
    }

    private buildPayload(input: {
        title: string
        body: string
        tag?: string
        type: string
        sessionId: string
        sessionName: string
        url: string
        requestId?: string
        severity?: 'info' | 'success' | 'warning' | 'error'
    }): FcmSendPayload {
        return {
            title: input.title,
            body: input.body,
            tag: input.tag,
            data: {
                type: input.type,
                sessionId: input.sessionId,
                sessionName: input.sessionName,
                url: input.url,
                requestId: input.requestId,
                title: input.title,
                body: input.body,
                contractVersion: CONTRACT_VERSION,
                severity: input.severity
            }
        }
    }

    private async deliver(session: Session, payload: FcmSendPayload, ctx?: NotificationSendContext): Promise<void> {
        // Native companion is the canonical surface: always fire FCM when the
        // hub asks us to. The previous SSE-toast shortcut here meant that
        // when the operator had the PWA open in foreground, the watch got
        // NOTHING - the in-page React toast was the only signal. That broke
        // the wrist-first UX (the whole point of installing a watch app)
        // and confused the operator about whether the agent was making
        // progress. SSE in-page toasts are still emitted by the PWA's own
        // SyncEngine event stream for users who want them; this channel's
        // job is to reach the wrist, period.
        const result = await this.fcmService.sendToNamespace(session.namespace, payload)
        if ((result?.sent ?? 0) > 0 && ctx?.nativeGate) {
            ctx.nativeGate.sent = true
        }
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }
}
