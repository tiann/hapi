import {
    extractAssistantPlainText,
    extractNotifySummary,
    unwrapRoleWrappedRecordEnvelope,
    type NotifySummary,
    type WorkGraphEventCreate
} from '@hapi/protocol'
import type { Store } from '../store'
import type { InsertWorkGraphEventResult } from '../store/workGraph'

/** WorkAd status vocabulary from the A2A RFC (P3 notify elevation). */
export const WORK_AD_STATUSES = [
    'in_progress',
    'blocked',
    'needs_decision',
    'done',
    'failed',
    'stale',
    'unknown'
] as const
export type WorkAdStatus = (typeof WORK_AD_STATUSES)[number]

/**
 * Default work_ad TTL from message timestamp.
 * Staleness filtering / reap is P4; this field must still be populated so
 * "eventually stale via expires_at" is representable (cold review M2).
 */
export const WORK_AD_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Map AGENT_NOTIFY_SUMMARY.status → WorkAd payload status.
 * Notify contract uses needs_review / stalled; ledger uses RFC WorkAd vocab.
 */
export function mapNotifyStatusToWorkAdStatus(status: string | undefined): WorkAdStatus {
    switch (status) {
        case 'done':
            return 'done'
        case 'blocked':
            return 'blocked'
        case 'needs_decision':
        case 'needs_review':
            return 'needs_decision'
        case 'failed':
            return 'failed'
        case 'stalled':
            return 'stale'
        case 'in_progress':
            return 'in_progress'
        default:
            return status && WORK_AD_STATUSES.includes(status as WorkAdStatus)
                ? status as WorkAdStatus
                : 'unknown'
    }
}

export function buildWorkAdSummaryFromNotify(notify: NotifySummary): string {
    const summary = notify.summary?.trim()
    if (summary) return summary
    const action = notify.action?.trim()
    if (action) return action
    const status = notify.status?.trim()
    if (status) return `Agent status: ${status}`
    return 'Agent turn summary'
}

export type NotifyIngestInput = {
    store: Store
    namespace: string
    sessionId: string
    messageId: string
    content: unknown
    ts: number
    /** Authenticated hub owner id; required for accountable agent principal. */
    ownerUserId: string | number
    flavor?: string | null
}

export type NotifyIngestResult = InsertWorkGraphEventResult | null

function isAgentMessageContent(content: unknown): boolean {
    if (content === null || typeof content !== 'object' || Array.isArray(content)) {
        return false
    }
    const record = content as Record<string, unknown>
    if (record.role === 'agent') return true
    if (record.type === 'output' || record.type === 'codex') return true
    return false
}

function buildTags(notify: NotifySummary, flavor: string | null | undefined): string[] {
    // Project stays in tags + payload for now. Indexed `project` column /
    // project-scoped list query is deferred to #1374 / P4 (cold review M4).
    const tags: string[] = ['notify_summary']
    if (notify.project) tags.push(`project:${notify.project}`)
    if (notify.agent) tags.push(`agent:${notify.agent}`)
    if (flavor) tags.push(`flavor:${flavor}`)
    return tags
}

/**
 * Build the work-graph create payload for a parsed notify footer (RFC P3).
 * Pure helper for tests + ingest.
 */
export function buildWorkAdFromNotify(params: {
    sessionId: string
    messageId: string
    notify: NotifySummary
    ownerUserId: string | number
    /** Message createdAt — also anchors default expires_at. */
    ts: number
    flavor?: string | null
    expiresAt?: number
}): WorkGraphEventCreate {
    const status = mapNotifyStatusToWorkAdStatus(params.notify.status)
    const agentId = params.notify.agent?.trim() || `session:${params.sessionId}`
    return {
        source_kind: 'session',
        source_ref: params.sessionId,
        event_type: 'work_ad',
        summary: buildWorkAdSummaryFromNotify(params.notify),
        payload_json: {
            status,
            action: params.notify.action ?? null,
            project: params.notify.project ?? null,
            notify_summary: params.notify,
            messageId: params.messageId
        },
        tags: buildTags(params.notify, params.flavor),
        related_session_id: params.sessionId,
        provenance: 'AGENT_NOTIFY_SUMMARY',
        idempotency_key: `session:${params.sessionId}:message:${params.messageId}:notify`,
        expires_at: params.expiresAt ?? (params.ts + WORK_AD_DEFAULT_TTL_MS),
        principal: {
            kind: 'agent',
            id: agentId,
            on_behalf_of: String(params.ownerUserId)
        }
    }
}

/**
 * On assistant message ingest: well-formed trailing AGENT_NOTIFY_SUMMARY →
 * idempotent work_ad row. Invalid/missing footer → no-op (null).
 *
 * Ledger rows are append-only audit: deleting the related session does not
 * delete work_ad rows (cold review M1).
 */
export function ingestNotifySummaryFromMessage(input: NotifyIngestInput): NotifyIngestResult {
    if (!isAgentMessageContent(input.content)) {
        return null
    }

    const agentBody = unwrapRoleWrappedRecordEnvelope(input.content)
    const agentContent = agentBody?.role === 'agent' ? agentBody.content : input.content
    const plainText = extractAssistantPlainText(agentContent)
    if (!plainText) {
        return null
    }

    const notify = extractNotifySummary(plainText)
    if (!notify) {
        return null
    }

    const create = buildWorkAdFromNotify({
        sessionId: input.sessionId,
        messageId: input.messageId,
        notify,
        ownerUserId: input.ownerUserId,
        flavor: input.flavor,
        ts: input.ts
    })

    return input.store.workGraph.insertEvent(input.namespace, create, { ts: input.ts })
}
