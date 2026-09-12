import {
    WORK_GRAPH_MAX_STRING,
    WORK_GRAPH_MAX_SUMMARY,
    WORK_GRAPH_MAX_TAGS,
    extractAssistantPlainText,
    extractNotifySummary,
    unwrapRoleWrappedRecordEnvelope,
    type NotifySummary,
    type WorkGraphEvent,
    type WorkGraphEventCreate
} from '@hapi/protocol'
import type { Store, StoredMessage } from '../store'
import { WorkGraphValidationError } from '../store'
import type { InsertWorkGraphEventResult } from '../store/workGraph'

const WORK_GRAPH_MAX_TAG = 256
const utf8Encoder = new TextEncoder()

/** Truncate to a UTF-8 byte budget (event.summary Zod max is char-oriented). */
function clampUtf8(value: string, maxBytes: number): string {
    if (utf8Encoder.encode(value).byteLength <= maxBytes) return value
    const chars: string[] = []
    let bytes = 0
    for (const char of value) {
        const size = utf8Encoder.encode(char).byteLength
        if (bytes + size > maxBytes) break
        chars.push(char)
        bytes += size
    }
    return chars.join('')
}

/**
 * Truncate so JSON-escaped UTF-8 bytes stay within budget.
 * `payloadJsonWithinLimit` measures JSON.stringify, where `\` / `"` / controls expand.
 */
function clampJsonUtf8(value: string, maxBytes: number): string {
    const chars: string[] = []
    let bytes = 0
    for (const char of value) {
        const escaped = JSON.stringify(char).slice(1, -1)
        const size = utf8Encoder.encode(escaped).byteLength
        if (bytes + size > maxBytes) break
        chars.push(char)
        bytes += size
    }
    return chars.join('')
}

function clampJsonUtf8Opt(value: string | undefined, maxBytes: number): string | undefined {
    if (value === undefined) return undefined
    return clampJsonUtf8(value, maxBytes)
}

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
 *
 * Policy: RFC `stale` is derived from `expires_at`, never from a fresh
 * self-report. `stalled` means the worker believes it is stuck → `blocked`.
 * An agent emitting status "stale" is treated as `unknown`.
 */
export function mapNotifyStatusToWorkAdStatus(status: string | undefined): WorkAdStatus {
    switch (status) {
        case 'done':
            return 'done'
        case 'blocked':
        case 'stalled':
            return 'blocked'
        case 'needs_decision':
        case 'needs_review':
            return 'needs_decision'
        case 'failed':
            return 'failed'
        case 'in_progress':
            return 'in_progress'
        case 'stale':
            return 'unknown'
        default:
            return status && WORK_AD_STATUSES.includes(status as WorkAdStatus) && status !== 'stale'
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
    /**
     * Hub-validated peer sender id from POST /cli/sessions/:source/peer-messages.
     * Never derived from persisted message meta (socket clients can forge that).
     */
    trustedPeerSourceSessionId?: string
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

export type WorkAdCause = {
    causeMessageId: string
    causeText: string | null
    causeKind: string | null
    causeSeq: number | null
    causeCursorMessageId: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function isInboundUserMessage(content: unknown): boolean {
    return asRecord(content)?.role === 'user'
}

function isCauseCandidate(message: StoredMessage, now: number = Date.now()): boolean {
    if (!isInboundUserMessage(message.content)) return false
    const meta = asRecord(asRecord(message.content)?.meta)
    // Claude jsonl echoes the remote prompt as a second role=user row (sentFrom cli).
    if (meta?.isTranscriptEcho === true) return false
    // Queued (localId, not yet acked) and unmatured scheduled rows are not this turn.
    if (message.invokedAt === null) return false
    if (message.scheduledAt != null && message.scheduledAt > now) return false
    return true
}

function extractInboundSentFrom(content: unknown): string | null {
    const meta = asRecord(asRecord(content)?.meta)
    return typeof meta?.sentFrom === 'string' && meta.sentFrom.trim().length > 0
        ? meta.sentFrom.trim()
        : null
}

function extractInboundCauseText(content: unknown): string | null {
    const record = asRecord(content)
    if (!record) return null
    const inner = record.content
    if (typeof inner === 'string') {
        const text = inner.trim()
        return text.length > 0 ? text : null
    }
    if (Array.isArray(inner)) {
        const parts = inner.flatMap((block) => {
            const item = asRecord(block)
            return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
        })
        const text = parts.join(' ').trim()
        return text.length > 0 ? text : null
    }
    const nested = asRecord(inner)
    if (nested?.type === 'text' && typeof nested.text === 'string') {
        const text = nested.text.trim()
        return text.length > 0 ? text : null
    }
    return null
}

function readCauseSeq(payload: unknown): number | null {
    const record = asRecord(payload)
    return typeof record?.causeSeq === 'number' && Number.isInteger(record.causeSeq)
        ? record.causeSeq
        : null
}

function readCauseCursorMessageId(payload: unknown): string | null {
    const record = asRecord(payload)
    return typeof record?.causeCursorMessageId === 'string' && record.causeCursorMessageId.length > 0
        ? record.causeCursorMessageId
        : null
}

function readCauseFromPayload(payload: unknown): WorkAdCause | null {
    const record = asRecord(payload)
    if (typeof record?.causeMessageId !== 'string' || record.causeMessageId.length === 0) {
        return null
    }
    return {
        causeMessageId: record.causeMessageId,
        causeText: typeof record.causeText === 'string' ? record.causeText : null,
        causeKind: typeof record.causeKind === 'string' ? record.causeKind : null,
        causeSeq: readCauseSeq(payload),
        causeCursorMessageId: readCauseCursorMessageId(payload)
    }
}

function loadMessagesForCause(
    store: Store,
    sessionId: string,
    previousWorkAds: WorkGraphEvent[]
): StoredMessage[] {
    const previous = previousWorkAds.at(-1) ?? null
    const cursorId = readCauseCursorMessageId(previous?.payloadJson)
    if (cursorId) {
        const cursorSeq = store.messages.getSeqById(sessionId, cursorId)
        if (cursorSeq != null) {
            return store.messages.getMessagesAfterSeq(sessionId, cursorSeq)
        }
        return store.messages.getAllMessages(sessionId)
    }
    const afterSeq = readCauseSeq(previous?.payloadJson)
    // First event / legacy rows without causeSeq still need the full session.
    // Later notifies only need rows after the previous cause (not every
    // compressed agent/tool blob since session start).
    if (afterSeq == null) {
        return store.messages.getAllMessages(sessionId)
    }
    return store.messages.getMessagesAfterSeq(sessionId, afterSeq)
}

function listPreviousWorkAds(
    store: Store,
    namespace: string,
    sessionId: string,
    principalSessionId: string
): WorkGraphEvent[] {
    // Only hub notify elevation for this principal. Peer-authored rows share
    // related_session_id with the recipient but must not steal related_event_id,
    // follows, or sticky/legacy cause consume for the recipient's next summary.
    // Client POST /work-graph/events can mint work_ad rows; those stay out via
    // provenance !== AGENT_NOTIFY_SUMMARY.
    return store.workGraph
        .listWorkAdsByRelatedSession(namespace, sessionId)
        .filter((event) => (
            event.provenance === 'AGENT_NOTIFY_SUMMARY'
            && event.sourceRef === principalSessionId
        ))
}

function consumedInboundIds(
    messages: StoredMessage[],
    previousWorkAds: WorkGraphEvent[]
): Set<string> {
    const consumed = new Set<string>()
    const byId = new Map(messages.map((message) => [message.id, message]))
    for (const event of previousWorkAds) {
        const stamped = readCauseFromPayload(event.payloadJson)
        if (stamped) {
            consumed.add(stamped.causeMessageId)
            continue
        }
        // Legacy notify rows have no causeMessageId. Treat inbounds at/before
        // that notify as consumed so the next turn does not re-attribute them.
        const payload = asRecord(event.payloadJson)
        const assistantId = typeof payload?.messageId === 'string' ? payload.messageId : null
        const assistant = assistantId ? byId.get(assistantId) : undefined
        if (!assistant) continue
        for (const message of messages) {
            if (message.seq <= assistant.seq && isCauseCandidate(message)) {
                consumed.add(message.id)
            }
        }
    }
    return consumed
}

/**
 * Sequential rule: first unconsumed invoked inbound is the cause identity.
 * causeSeq advances past other invoked inbounds before this assistant (one
 * Claude batch can join several same-mode prompts). Uninvoked leftovers wait.
 * No new invoked inbound → sticky copy of the previous event's cause.
 */
function batchCauseCursor(
    messages: StoredMessage[],
    inbound: StoredMessage,
    assistantSeq: number | null
): { causeSeq: number; causeCursorMessageId: string } {
    let maxSeq = inbound.seq
    let cursorId = inbound.id
    for (const message of messages) {
        if (assistantSeq != null && message.seq >= assistantSeq) continue
        if (!isCauseCandidate(message)) continue
        if (message.seq > maxSeq) {
            maxSeq = message.seq
            cursorId = message.id
        }
    }
    return { causeSeq: maxSeq, causeCursorMessageId: cursorId }
}

export function resolveWorkAdCause(params: {
    messages: StoredMessage[]
    previousWorkAds: WorkGraphEvent[]
    assistantSeq?: number | null
}): { cause: WorkAdCause | null; previousEventId: string | null } {
    const previous = params.previousWorkAds.at(-1) ?? null
    const consumed = consumedInboundIds(params.messages, params.previousWorkAds)
    const inbound = params.messages
        .filter((message) => (
            isCauseCandidate(message)
            && !consumed.has(message.id)
            && (params.assistantSeq == null || message.seq < params.assistantSeq)
        ))
        .sort((left, right) => {
            const invokedDelta = (right.invokedAt ?? 0) - (left.invokedAt ?? 0)
            if (invokedDelta !== 0) return invokedDelta
            return left.seq - right.seq
        })[0]
    if (inbound) {
        const text = extractInboundCauseText(inbound.content)
        const cursor = batchCauseCursor(params.messages, inbound, params.assistantSeq ?? null)
        return {
            cause: {
                causeMessageId: inbound.id,
                causeText: text === null ? null : clampJsonUtf8(text, WORK_GRAPH_MAX_SUMMARY),
                causeKind: extractInboundSentFrom(inbound.content),
                causeSeq: cursor.causeSeq,
                causeCursorMessageId: cursor.causeCursorMessageId
            },
            previousEventId: previous?.id ?? null
        }
    }
    if (previous) {
        const sticky = readCauseFromPayload(previous.payloadJson)
        if (sticky) {
            return { cause: sticky, previousEventId: previous.id }
        }
    }
    return { cause: null, previousEventId: previous?.id ?? null }
}

function buildTags(notify: NotifySummary, flavor: string | null | undefined): string[] {
    // Project stays in tags + payload for now. Indexed `project` column /
    // project-scoped list query is deferred to #1374 / P4 (cold review M4).
    // Tag strings are untrusted footer text — clamp to schema max before insert.
    const tags: string[] = ['notify_summary']
    if (notify.project) tags.push(clampJsonUtf8(`project:${notify.project}`, WORK_GRAPH_MAX_TAG))
    if (notify.agent) tags.push(clampJsonUtf8(`agent:${notify.agent}`, WORK_GRAPH_MAX_TAG))
    if (flavor) tags.push(clampJsonUtf8(`flavor:${flavor}`, WORK_GRAPH_MAX_TAG))
    return tags.slice(0, WORK_GRAPH_MAX_TAGS)
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
    cause?: WorkAdCause | null
    relatedEventId?: string | null
    /**
     * Session that authored the notify (peer source). Defaults to sessionId
     * (message home / assistant turn). Peer deliveries set this to the sender.
     */
    principalSessionId?: string
}): WorkGraphEventCreate {
    const status = mapNotifyStatusToWorkAdStatus(params.notify.status)
    // Footer fields are untrusted. Clamp to ledger schema bounds so elevation
    // still lands; store insert also validates WorkGraphEventCreateSchema.
    const summary = clampUtf8(buildWorkAdSummaryFromNotify(params.notify), WORK_GRAPH_MAX_SUMMARY)
    const action = clampJsonUtf8Opt(params.notify.action, WORK_GRAPH_MAX_STRING) ?? null
    const project = clampJsonUtf8Opt(params.notify.project, WORK_GRAPH_MAX_STRING) ?? null
    const agent = clampJsonUtf8Opt(params.notify.agent, WORK_GRAPH_MAX_STRING) ?? null
    const cause = params.cause
    const causeMessageId = cause
        ? clampJsonUtf8(cause.causeMessageId, 256)
        : null
    const causeText = cause?.causeText == null
        ? null
        : clampJsonUtf8(cause.causeText, WORK_GRAPH_MAX_SUMMARY)
    const causeKind = cause?.causeKind == null
        ? null
        : clampJsonUtf8(cause.causeKind, WORK_GRAPH_MAX_TAG)
    const principalSessionId = params.principalSessionId ?? params.sessionId
    // Audit principal is always session-bound. notify.agent is untrusted
    // self-label text and stays advisory in payload/tags only.
    // Do not nest a full notify_summary copy — duplicating clamped strings
    // can blow the 32 KiB payload_json cap and silently drop the ledger row.
    return {
        source_kind: 'session',
        source_ref: principalSessionId,
        event_type: 'work_ad',
        summary,
        payload_json: {
            status,
            action,
            project,
            agent,
            messageId: params.messageId,
            ...(cause && causeMessageId
                ? {
                    causeMessageId,
                    causeText,
                    causeKind,
                    causeSeq: cause.causeSeq,
                    ...(cause.causeCursorMessageId
                        ? { causeCursorMessageId: clampJsonUtf8(cause.causeCursorMessageId, 256) }
                        : {})
                }
                : {})
        },
        tags: buildTags(params.notify, params.flavor),
        related_session_id: params.sessionId,
        related_event_id: params.relatedEventId || undefined,
        provenance: 'AGENT_NOTIFY_SUMMARY',
        idempotency_key: `session:${params.sessionId}:message:${params.messageId}:notify`,
        expires_at: params.expiresAt ?? (params.ts + WORK_AD_DEFAULT_TTL_MS),
        principal: {
            kind: 'agent',
            id: `session:${principalSessionId}`,
            on_behalf_of: String(params.ownerUserId)
        }
    }
}

/**
 * On message ingest: well-formed trailing AGENT_NOTIFY_SUMMARY →
 * idempotent work_ad row. Invalid/missing footer → no-op (null).
 *
 * Accepts agent assistant text, plus user-role deliveries from the
 * validated CLI peer route (caller passes trustedPeerSourceSessionId).
 * Persisted meta.notifySource is never trusted — socket clients can forge it.
 * Ordinary web/CLI/Telegram prompts are never elevated even if they paste a footer.
 *
 * Ledger rows are append-only audit: deleting the related session does not
 * delete work_ad rows (cold review M1).
 */
function extractAgentNotifyText(content: unknown): string | null {
    if (!isAgentMessageContent(content)) return null
    const agentBody = unwrapRoleWrappedRecordEnvelope(content)
    const agentContent = agentBody?.role === 'agent' ? agentBody.content : content
    return extractAssistantPlainText(agentContent)
}

export function ingestNotifySummaryFromMessage(input: NotifyIngestInput): NotifyIngestResult {
    const peerSourceSessionId = input.trustedPeerSourceSessionId?.trim() || null
    const plainText = peerSourceSessionId
        ? extractInboundCauseText(input.content)
        : extractAgentNotifyText(input.content)
    if (!plainText) {
        return null
    }

    const notify = extractNotifySummary(plainText)
    if (!notify) {
        return null
    }

    const principalSessionId = peerSourceSessionId ?? input.sessionId

    // Cause is hub-derived from session messages SQL (no REST 200 cap).
    const previousWorkAds = listPreviousWorkAds(
        input.store,
        input.namespace,
        input.sessionId,
        principalSessionId
    )
    // Peer deliveries are not a recipient turn response — do not attribute
    // unrelated target prompts as cause of the peer-authored work_ad.
    const { cause, previousEventId } = peerSourceSessionId
        ? {
            cause: null,
            previousEventId: previousWorkAds.at(-1)?.id ?? null
        }
        : (() => {
            const messages = loadMessagesForCause(input.store, input.sessionId, previousWorkAds)
            const assistantSeq = messages.find((message) => message.id === input.messageId)?.seq ?? null
            return resolveWorkAdCause({
                messages,
                previousWorkAds,
                assistantSeq
            })
        })()

    const create = buildWorkAdFromNotify({
        sessionId: input.sessionId,
        messageId: input.messageId,
        notify,
        ownerUserId: input.ownerUserId,
        flavor: input.flavor,
        ts: input.ts,
        cause,
        relatedEventId: previousEventId,
        principalSessionId
    })

    try {
        const result = input.store.workGraph.insertEvent(input.namespace, create, { ts: input.ts })
        if (result.inserted && previousEventId) {
            try {
                input.store.workGraph.insertLink(input.namespace, {
                    from_event_id: result.event.id,
                    to_event_id: previousEventId,
                    relation_type: 'follows'
                })
            } catch {
                // Best-effort edge; related_event_id is already on the row.
            }
        }
        return result
    } catch (error) {
        // Best-effort capture: never break message ingest on ledger bounds.
        if (error instanceof WorkGraphValidationError) {
            return null
        }
        throw error
    }
}
