import {
    WORK_GRAPH_MAX_STRING,
    WORK_GRAPH_MAX_SUMMARY,
    WORK_GRAPH_MAX_TAGS,
    detectNotifySummaryNearMiss,
    extractAssistantPlainText,
    extractNotifySummary,
    isLiveStreamSnapshot,
    unwrapRoleWrappedRecordEnvelope,
    type NotifySummary,
    type WorkGraphEvent,
    type WorkGraphEventCreate,
    isBlockedNotifyStatus,
    normalizeNotifyStatus,
    pickNotifyNote,
    type SessionNotifySignal
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
        // Retention may trim the cursor row while the ledger row (and its
        // numeric causeSeq watermark) survives: resume after causeSeq instead
        // of degrading to a full session read on every later notify. The
        // watermark is only trustworthy while every remaining row sits above
        // it — a history move (mergeSessionHistory) empties the session and
        // restarts its seq space, leaving stale low watermarks that would
        // skip freshly appended rows.
        const trimmedSeq = readCauseSeq(previous?.payloadJson)
        if (trimmedSeq != null) {
            const minSeq = store.messages.getMinSeq(sessionId)
            if (minSeq == null || minSeq > trimmedSeq) {
                return store.messages.getMessagesAfterSeq(sessionId, trimmedSeq)
            }
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
    sessionId: string
): WorkGraphEvent[] {
    // Only hub notify elevation. Client POST /work-graph/events can mint
    // work_ad rows; those must not steal related_event_id, follows, or sticky cause.
    return store.workGraph
        .listWorkAdsByRelatedSession(namespace, sessionId)
        .filter((event) => (
            event.provenance === 'AGENT_NOTIFY_SUMMARY'
            && event.sourceRef === sessionId
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
 * No new invoked inbound → sticky copy of the previous event's cause, with the
 * resume point (causeSeq + causeCursorMessageId) advanced past this assistant
 * turn when no waiting inbound below it can still mature into a cause.
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

/**
 * An inbound below the resume watermark that can still mature into a cause
 * later (queued/not yet invoked, or unmatured scheduled). While any exist, the
 * resume point must not advance past them or they would never be attributed.
 * Transcript echoes and already-consumed rows are dead ends.
 */
function hasWaitingInbound(
    messages: StoredMessage[],
    watermark: number,
    consumed: Set<string>,
    now: number = Date.now()
): boolean {
    return messages.some((message) => (
        message.seq < watermark
        && !consumed.has(message.id)
        && isInboundUserMessage(message.content)
        && asRecord(asRecord(message.content)?.meta)?.isTranscriptEcho !== true
        && (message.invokedAt === null || (message.scheduledAt != null && message.scheduledAt > now))
    ))
}

export function resolveWorkAdCause(params: {
    messages: StoredMessage[]
    previousWorkAds: WorkGraphEvent[]
    assistantSeq?: number | null
    assistantMessageId?: string | null
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
            // Sticky copy keeps the cause identity but should still advance the
            // resume point past this assistant turn when nothing below it can
            // mature into a future cause. Automation-style sessions emit many
            // notifies with no new invoked inbound; without the advance the
            // resume point stays frozen at the original inbound and every
            // notify re-reads and re-parses the whole session tail (zstd +
            // JSON per row), growing without bound as the session grows.
            const watermark = params.assistantSeq ?? null
            const resumeMessageId = params.assistantMessageId ?? null
            const canAdvance = watermark != null
                && resumeMessageId != null
                && watermark > (sticky.causeSeq ?? Number.NEGATIVE_INFINITY)
                && !hasWaitingInbound(params.messages, watermark, consumed)
            if (canAdvance) {
                return {
                    cause: { ...sticky, causeSeq: watermark, causeCursorMessageId: resumeMessageId },
                    previousEventId: previous.id
                }
            }
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
    // Audit principal is always session-bound. notify.agent is untrusted
    // self-label text and stays advisory in payload/tags only.
    // Do not nest a full notify_summary copy — duplicating clamped strings
    // can blow the 32 KiB payload_json cap and silently drop the ledger row.
    return {
        source_kind: 'session',
        source_ref: params.sessionId,
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
            id: `session:${params.sessionId}`,
            on_behalf_of: String(params.ownerUserId)
        }
    }
}

/**
 * A near miss - a final line that attempts the footer but does not parse -
 * silently costs the turn its status. Say so once at the ingest boundary;
 * otherwise the only detector is a human noticing the status never arrived.
 *
 * The wording has to hold for every reason. A `trailing-content` line is often
 * correct prose quoting the contract, which is kept on screen rather than
 * stripped - calling that "malformed" or "ignored" would read as a dropped
 * status to anyone grepping for one. What is true in every case is that the
 * final line recorded no status, so that is what the message says, and
 * `removedFromDisplay` distinguishes the two outcomes.
 *
 * Mid-stream snapshots are skipped: a footer that is still being written is
 * incomplete by construction, not malformed.
 */
function warnOnNotifySummaryNearMiss(input: NotifyIngestInput, plainText: string): void {
    if (isLiveStreamSnapshot(input.content)) return

    const nearMiss = detectNotifySummaryNearMiss(plainText)
    if (!nearMiss) return

    console.warn('[work-graph] no AGENT_NOTIFY_SUMMARY status recorded from the final line', {
        reason: nearMiss.reason,
        removedFromDisplay: nearMiss.removedFromDisplay,
        payloadLength: nearMiss.payloadLength,
        sessionId: input.sessionId,
        messageId: input.messageId
    })
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
        warnOnNotifySummaryNearMiss(input, plainText)
        return null
    }

    // Cause is hub-derived from session messages SQL (no REST 200 cap).
    const previousWorkAds = listPreviousWorkAds(input.store, input.namespace, input.sessionId)
    const messages = loadMessagesForCause(input.store, input.sessionId, previousWorkAds)
    // Direct seq lookup: the window above is incremental, so the notify-bearing
    // assistant row (and its seq) is not guaranteed to be inside it.
    const assistantSeq = input.store.messages.getSeqById(input.sessionId, input.messageId)
    const { cause, previousEventId } = resolveWorkAdCause({
        messages,
        previousWorkAds,
        assistantSeq,
        assistantMessageId: input.messageId
    })

    const create = buildWorkAdFromNotify({
        sessionId: input.sessionId,
        messageId: input.messageId,
        notify,
        ownerUserId: input.ownerUserId,
        flavor: input.flavor,
        ts: input.ts,
        cause,
        relatedEventId: previousEventId
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

/**
 * True for an operator prompt the agent has actually been given.
 *
 * A scheduled message is withheld from the CLI until it matures AND is
 * invoked, so an overdue-but-uninvoked one has still answered nothing — the
 * due time alone is not delivery. Ordering uses the invocation time, because
 * that is when the agent saw it.
 */
export function isDeliveredOperatorReply(
    message: {
        content: unknown
        scheduledAt: number | null
        invokedAt: number | null
        sweptAt?: number | null
        agentDelivered?: number | null
    }
): boolean {
    if (!isOperatorReplyMessage(message.content)) return false
    // The CLI consumed the row synchronously without prompting the agent: a
    // slash command it handled itself, a rejected or aborted message, a failed
    // steer. `invoked_at` is stamped regardless, so without the persisted
    // disposition the transcript paths read it as an answer the agent never
    // got. NULL is "written before this was recorded" and stays permissive.
    if (message.agentDelivered === 0) return false
    // The session-end sweep stamps `invokedAt` to unpin the floating bar, on
    // rows the runtime never received. Its own documentation calls that
    // synthetic. Treating it as a delivered reply let a session end answer a
    // blocker nobody replied to.
    if (message.sweptAt != null && message.sweptAt === message.invokedAt) return false
    // Delivery evidence for EVERY queued reply, not just scheduled ones: a
    // prompt still sitting in the queue with a null `invokedAt` has not
    // reached the agent either, and treating it as an answer buries a footer
    // the agent never saw.
    return message.invokedAt !== null
}

/**
 * When the hub received a message, as opposed to when its author wrote it.
 *
 * The key a delivery boundary is measured against (#1717). `createdAt` is the
 * agent runner's own clock, preserved verbatim through transcript replay, so it
 * cannot be compared with the hub-stamped `invokedAt` of a reply. Hub arrival
 * can: both sides are then the same clock. A position cannot be used either —
 * insertion `seq` is allocated as MAX(seq)+1, so cancelling a queued row frees
 * its number for reuse, and a merge renumbers one side's positions into
 * something synthetic rather than real.
 *
 * Rows written before `received_at` existed fall back to `createdAt`, the only
 * evidence they carry.
 */
export function messageReceivedAt(
    message: { createdAt: number; receivedAt?: number | null }
): number {
    return message.receivedAt ?? message.createdAt
}

/**
 * When a delivered reply reached the agent, in the hub's clock (#1717).
 *
 * `invoked_at` is hub-stamped only for a reply that went through the hub
 * QUEUE. A prompt typed straight into a local agent terminal has no local id,
 * so nothing ever stamped it and `invoked_at` carries the runner's transcript
 * clock — measuring that against a footer's hub arrival is the cross-clock
 * comparison this area exists to avoid. For those, the row's own hub arrival
 * is the right stand-in, because that is when the hub saw the reply.
 *
 * Shared by every path that has to order a reply against a footer — live
 * ingestion, the transcript derivation, and the session merges — because the
 * two that had their own copy of this rule disagreed about local replies.
 */
export function operatorReplyDeliveredAt(
    message: {
        createdAt: number
        receivedAt?: number | null
        scheduledAt: number | null
        invokedAt: number | null
        reconciledInvokedAt?: number | null
        localId?: string | null
    }
): number {
    return message.localId == null
        ? messageReceivedAt(message)
        : deliveredOperatorReplyAt(message)
}

/**
 * When the agent actually saw a delivered reply.
 *
 * `reconciledInvokedAt` is preferred when a session merge recovered it
 * (#1717 cold-review round 23): it carries the SAME fact `invokedAt` would
 * if a synthetic import stamp had never been written in the first place,
 * without touching `invokedAt` itself — which also drives this row's
 * conversation position and must not move just because reconciliation
 * learned a truer time.
 */
export function deliveredOperatorReplyAt(
    message: { createdAt: number; scheduledAt: number | null; invokedAt: number | null }
): number {
    // Invocation time, always. A reply composed before a footer can be
    // invoked after it; ordering on `createdAt` would let that reply "answer"
    // a footer written while it was still queued.
    return message.invokedAt ?? message.createdAt
}

/**
 * Stable identity for a notify footer, independent of which session or
 * which `createdAt` it happens to carry there (#1717).
 *
 * A Codex Desktop duplicate-session merge can hold two separate
 * PROJECTIONS of the exact same underlying footer — a live Hapi session's
 * own copy and a Desktop import of the same thread — each stamped with
 * its own session's clock, so the same event can carry two different
 * `createdAt` values depending on which session you read it from. Text
 * plus status plus note is not enough on its own either: a Claude replay
 * genuinely repeats the same footer a second time, same fields, and that
 * replay IS meant to compare equal to the original. The native transcript
 * id breaks the tie where one exists: an imported row carries it as
 * `localId`, so two distinct turns that happen to report the same status
 * and note are still two different messages. A live Claude reply has no
 * local id at all and shares every field with the row it duplicates, so
 * there the text (plus status, author time, and note) IS the only
 * identity available.
 */
export function notifySignalIdentity(
    message: { localId: string | null },
    signal: { status: string; at: number; note: string | null }
): string {
    return message.localId == null
        ? `text ${signal.status} ${signal.at} ${signal.note ?? ''}`
        : `msg ${message.localId}`
}

/**
 * True for a real operator prompt — the thing that answers a blocked agent.
 * Excludes the Claude jsonl transcript echo, which replays the same prompt as
 * a second `role=user` row and would otherwise look like a fresh reply.
 */
export function isOperatorReplyMessage(content: unknown): boolean {
    if (!isInboundUserMessage(content)) return false
    return asRecord(asRecord(content)?.meta)?.isTranscriptEcho !== true
}

/**
 * Parse an agent message down to the compact signal the session list renders
 * (#1717 blocked chrome).
 *
 * Shares the agent-message gating and footer extraction with the work-graph
 * ingest below so both surfaces agree on what counts as a footer — the list
 * must never light up on something the ledger ignored, or vice versa.
 *
 * `note` is only carried for blocked statuses: it exists to give the row
 * tooltip something actionable, and storing it for every `done` footer would
 * grow the /sessions payload for nothing.
 */
/**
 * True for Claude subagent (sidechain) output.
 *
 * Checked on the raw record and one envelope level down, because the local
 * transcript scanner and the remote SDK converter wrap the flags differently.
 */
function isSidechainOutput(content: unknown, depth: number = 0): boolean {
    const record = asRecord(content)
    if (!record || depth > 4) return false
    if (record.isSidechain === true) return true
    if (typeof record.parentToolUseId === 'string' && record.parentToolUseId.length > 0) return true
    for (const key of ['content', 'data', 'message'] as const) {
        if (isSidechainOutput(record[key], depth + 1)) return true
    }
    return false
}

export function extractSessionNotifySignal(
    content: unknown,
    ts: number
): SessionNotifySignal | null {
    if (!isAgentMessageContent(content)) {
        return null
    }

    // A subagent's footer describes the subagent, not the session. Both the
    // local transcript scanner and the remote SDK converter forward sidechain
    // assistant output, so without this a background subagent's `done` erases
    // the main agent's unanswered blocker — or its `blocked` flags a parent
    // that actually finished.
    if (isSidechainOutput(content)) {
        return null
    }

    // A live stream snapshot is a transient cumulative render of a message
    // still being written, and the hub sweeps it from the transcript once the
    // message settles. OpenCode emits them, so a snapshot can end on a valid
    // footer while the settled message goes on to add prose after it and carry
    // no valid footer at all — and the list kept the status derived from the
    // snapshot, showing blocked once thinking ended. The work-graph ingest has
    // skipped these all along; list status has to agree, and for the same
    // reason: only settled output is the agent's actual self-report.
    if (isLiveStreamSnapshot(content)) {
        return null
    }

    const agentBody = unwrapRoleWrappedRecordEnvelope(content)
    const agentContent = agentBody?.role === 'agent' ? agentBody.content : content
    const plainText = extractAssistantPlainText(agentContent)
    if (!plainText) {
        return null
    }

    const notify = extractNotifySummary(plainText)
    if (!notify) {
        return null
    }

    const status = normalizeNotifyStatus(notify.status)
    if (!status) {
        return null
    }

    return {
        status,
        at: ts,
        note: isBlockedNotifyStatus(status) ? pickNotifyNote(notify) : null
    }
}

/**
 * Ledger event for an operator's manual unblock (#1717).
 *
 * Pure so the recorded payload is testable without standing
 * up a SyncEngine. Carries the agent's prior claim alongside the operator's
 * rationale, so a reader can distinguish "operator disagreed with the agent"
 * from "operator resolved it elsewhere" — the two have very different
 * implications for whether the agent's judgement should be trusted next time.
 */
export function buildOperatorUnblockEvent(input: {
    sessionId: string
    ownerUserId: string | number
    reason: string
    /** When the operator made this decision — hub now, NOT the blocker's own
     *  timestamp. The session event log sorts by event time, so stamping a
     *  days-old blocker's time filed today's rationale among last week's
     *  activity, or outside a recent-events window entirely. */
    acknowledgedAt: number
    /** The dismissed blocker's own timestamp, kept as a detail rather than as
     *  the event's position in the log. */
    observedAt?: number | null
    /** Identity of the blocker the operator dismissed. Recorded even when the
     *  footer it named has since been replaced, so the event can still be
     *  matched back to what was actually reviewed. */
    observedKey?: string | null
    priorNotify: NotifySummary | SessionNotifySignal | null
}): WorkGraphEventCreate {
    const principalId = String(input.ownerUserId)
    const prior = input.priorNotify
    return {
        source_kind: 'operator',
        source_ref: principalId,
        sink_kind: 'session',
        sink_ref: input.sessionId,
        event_type: 'operator_unblock',
        summary: clampUtf8(input.reason, WORK_GRAPH_MAX_SUMMARY),
        related_session_id: input.sessionId,
        provenance: 'hapi-web/session-action-menu',
        payload_json: {
            reason: clampJsonUtf8(input.reason, WORK_GRAPH_MAX_STRING),
            acknowledged_at: input.acknowledgedAt,
            // The identity is recorded unconditionally. The prior_* fields go
            // null when the footer named by the key has already been replaced,
            // and without the key the event could not be matched back to what
            // the operator actually dismissed — including for a live request,
            // which has no footer at all.
            blocker_key: input.observedKey
                ? clampJsonUtf8(input.observedKey, WORK_GRAPH_MAX_STRING)
                : null,
            observed_at: input.observedAt ?? null,
            prior_status: prior?.status ?? null,
            prior_note: (prior && 'note' in prior ? prior.note : null) ?? null,
            prior_at: (prior && 'at' in prior ? prior.at : null) ?? null
        },
        principal: { kind: 'human', id: principalId }
    }
}
