import type { Database } from 'bun:sqlite'
import { prepareCached } from './statementCache'
import { recordUserMessage } from './sessionUserActivity'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

import { hasUnreadMessageContent, getLiveReasoningStreamId, getReasoningStreamId, getTextLiveStreamId, getTextStreamId, getToolCallId, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'

import type { StoredMessage } from './types'
import { decodeMessageContent, encodeMessageContent, truncateOversizedMessageContent } from './contentCodec'
import { safeJsonParse } from './json'
import {
    indexMessageContent,
    invalidateMessageContentSearchInjectedTurnCache,
    rebuildMessageContentSearchForSessions,
    removeMessageContentSearchIndex
} from './messageContentSearch'

type DbMessageRow = {
    content_revision: number
    id: string
    session_id: string
    // TEXT (plaintext JSON, legacy rows) or BLOB (zstd-compressed JSON) — see contentCodec.ts
    content: string | Uint8Array
    created_at: number
    seq: number
    local_id: string | null
    invoked_at: number | null
    scheduled_at: number | null
    delivery_state: string | null
}

// Message-store methods can be called directly or composed inside a Store-level
// transaction. Reuse an existing transaction so canonical rows and derived
// content-search rows always commit or roll back together.
function runInTransaction<T>(db: Database, operation: () => T): T {
    return db.inTransaction ? operation() : db.transaction(operation)()
}

export type MessagePosition = {
    at: number
    seq: number
}

export type SteerDeliveryState = 'queued' | 'dispatching' | 'indeterminate'

export class ImportedMessageConflictError extends Error {
    constructor(readonly localId: string) {
        super(`Imported message content changed for localId: ${localId}`)
        this.name = 'ImportedMessageConflictError'
    }
}

export function addImportedMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId: string,
    createdAt: number
): { message: StoredMessage; inserted: boolean } {
    const existing = prepareCached(db,
        'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
    ).get(sessionId, localId) as DbMessageRow | undefined
    if (existing) {
        const message = toStoredMessage(existing)
        const canonicalContent = truncateOversizedMessageContent(content)
        if (!isDeepStrictEqual(message.content, canonicalContent)) throw new ImportedMessageConflictError(localId)
        return { message, inserted: false }
    }

    const now = Date.now()
    const stampedAt = Number.isFinite(createdAt) ? Math.min(createdAt, now) : now
    return db.transaction(() => {
        const previousHead = getNewestMessagePosition(db, sessionId)
        const msgSeqRow = prepareCached(db,
            'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
        ).get(sessionId) as { nextSeq: number }
        const id = randomUUID()
        const canonicalContent = truncateOversizedMessageContent(content)
        prepareCached(db, `
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, NULL
            )
        `).run({
            id,
            session_id: sessionId,
            content: encodeMessageContent(canonicalContent),
            created_at: stampedAt,
            seq: msgSeqRow.nextSeq,
            local_id: localId,
            invoked_at: stampedAt
        })
        indexMessageContent(db, {
            id,
            sessionId,
            content: canonicalContent,
            seq: msgSeqRow.nextSeq,
            createdAt: stampedAt,
            invokedAt: stampedAt
        })
        recordUserMessage(db, sessionId, content, stampedAt)
        if (previousHead && stampedAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = prepareCached(db, 'SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create imported message')
        invalidateLiveTail(db, sessionId)
        return { message: toStoredMessage(row), inserted: true }
    })()
}
function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        ...(row.content_revision > 0 ? { contentRevision: row.content_revision } : {}),
        content: decodeMessageContent(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        invokedAt: row.invoked_at ?? null,
        scheduledAt: row.scheduled_at ?? null,
        ...(row.delivery_state && row.delivery_state !== 'queued' ? { deliveryState: 'indeterminate' as const } : {}),
        ...(row.delivery_state === 'dispatching' ? { deliveryPending: true as const } : {})
    }
}

export type CopyStoredMessageInput = Pick<
    StoredMessage,
    'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'
>

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string,
    scheduledAt?: number | null,
    createdAt?: number
): StoredMessage {
    const now = Date.now()
    // Client-provided origin timestamp (e.g. a Claude transcript entry's own
    // `timestamp`), falling back to server-receive time when absent. Only
    // agent-message callers (sessionHandlers' `on('message')`) pass this today.
    const stampedAt = Number.isFinite(createdAt)
        ? Math.min(createdAt!, now)
        : now

    // Without a localId, invoked_at is stamped immediately below — there is no
    // ack path to flip it later.  A scheduled message in that state would be
    // skipped by the future-emit branch and never picked up by
    // getMatureScheduledMessages (which filters on invoked_at IS NULL), so
    // the schedule would be silently lost.
    if (scheduledAt != null && !localId) {
        throw new Error('addMessage: scheduledAt requires a localId for the ack flow')
    }

    if (localId) {
        const existing = prepareCached(db,
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    const msgSeqRow = prepareCached(db,
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { nextSeq: number }
    const msgSeq = msgSeqRow.nextSeq

    const id = randomUUID()
    const canonicalContent = truncateOversizedMessageContent(content)
    const encoded = encodeMessageContent(canonicalContent)

    // Messages without a localId have no ack path (markMessagesInvoked matches by localId).
    // Treat them as already-invoked at insert time so they land in the thread normally instead
    // of being stuck in the queued floating bar forever. Stamped with `stampedAt` (the
    // client-provided createdAt when present) rather than server-now so getMessagesByPosition's
    // COALESCE(invoked_at, created_at) sort reflects the transcript's own jsonl order instead of
    // hub arrival order.
    const invokedAt = localId ? null : stampedAt

    return db.transaction(() => {
        const previousHead = getNewestMessagePosition(db, sessionId)
        prepareCached(db, `
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at
            )
        `).run({
            id,
            session_id: sessionId,
            content: encoded,
            created_at: stampedAt,
            seq: msgSeq,
            local_id: localId ?? null,
            invoked_at: invokedAt,
            scheduled_at: scheduledAt ?? null
        })
        indexMessageContent(db, {
            id,
            sessionId,
            content: canonicalContent,
            seq: msgSeq,
            createdAt: stampedAt,
            invokedAt
        })

        if (hasUnreadMessageContent(content)) {
            prepareCached(db, 'UPDATE sessions SET content_revision = content_revision + 1 WHERE id = ?').run(sessionId)
            prepareCached(db, 'UPDATE messages SET content_revision = (SELECT content_revision FROM sessions WHERE id = ?) WHERE id = ?').run(sessionId, id)
        }
        recordUserMessage(db, sessionId, content, stampedAt)
        const positionAt = invokedAt ?? stampedAt
        if (previousHead && positionAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = prepareCached(db, 'SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create message')
        updateLiveTailAfterAppend(db, sessionId, row.id, row.seq, canonicalContent)
        // One settlement pass per stored row — the prior twin helpers were identical (#2021).
        noteChildToolCallState(db, sessionId, canonicalContent)
        return toStoredMessage(row)
    })()
}

/**
 * How far back to look for the live row of one ACP tool call.
 *
 * The CLI re-emits a tool call under a stable callId on every state tick, so
 * the previous tick of the same call always sits among the newest rows of its
 * session. A bounded tail scan keeps the lookup off the hot path on sessions
 * with tens of thousands of messages; anything older is left alone, which
 * errs toward inserting a fresh row (the pre-upsert behavior).
 */
const TOOL_CALL_UPSERT_LOOKBACK = 200

/**
 * OpenCode child tool calls can outlive the parent transcript lookback.
 * A bounded scan cannot answer "is any child still working?" — track open
 * child call ids explicitly and clear them only on settlement (#2021).
 *
 * State is rebuilt from durable messages on first access after a hub restart
 * so Archive cannot fail open when the in-memory WeakMap is cold. Settled ids
 * stay latched: a late nonterminal snapshot with the same callId must not
 * reopen work after a result or scoped turn-complete.
 */
type ChildToolCallState = {
    /** OpenCode child-scoped ACP call ids (survive parent human turns). */
    open: Set<string>
    /** Parent-scope ACP call ids — cleared on an invoked human turn (#2021). */
    openForeground: Set<string>
    /** Seq of the message that opened each foreground call (#2021). */
    openForegroundSeq: Map<string, number>
    settled: Set<string>
    /** OpenCode children that reported running/created with no open tool yet. */
    runningChildren: Set<string>
    /** Child session ids the hub has observed complete/fail/interrupt. */
    settledChildren: Set<string>
    rebuilt: boolean
    /**
     * Durable metadata overlay applied once on a cold WeakMap entry. Must not
     * re-run after an incremental transition (e.g. settled→running) or the
     * write path would restore the stale settled entry (#2021).
     */
    durableSeeded: boolean
}

type DurableChildToolWork = {
    running: string[]
    settled: string[]
    settledCallIds: string[]
}

const childToolCallsByDb = new WeakMap<Database, Map<string, ChildToolCallState>>()

function childToolCallState(db: Database, sessionId: string): ChildToolCallState {
    let bySession = childToolCallsByDb.get(db)
    if (!bySession) {
        bySession = new Map()
        childToolCallsByDb.set(db, bySession)
    }
    let state = bySession.get(sessionId)
    if (!state) {
        state = {
            open: new Set(),
            openForeground: new Set(),
            openForegroundSeq: new Map(),
            settled: new Set(),
            runningChildren: new Set(),
            settledChildren: new Set(),
            rebuilt: false,
            durableSeeded: false,
        }
        bySession.set(sessionId, state)
    }
    return state
}

function readSessionFlavor(db: Database, sessionId: string): string | null {
    const row = prepareCached(db, 'SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as
        | { metadata: string | null }
        | undefined
    const metadata = safeJsonParse(row?.metadata ?? null)
    if (!isRecord(metadata)) return null
    return typeof metadata.flavor === 'string' ? metadata.flavor : null
}

function readDurableChildToolWork(db: Database, sessionId: string): DurableChildToolWork | null {
    const row = prepareCached(db, 'SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as
        | { metadata: string | null }
        | undefined
    const metadata = safeJsonParse(row?.metadata ?? null)
    if (!isRecord(metadata) || !isRecord(metadata.childToolWork)) return null
    const work = metadata.childToolWork
    const running = Array.isArray(work.running)
        ? work.running.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : []
    const settled = Array.isArray(work.settled)
        ? work.settled.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : []
    const settledCallIds = Array.isArray(work.settledCallIds)
        ? work.settledCallIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : []
    return { running, settled, settledCallIds }
}

/**
 * Seed in-memory state from durable metadata when the WeakMap is cold
 * (post-rewind / post-restart) so an incremental status write cannot clobber
 * verified settlements that exist only in metadata (#2021).
 * Callers must seed *before* applying an incoming transition; writeDurable
 * must not re-seed after that transition (#2021 tip Major).
 */
function seedDurableChildToolWorkIfNeeded(db: Database, sessionId: string, state: ChildToolCallState): void {
    if (state.rebuilt || state.durableSeeded) return
    applyDurableChildToolWork(state, readDurableChildToolWork(db, sessionId))
    state.durableSeeded = true
}

/** Dual-write running/settled child session ids + settled ACP call ids. */
function writeDurableChildToolWork(db: Database, sessionId: string, state: ChildToolCallState): void {
    // Do not seed here — note*/rebuild seed before applying transitions so a
    // live running status can clear a durable settled entry (#2021).
    const flavor = readSessionFlavor(db, sessionId)
    const row = prepareCached(db, 'SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as
        | { metadata: string | null }
        | undefined
    if (!row) return
    const prior = safeJsonParse(row.metadata)
    const metadata = isRecord(prior) ? { ...prior } : {}
    const existing = isRecord(metadata.childToolWork) ? metadata.childToolWork : null
    const priorRunning = Array.isArray(existing?.running) ? existing.running : []
    const priorSettled = Array.isArray(existing?.settled) ? existing.settled : []
    const priorSettledCalls = Array.isArray(existing?.settledCallIds)
        ? existing.settledCallIds.filter((id): id is string => typeof id === 'string')
        : []
    // settledCallIds are an OpenCode rewind latch (null flavor uses the same
    // full-rebuild path). Named non-OpenCode flavors still settle in memory
    // but must not grow metadata on every foreground tool result (#2021 Minor).
    // Do not dump every in-memory settled ID into metadata on ordinary results
    // (quadratic SQLite writes). Latch grows only via turn-complete settledCallIds
    // / rewind harvest through latchOpenCodeSettledCallIds (#2021 Minor).
    let settledCallIds: string[]
    if (flavor === null || flavor === 'opencode') {
        settledCallIds = priorSettledCalls
    } else {
        settledCallIds = priorSettledCalls
    }
    const next: DurableChildToolWork = {
        running: [...state.runningChildren].sort(),
        settled: [...state.settledChildren].sort(),
        settledCallIds,
    }
    if (
        priorRunning.length === next.running.length
        && priorSettled.length === next.settled.length
        && priorSettledCalls.length === next.settledCallIds.length
        && priorRunning.every((id, i) => id === next.running[i])
        && priorSettled.every((id, i) => id === next.settled[i])
        && priorSettledCalls.every((id, i) => id === next.settledCallIds[i])
    ) {
        return
    }
    metadata.childToolWork = next
    prepareCached(db, `
        UPDATE sessions
        SET metadata = ?, metadata_version = metadata_version + 1, seq = seq + 1
        WHERE id = ?
    `).run(JSON.stringify(metadata), sessionId)
}

function applyDurableChildToolWork(state: ChildToolCallState, durable: DurableChildToolWork | null): void {
    if (!durable) return
    for (const id of durable.settledCallIds) {
        state.settled.add(id)
        state.open.delete(id)
        clearForegroundCall(state, id)
    }
    for (const id of durable.settled) {
        state.settledChildren.add(id)
        state.runningChildren.delete(id)
    }
    for (const id of durable.running) {
        if (state.settledChildren.has(id)) continue
        state.runningChildren.add(id)
    }
}

function clearForegroundCall(state: ChildToolCallState, callId: string): void {
    state.openForeground.delete(callId)
    state.openForegroundSeq.delete(callId)
}

/** Clear foreground opens at or before `boundarySeq` (invoked human turn). */
function clearForegroundAtOrBefore(state: ChildToolCallState, boundarySeq: number): void {
    for (const [callId, seq] of state.openForegroundSeq) {
        if (seq <= boundarySeq) {
            state.openForeground.delete(callId)
            state.openForegroundSeq.delete(callId)
        }
    }
}

function applyChildToolCallContent(state: ChildToolCallState, content: unknown, seq?: number): void {
    // Invoked human turns close parent-scope ACP work at/before this seq;
    // child registry and newer foreground starts survive (#2021).
    if (isUserMessageRow(content)) {
        if (typeof seq === 'number') clearForegroundAtOrBefore(state, seq)
        else {
            state.openForeground.clear()
            state.openForegroundSeq.clear()
        }
        return
    }
    const resultCallId = toolCallResultCallId(content)
    if (resultCallId !== null) {
        state.open.delete(resultCallId)
        clearForegroundCall(state, resultCallId)
        state.settled.add(resultCallId)
    }
    for (const callId of acpTurnCompleteSettledCallIds(content)) {
        state.open.delete(callId)
        clearForegroundCall(state, callId)
        state.settled.add(callId)
    }
    for (const childSessionId of acpTurnCompleteRetiredChildSessionIds(content)) {
        state.runningChildren.delete(childSessionId)
        state.settledChildren.add(childSessionId)
    }
    const childStatus = acpTurnCompleteChildStatus(content)
    if (childStatus) {
        if (childStatus.status === 'running' || childStatus.status === 'created') {
            state.runningChildren.add(childStatus.childSessionId)
            state.settledChildren.delete(childStatus.childSessionId)
        } else {
            state.runningChildren.delete(childStatus.childSessionId)
            state.settledChildren.add(childStatus.childSessionId)
        }
    }
    const callId = getToolCallId(content)
    // Track child-scoped AND parent-scope ACP starts. Lookback alone cannot
    // keep an autonomous foreground call alive once 200 newer rows push it
    // out of the scan (#2021 Major).
    if (!callId || !isAcpToolCallStartOrResult(content)) return
    if (isTerminalToolCallRow(content) || state.settled.has(callId)) {
        state.open.delete(callId)
        clearForegroundCall(state, callId)
        state.settled.add(callId)
        return
    }
    if (isChildScopedAcpToolCall(content)) {
        state.open.add(callId)
    } else if (isParentScopedAcpToolCallStart(content)) {
        state.openForeground.add(callId)
        if (typeof seq === 'number') state.openForegroundSeq.set(callId, seq)
    }
}

/**
 * Rebuild open/settled child ids once per session per process. Hub restart
 * clears the WeakMap; archive must still see a lookback-evicted open child.
 *
 * OpenCode child running/settled also dual-writes to hub-owned metadata so a
 * rewind that drops a terminal marker cannot forget verified completion
 * (#2021). Non-OpenCode flavors skip the full transcript replay — they have
 * no child registry traffic, and the periodic derived-work sweep must not
 * decode every session history on cold start.
 *
 * Full replay stays off the ingestion hot path — only archive / live-work
 * evaluation and worker-exit retirement call this (#2021).
 */
function ensureChildToolCallStateRebuilt(db: Database, sessionId: string): ChildToolCallState {
    const state = childToolCallState(db, sessionId)
    if (state.rebuilt) return state

    const durable = readDurableChildToolWork(db, sessionId)
    const flavor = readSessionFlavor(db, sessionId)

    // Claude uses passthrough tool_use in the bounded lookback — skip the
    // full decode on cold Hub sweeps (#2021 Minor). Every other flavor that
    // can emit ACP tool-call payloads needs unbounded opens across restart
    // (#2021 Major: grok/kimi/copilot/dsh/pi/…).
    if (flavor === 'claude') {
        applyDurableChildToolWork(state, durable)
        state.durableSeeded = true
        state.rebuilt = true
        return state
    }

    state.open.clear()
    state.openForeground.clear()
    state.openForegroundSeq.clear()
    state.settled.clear()
    state.runningChildren.clear()
    state.settledChildren.clear()
    const rows = prepareCached(db, `
        SELECT content, invoked_at, seq FROM messages
        WHERE session_id = ?
        ORDER BY seq ASC
    `).all(sessionId) as Array<Pick<DbMessageRow, 'content' | 'invoked_at' | 'seq'>>
    for (const row of rows) {
        const decoded = decodeMessageContent(row.content)
        // Only invoked user turns clear foreground opens (match lookback).
        if (isUserMessageRow(decoded) && row.invoked_at == null) continue
        applyChildToolCallContent(state, decoded, row.seq)
    }
    // Durable settled wins over a transcript that lost its terminal marker
    // (OpenCode rewind). Running overlays only for ids not yet settled.
    applyDurableChildToolWork(state, durable)
    state.durableSeeded = true
    state.rebuilt = true
    if (flavor === null || flavor === 'opencode') {
        writeDurableChildToolWork(db, sessionId, state)
    }
    return state
}

/** Latch OpenCode settled call IDs into durable metadata without a full rewrite of in-memory settled. */
function latchOpenCodeSettledCallIds(db: Database, sessionId: string, callIds: string[]): void {
    if (callIds.length === 0) return
    const flavor = readSessionFlavor(db, sessionId)
    if (flavor !== null && flavor !== 'opencode') return
    const state = childToolCallState(db, sessionId)
    seedDurableChildToolWorkIfNeeded(db, sessionId, state)
    for (const id of callIds) {
        state.settled.add(id)
        state.open.delete(id)
        clearForegroundCall(state, id)
    }
    const row = prepareCached(db, 'SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as
        | { metadata: string | null }
        | undefined
    if (!row) return
    const prior = safeJsonParse(row.metadata)
    const metadata = isRecord(prior) ? { ...prior } : {}
    const existing = isRecord(metadata.childToolWork) ? metadata.childToolWork : null
    const priorSettledCalls = Array.isArray(existing?.settledCallIds)
        ? existing.settledCallIds.filter((id): id is string => typeof id === 'string')
        : []
    const merged = new Set(priorSettledCalls)
    for (const id of callIds) merged.add(id)
    const settledCallIds = [...merged]
    if (
        priorSettledCalls.length === settledCallIds.length
        && priorSettledCalls.every((id, i) => id === settledCallIds[i])
    ) {
        writeDurableChildToolWork(db, sessionId, state)
        return
    }
    const next: DurableChildToolWork = {
        running: Array.isArray(existing?.running) ? [...existing.running].map(String).sort() : [...state.runningChildren].sort(),
        settled: Array.isArray(existing?.settled) ? [...existing.settled].map(String).sort() : [...state.settledChildren].sort(),
        settledCallIds,
    }
    // Prefer live state for running/settled children.
    next.running = [...state.runningChildren].sort()
    next.settled = [...state.settledChildren].sort()
    metadata.childToolWork = next
    prepareCached(db, `
        UPDATE sessions
        SET metadata = ?, metadata_version = metadata_version + 1, seq = seq + 1
        WHERE id = ?
    `).run(JSON.stringify(metadata), sessionId)
}

/** Incremental update only — never full-scan the transcript on ingest. */
function noteChildToolCallState(db: Database, sessionId: string, content: unknown): void {
    const state = childToolCallState(db, sessionId)
    seedDurableChildToolWorkIfNeeded(db, sessionId, state)
    // Undispatched scheduled/queued prompts are not turn boundaries.
    if (isUserMessageRow(content)) {
        const row = prepareCached(db, `
            SELECT invoked_at FROM messages
            WHERE session_id = ?
            ORDER BY seq DESC
            LIMIT 1
        `).get(sessionId) as { invoked_at: number | null } | undefined
        if (row?.invoked_at == null) return
    }
    const latest = prepareCached(db, `
        SELECT seq FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1
    `).get(sessionId) as { seq: number } | undefined
    applyChildToolCallContent(state, content, latest?.seq)
    const turnSettled = acpTurnCompleteSettledCallIds(content)
    if (turnSettled.length > 0) {
        latchOpenCodeSettledCallIds(db, sessionId, turnSettled)
        return
    }
    if (
        acpTurnCompleteChildStatus(content)
        || acpTurnCompleteRetiredChildSessionIds(content).length > 0
        || toolCallResultCallId(content) !== null
        || isChildScopedAcpToolCall(content)
        || isParentScopedAcpToolCallStart(content)
        || isUserMessageRow(content)
    ) {
        writeDurableChildToolWork(db, sessionId, state)
    }
}

/**
 * Retire open tool / running-child work when its worker generation exits or is
 * replaced. Covers:
 *   - child-scoped ACP registry entries + runningChildren
 *   - foreground ACP `tool-call` rows in the lookback
 *   - Claude passthrough `tool_use` ids still open in the lookback
 * A dead worker cannot settle them; the replacement idle session must stay
 * archivable (#2021).
 */
export function retireOpenChildToolWork(db: Database, sessionId: string): boolean {
    const state = ensureChildToolCallStateRebuilt(db, sessionId)
    const settledCallIds = new Set<string>([...state.open, ...state.openForeground])
    const retiredChildSessionIds = [...state.runningChildren]

    const rows = prepareCached(db, `
        SELECT content, invoked_at FROM messages
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
    `).all(sessionId, TOOL_CALL_UPSERT_LOOKBACK) as Array<Pick<DbMessageRow, 'content' | 'invoked_at'>>
    const settledInWindow = new Set<string>()
    const settledClaudeToolUseIds = new Set<string>()
    let claudeTurnClosed = false
    for (const row of rows) {
        const decoded = decodeMessageContent(row.content)
        for (const callId of acpTurnCompleteSettledCallIds(decoded)) {
            settledInWindow.add(callId)
            settledClaudeToolUseIds.add(callId)
        }
        const resultCallId = toolCallResultCallId(decoded)
        if (resultCallId !== null) settledInWindow.add(resultCallId)
        const callId = getToolCallId(decoded)
        if (
            callId !== null
            && !settledInWindow.has(callId)
            && !state.settled.has(callId)
            && !isTerminalToolCallRow(decoded)
        ) {
            settledCallIds.add(callId)
        }

        // Claude passthrough: collect open tool_use ids the ACP path cannot see.
        if (isUserMessageRow(decoded) && row.invoked_at != null) {
            claudeTurnClosed = true
            continue
        }
        const claudeData = claudeOutputData(decoded)
        if (claudeData === null || isHiddenClaudeOutput(claudeData)) continue
        if (claudeData.type === 'result') {
            claudeTurnClosed = true
            continue
        }
        if (claudeData.type === 'user') {
            if (!collectClaudeToolResultIds(claudeData, settledClaudeToolUseIds)) {
                claudeTurnClosed = true
            }
            continue
        }
        if (claudeData.type === 'assistant' && !claudeTurnClosed) {
            const blocks = claudeMessageBlocks(claudeData)
            if (!blocks) continue
            for (const block of blocks) {
                if (!isRecord(block) || block.type !== 'tool_use') continue
                if (typeof block.id !== 'string' || block.id.trim().length === 0) continue
                if (settledClaudeToolUseIds.has(block.id) || state.settled.has(block.id)) continue
                settledCallIds.add(block.id)
            }
        }
    }

    if (settledCallIds.size === 0 && retiredChildSessionIds.length === 0) return false
    state.open.clear()
    state.openForeground.clear()
    state.openForegroundSeq.clear()
    for (const childSessionId of retiredChildSessionIds) {
        state.settledChildren.add(childSessionId)
    }
    state.runningChildren.clear()
    for (const callId of settledCallIds) state.settled.add(callId)
    writeDurableChildToolWork(db, sessionId, state)
    const settledList = [...settledCallIds]
    addMessage(db, sessionId, {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: {
                type: 'turn-complete',
                stopReason: 'worker-exited',
                ...(settledList.length > 0 ? { settledCallIds: settledList } : {}),
                ...(retiredChildSessionIds.length > 0 ? { retiredChildSessionIds } : {}),
            },
        },
    })
    return true
}

/** `tool-call` payload fields merged newest-wins-when-non-null. */
const TOOL_CALL_MERGE_FIELDS = ['name', 'input', 'nativeTitle', 'nativeKind', 'nativeName', 'nativeArgs'] as const

/** Status progression rank for one tool call: pending < in_progress <
 *  completed/failed. A merged row may only advance the state — agents
 *  normalize a missing/unknown status to `pending` (cli normalizeStatus), so
 *  permission rounds re-emit pending after the call already ran, and that
 *  re-send must not overwrite `in_progress` and never a terminal state.
 *  `completed`/`failed` share the terminal tier; ties keep the newer value. */
const TOOL_CALL_STATUS_RANK: Record<string, number> = {
    pending: 0,
    in_progress: 1,
    completed: 2,
    failed: 2
}

function toolCallStatusRank(status: unknown): number | null {
    return typeof status === 'string' && status in TOOL_CALL_STATUS_RANK
        ? TOOL_CALL_STATUS_RANK[status]
        : null
}

function mergeToolCallStatus(stored: unknown, incoming: unknown): unknown {
    if (incoming === null || incoming === undefined) return stored
    const storedRank = toolCallStatusRank(stored)
    const incomingRank = toolCallStatusRank(incoming)
    // Unrecognized status strings rank below every known state so an unknown
    // value can never regress a known one; two unknowns keep the newer.
    if (incomingRank === null) return storedRank === null ? incoming : stored
    if (storedRank === null) return incoming
    return incomingRank >= storedRank ? incoming : stored
}

export type UpsertToolCallResult = {
    message: StoredMessage
    /** True when an existing tool-call row was updated in place. */
    updated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The callId of a stored `tool-call-result` row, or null. The result shares
 *  the call's callId but is a distinct row that must never be merged into. */
function toolCallResultCallId(value: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return null
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null
    const data = isRecord(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'tool-call-result') return null
    const callId = data.callId
    return typeof callId === 'string' && callId.trim().length > 0 ? callId : null
}

function isUserMessageRow(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    return record?.role === 'user'
}

type TailRowMeta = {
    id: string
    seq: number
    reasoningStreamId: string | null
    toolCallId: string | null
    toolResultCallId: string | null
    isUser: boolean
}

type SessionLiveTail = {
    headId: string | null
    headSeq: number
    tailRows: TailRowMeta[]
    liveToolCalls: Map<string, string>
    reasoningSnapshots: Map<string, Set<string>>
}

const liveTailByDb = new WeakMap<Database, Map<string, SessionLiveTail>>()

function getCurrentTailHead(db: Database, sessionId: string): { id: string | null; seq: number } {
    const row = prepareCached(db,
        'SELECT id, seq FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1'
    ).get(sessionId) as { id: string; seq: number } | undefined
    return row ? { id: row.id, seq: row.seq } : { id: null, seq: 0 }
}

function invalidateLiveTail(db: Database, sessionId: string): void {
    liveTailByDb.get(db)?.delete(sessionId)
}

/**
 * Drop the in-memory OpenCode child-work registry so the next live-work check
 * rebuilds from transcript + durable childToolWork (e.g. after session-row
 * dedup merge writes a new ledger onto a warmed destination) (#2021).
 */
export function invalidateChildToolWorkState(db: Database, sessionId: string): void {
    const state = childToolCallsByDb.get(db)?.get(sessionId)
    if (!state) return
    state.rebuilt = false
    state.durableSeeded = false
    state.open.clear()
    state.openForeground.clear()
    state.openForegroundSeq.clear()
    state.settled.clear()
    state.runningChildren.clear()
    state.settledChildren.clear()
    invalidateLiveTail(db, sessionId)
}

/**
 * Evict the session's tool-work and live-tail cache entries after deletion so
 * settled IDs do not accumulate for the life of the hub process (#2021).
 */
export function releaseChildToolWorkState(db: Database, sessionId: string): void {
    childToolCallsByDb.get(db)?.delete(sessionId)
    invalidateLiveTail(db, sessionId)
}

function classifyTailRow(id: string, seq: number, decoded: unknown): TailRowMeta {
    const reasoningStreamId = getLiveReasoningStreamId(decoded)
    const callId = getToolCallId(decoded)
    const resultCallId = callId ? null : toolCallResultCallId(decoded)
    const isUser = !callId && !resultCallId && isUserMessageRow(decoded)
    return { id, seq, reasoningStreamId, toolCallId: callId, toolResultCallId: resultCallId, isUser }
}

function rebuildTailIndexes(entry: SessionLiveTail): void {
    entry.liveToolCalls.clear()
    entry.reasoningSnapshots.clear()
    const closedCallIds = new Set<string>()
    let toolCallScanStopped = false
    const total = entry.tailRows.length
    for (let i = total - 1; i >= 0; i -= 1) {
        const row = entry.tailRows[i]!
        const distFromHead = total - 1 - i
        if (distFromHead < REASONING_SNAPSHOT_LOOKBACK && row.reasoningStreamId) {
            let ids = entry.reasoningSnapshots.get(row.reasoningStreamId)
            if (!ids) {
                ids = new Set()
                entry.reasoningSnapshots.set(row.reasoningStreamId, ids)
            }
            ids.add(row.id)
        }
        if (!toolCallScanStopped && distFromHead < TOOL_CALL_UPSERT_LOOKBACK) {
            if (row.toolCallId) {
                if (!closedCallIds.has(row.toolCallId) && !entry.liveToolCalls.has(row.toolCallId)) {
                    entry.liveToolCalls.set(row.toolCallId, row.id)
                }
            } else if (row.toolResultCallId) {
                closedCallIds.add(row.toolResultCallId)
            } else if (row.isUser) {
                toolCallScanStopped = true
            }
        }
    }
}

function warmLiveTail(db: Database, sessionId: string, head: { id: string | null; seq: number }): SessionLiveTail {
    let sessions = liveTailByDb.get(db)
    if (!sessions) {
        sessions = new Map()
        liveTailByDb.set(db, sessions)
    }

    const lookback = Math.max(TOOL_CALL_UPSERT_LOOKBACK, REASONING_SNAPSHOT_LOOKBACK)
    const rows = prepareCached(db, `
        SELECT id, seq, content FROM messages
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
    `).all(sessionId, lookback) as Array<Pick<DbMessageRow, 'id' | 'seq' | 'content'>>

    const tailRowsAsc: TailRowMeta[] = []
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]!
        tailRowsAsc.push(classifyTailRow(row.id, row.seq, decodeMessageContent(row.content)))
    }

    const entry: SessionLiveTail = {
        headId: head.id,
        headSeq: head.seq,
        tailRows: tailRowsAsc,
        liveToolCalls: new Map(),
        reasoningSnapshots: new Map()
    }
    rebuildTailIndexes(entry)
    sessions.set(sessionId, entry)
    return entry
}

function getOrWarmLiveTail(db: Database, sessionId: string): SessionLiveTail {
    const head = getCurrentTailHead(db, sessionId)
    const cached = liveTailByDb.get(db)?.get(sessionId)
    if (cached && cached.headId === head.id && cached.headSeq === head.seq) {
        return cached
    }
    return warmLiveTail(db, sessionId, head)
}

function updateLiveTailAfterAppend(
    db: Database,
    sessionId: string,
    id: string,
    seq: number,
    content: unknown
): void {
    const entry = liveTailByDb.get(db)?.get(sessionId)
    if (!entry) return
    if (seq <= entry.headSeq) {
        invalidateLiveTail(db, sessionId)
        return
    }
    entry.headId = id
    entry.headSeq = seq

    const meta = classifyTailRow(id, seq, content)
    if (meta.reasoningStreamId) {
        let ids = entry.reasoningSnapshots.get(meta.reasoningStreamId)
        if (!ids) {
            ids = new Set()
            entry.reasoningSnapshots.set(meta.reasoningStreamId, ids)
        }
        ids.add(id)
    }

    if (meta.toolCallId) {
        entry.liveToolCalls.set(meta.toolCallId, id)
    } else if (meta.toolResultCallId) {
        entry.liveToolCalls.delete(meta.toolResultCallId)
    } else if (meta.isUser) {
        entry.liveToolCalls.clear()
    }

    entry.tailRows.push(meta)
    if (entry.tailRows.length > REASONING_SNAPSHOT_LOOKBACK) {
        const exitedReasoning = entry.tailRows[entry.tailRows.length - 1 - REASONING_SNAPSHOT_LOOKBACK]
        if (exitedReasoning?.reasoningStreamId) {
            const set = entry.reasoningSnapshots.get(exitedReasoning.reasoningStreamId)
            if (set) {
                set.delete(exitedReasoning.id)
                if (set.size === 0) {
                    entry.reasoningSnapshots.delete(exitedReasoning.reasoningStreamId)
                }
            }
        }
    }
    const maxLookback = Math.max(TOOL_CALL_UPSERT_LOOKBACK, REASONING_SNAPSHOT_LOOKBACK)
    if (entry.tailRows.length > maxLookback) {
        const evicted = entry.tailRows.shift()
        if (evicted?.toolCallId && entry.liveToolCalls.get(evicted.toolCallId) === evicted.id) {
            entry.liveToolCalls.delete(evicted.toolCallId)
        }
    }
}

/** Merge an incoming tool-call snapshot into the stored one.
 *
 *  A non-null new value wins for the payload fields the CLI updates
 *  independently; a null/absent one keeps the stored value, so a later
 *  status-only tick cannot erase the input or title an earlier tick carried.
 *  `status` merges by progression rank so a re-emitted pending never regresses
 *  a running or terminal call. `progress` follows the web's latest-wins
 *  rendering of that transient (reducerTools.ensureToolBlock). */
function mergeToolCallContent(stored: unknown, incoming: unknown): unknown {
    const envelope = unwrapRoleWrappedRecordEnvelope(stored)
    const incomingEnvelope = unwrapRoleWrappedRecordEnvelope(incoming)
    if (!envelope || !incomingEnvelope || !isRecord(envelope.content) || !isRecord(incomingEnvelope.content)) {
        return incoming
    }
    const storedData = isRecord(envelope.content.data) ? envelope.content.data : {}
    const incomingData = isRecord(incomingEnvelope.content.data) ? incomingEnvelope.content.data : {}
    const mergedData: Record<string, unknown> = { ...storedData }
    for (const field of TOOL_CALL_MERGE_FIELDS) {
        const next = incomingData[field]
        if (next !== null && next !== undefined) mergedData[field] = next
    }
    const mergedStatus = mergeToolCallStatus(storedData.status, incomingData.status)
    if (mergedStatus !== null && mergedStatus !== undefined) mergedData.status = mergedStatus
    if (incomingData.progress !== null && incomingData.progress !== undefined) {
        mergedData.progress = incomingData.progress
    }
    return { ...envelope, content: { ...envelope.content, data: mergedData } }
}

/** Find the live tool-call row for one callId, scanning the session tail.
 *
 *  The scan stops at a `tool-call-result` with the same callId or at a user
 *  message row: both mean the call has completed or a new turn started, so an
 *  incoming message with that callId is a NEW call, not an update. */
function findLiveToolCallRow(db: Database, sessionId: string, callId: string): DbMessageRow | null {
    const tail = getOrWarmLiveTail(db, sessionId)
    const rowId = tail.liveToolCalls.get(callId)
    if (!rowId) return null
    const full = prepareCached(db, 'SELECT * FROM messages WHERE id = ? AND session_id = ?').get(rowId, sessionId) as DbMessageRow | undefined
    if (!full) {
        invalidateLiveTail(db, sessionId)
        return null
    }
    return full
}

/** The `data` record of a Claude-SDK passthrough row
 *  (`{ role: 'agent', content: { type: 'output', data } }`), or null. */
function claudeOutputData(value: unknown): Record<string, unknown> | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return null
    if (record.content.type !== 'output') return null
    return isRecord(record.content.data) ? record.content.data : null
}

/** Claude passthrough rows the chat never renders (meta / compact summaries /
 *  subagent sidechains). Their tool traffic has no settlement contract in the
 *  main thread, so the liveness sweep must ignore them on both sides. */
function isHiddenClaudeOutput(data: Record<string, unknown>): boolean {
    return data.isMeta === true || data.isCompactSummary === true || data.isSidechain === true
}

/** The `message.content` block array of a Claude passthrough row, or null. */
function claudeMessageBlocks(data: Record<string, unknown>): unknown[] | null {
    const message = isRecord(data.message) ? data.message : null
    return Array.isArray(message?.content) ? message.content : null
}

/** Collect `tool_result` tool_use_ids from a Claude user passthrough row.
 *  Returns whether the row carried any tool_result at all — a user row
 *  without one is a human prompt, which starts a new turn. */
function collectClaudeToolResultIds(data: Record<string, unknown>, into: Set<string>): boolean {
    const blocks = claudeMessageBlocks(data)
    if (!blocks) return false
    let found = false
    for (const block of blocks) {
        if (!isRecord(block) || block.type !== 'tool_result') continue
        if (typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
            into.add(block.tool_use_id)
            found = true
        }
    }
    return found
}

/** Whether a Claude assistant passthrough row holds a `tool_use` block whose
 *  result has not settled yet (work the agent is still waiting on). */
function claudeAssistantHasOpenToolUse(
    data: Record<string, unknown>,
    ...settledSets: Array<ReadonlySet<string>>
): boolean {
    const blocks = claudeMessageBlocks(data)
    if (!blocks) return false
    for (const block of blocks) {
        if (!isRecord(block) || block.type !== 'tool_use') continue
        if (typeof block.id !== 'string' || block.id.length === 0) continue
        let settled = false
        for (const set of settledSets) {
            if (set.has(block.id)) {
                settled = true
                break
            }
        }
        if (!settled) return true
    }
    return false
}

/** Whether a stored ACP `tool-call` row already reports a terminal status.
 *  Flavors that settle a call through its status (instead of a separate
 *  `tool-call-result` row) must not read as open work. */
function isTerminalToolCallRow(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record || !isRecord(record.content) || record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return false
    const data = isRecord(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'tool-call') return false
    return toolCallStatusRank(data.status) === TOOL_CALL_STATUS_RANK.completed
}

/** ACP turn-end marker (`turn_complete` from the CLI converter). Carries the
 *  specific call ids retired by that prompt — never a blanket "settle all
 *  older rows", so an OpenCode parent cancel cannot hide a still-open child. */
function acpTurnCompleteSettledCallIds(value: unknown): string[] {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return []
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return []
    const data = isRecord(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'turn-complete') return []
    if (!Array.isArray(data.settledCallIds)) return []
    return data.settledCallIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
}

/** OpenCode child alive/terminal marker on a turn-complete row (#2021). */
function acpTurnCompleteChildStatus(value: unknown): { childSessionId: string; status: string } | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return null
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null
    const data = isRecord(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'turn-complete') return null
    const childSessionId = data.childSessionId
    const status = data.childStatus
    if (typeof childSessionId !== 'string' || childSessionId.trim().length === 0) return null
    if (typeof status !== 'string' || status.trim().length === 0) return null
    return { childSessionId, status }
}

/** Child session ids retired with a worker-exited turn-complete (#2021). */
function acpTurnCompleteRetiredChildSessionIds(value: unknown): string[] {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return []
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return []
    const data = isRecord(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'turn-complete') return []
    if (!Array.isArray(data.retiredChildSessionIds)) return []
    return data.retiredChildSessionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
}

/** OpenCode v2 child (background subagent) tool traffic outlives parent turns. */
function isChildScopedAcpToolCall(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return false
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return false
    const data = isRecord(record.content.data) ? record.content.data : null
    if (!data || (data.type !== 'tool-call' && data.type !== 'tool-call-result')) return false
    return typeof data.childSessionId === 'string' && data.childSessionId.trim().length > 0
}

/** Parent-scope ACP tool-call / result payloads (no childSessionId). */
function isAcpToolCallStartOrResult(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return false
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return false
    const data = isRecord(record.content.data) ? record.content.data : null
    return !!data && (data.type === 'tool-call' || data.type === 'tool-call-result')
}

/** Unmatched parent-scope ACP starts outlive the lookback window (#2021). */
function isParentScopedAcpToolCallStart(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent' || !isRecord(record.content)) return false
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return false
    const data = isRecord(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'tool-call') return false
    return typeof data.childSessionId !== 'string' || data.childSessionId.trim().length === 0
}

/** Whether the session tail still holds tool work that started but never
 *  settled — the transcript-derived "the agent is demonstrably working"
 *  signal for the hub's work-scoped liveness sweep.
 *
 *  Scans the same bounded tail window as `findLiveToolCallRow` and shares its
 *  liveness contract (which the toolCallRowCache also keys on): a settled
 *  call is closed by a later result row, and every live call of the session
 *  is closed by a later human turn. Walking newest-first:
 *
 *  - ACP flavors: an unsettled, non-terminal `tool-call` row means open work
 *    inside the lookback window. OpenCode `childSessionId` calls are also
 *    tracked in an unbounded open-child registry (lookback cannot answer
 *    "is a long-running child still working?"). `turn-complete.settledCallIds`
 *    clears both the scan and that registry.
 *  - Claude passthrough: an assistant `tool_use` block with no later user
 *    `tool_result` for its id means open work. Tool-result carriers do NOT
 *    close the turn (the agent loop continues through them); a user row with
 *    no tool_result is a human prompt and does.
 *
 *  Anything older than the window reads as no work — the same err-closed
 *  bias the upsert scan uses for ancient rows. */
export function getLiveToolWork(db: Database, sessionId: string): boolean {
    // Child work is tracked out-of-band: a lookback scan cannot see a child
    // call older than TOOL_CALL_UPSERT_LOOKBACK, and must not fail open.
    // Settled ids are latched across restarts so a late nonterminal snapshot
    // with the same callId cannot reopen work in the scan either (#2021).
    //
    // Open tool-call ids OR a child that reported running/created without an
    // open tool yet. "Between tools" is live work — Runner-verified cleanup
    // only proves the process died, not that it was idle. Prefer stranding a
    // finished-but-flagged child over archiving a busy one (#2021 Meta).
    // Child running is ACP-published status. Verified completion dual-writes
    // to hub-owned metadata so rewind that drops a terminal cannot orphan a
    // running marker (#2021).
    const childState = ensureChildToolCallStateRebuilt(db, sessionId)
    if (
        childState.open.size > 0
        || childState.openForeground.size > 0
        || childState.runningChildren.size > 0
    ) {
        return true
    }

    const rows = prepareCached(db, `
        SELECT id, content, scheduled_at, invoked_at FROM messages
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
    `).all(sessionId, TOOL_CALL_UPSERT_LOOKBACK) as Array<Pick<DbMessageRow, 'id' | 'content' | 'scheduled_at' | 'invoked_at'>>

    // Lookback-local settled set only — do not copy the unbounded lifetime
    // latch into every derived-work scan. Latched ids are membership-checked
    // below (#2021 ingestion/scan cost).
    // Pass 1: collect ACP/Claude settlements across the whole lookback before
    // deciding any call is open. ACP can emit result then a later start with
    // the same lifetime id in one prompt; DESC order alone would see the
    // pending row first and falsely report live work after a cold rebuild (#2021).
    const settledAcpCallIds = new Set<string>()
    const settledClaudeToolUseIds = new Set<string>()
    for (const row of rows) {
        const decoded = decodeMessageContent(row.content)
        if (isUserMessageRow(decoded)) {
            // Invoked user turn: older rows are a previous turn — stop collecting.
            if (row.invoked_at != null) break
            continue
        }
        const turnCompleteSettled = acpTurnCompleteSettledCallIds(decoded)
        if (turnCompleteSettled.length > 0) {
            for (const callId of turnCompleteSettled) settledAcpCallIds.add(callId)
            continue
        }
        const claudeData = claudeOutputData(decoded)
        if (claudeData !== null) {
            if (isHiddenClaudeOutput(claudeData)) continue
            if (claudeData.type === 'user') {
                collectClaudeToolResultIds(claudeData, settledClaudeToolUseIds)
                continue
            }
            if (claudeData.type === 'result') {
                // Idle Claude ends here — do not decompress the rest of lookback (#2021).
                break
            }
            continue
        }
        const resultCallId = toolCallResultCallId(decoded)
        if (resultCallId !== null) settledAcpCallIds.add(resultCallId)
    }

    // Pass 2: decide open work with the full settled set.
    for (const row of rows) {
        const decoded = decodeMessageContent(row.content)
        // A human turn closes parent-scope work in the lookback window. Child
        // work is handled by the open-child registry above, not this scan.
        // Undispatched scheduled / queued prompts are not turn boundaries.
        if (isUserMessageRow(decoded)) {
            if (row.invoked_at == null) continue
            return false
        }

        const turnCompleteSettled = acpTurnCompleteSettledCallIds(decoded)
        if (turnCompleteSettled.length > 0) continue

        const claudeData = claudeOutputData(decoded)
        if (claudeData !== null) {
            if (isHiddenClaudeOutput(claudeData)) continue
            if (claudeData.type === 'user') {
                if (!collectClaudeToolResultIds(claudeData, settledClaudeToolUseIds)) return false
                continue
            }
            if (claudeData.type === 'result') {
                // Turn-end marker: everything newer was walked already, so the
                // calls of this finished turn are settled. Idle sessions end
                // here, which keeps the sweep's every-tick scan to one row.
                return false
            }
            if (claudeData.type === 'assistant') {
                // Membership only — never copy childState.settled into a new
                // Set per assistant row on the periodic sweep (#2021).
                if (claudeAssistantHasOpenToolUse(claudeData, settledClaudeToolUseIds, settledAcpCallIds, childState.settled)) {
                    return true
                }
            }
            continue
        }

        const resultCallId = toolCallResultCallId(decoded)
        if (resultCallId !== null) continue
        const callId = getToolCallId(decoded)
        if (
            callId !== null
            && !settledAcpCallIds.has(callId)
            && !childState.settled.has(callId)
            && !isTerminalToolCallRow(decoded)
        ) {
            // Child-scoped rows are already covered by the registry; still
            // report them from the scan while they remain in-window.
            return true
        }
    }
    return false
}

/** Merge an incoming tool-call snapshot into a known live row. Shared by the
 *  cache-hit path and the tail-scan path so both produce identical rows. */
function mergeIntoToolCallRow(db: Database, existing: DbMessageRow, content: unknown): UpsertToolCallResult {
    const storedContent = decodeMessageContent(existing.content)
    const mergedContent = truncateOversizedMessageContent(mergeToolCallContent(storedContent, content))
    // A re-emitted tick that changes nothing must not rewrite the row:
    // only observable content changes touch the database.
    if (isDeepStrictEqual(mergedContent, storedContent)) {
        return { message: toStoredMessage(existing), updated: true }
    }
    const encoded = encodeMessageContent(mergedContent)
    // Same in-place content swap as the queued-message edit path
    // (syncNativeQueuedMessage): no new seq, no content_revision bump.
    prepareCached(db, 'UPDATE messages SET content = ? WHERE id = ?').run(encoded, existing.id)
    const row = prepareCached(db, 'SELECT * FROM messages WHERE id = ?').get(existing.id) as DbMessageRow | undefined
    if (!row) throw new Error('Failed to update tool-call message')
    return { message: toStoredMessage(row), updated: true }
}

/** Store one ACP `tool-call` agent message, updating the call's existing row
 *  in place when the same callId is still live in the session tail.
 *
 *  ACP agents re-emit the same call for every state tick; storing each tick as
 *  its own row filled history pages with duplicates the web then folded back
 *  into one card. Updating the single row keeps history pages honest. The
 *  row's id/seq/createdAt/localId never move, so live clients can merge the
 *  rebroadcast by id and stored ordering stays stable. */
export function upsertToolCallMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    callId: string,
    localId?: string,
    createdAt?: number
): UpsertToolCallResult {
    return db.transaction(() => {
        const existing = findLiveToolCallRow(db, sessionId, callId)
        if (!existing) {
            // addMessage notes open-child state for the new row.
            return { message: addMessage(db, sessionId, content, localId, undefined, createdAt), updated: false }
        }
        const storedContent = decodeMessageContent(existing.content)
        const mergedContent = truncateOversizedMessageContent(mergeToolCallContent(storedContent, content))
        // A re-emitted tick that changes nothing must not rewrite the row:
        // only observable content changes touch the database.
        if (isDeepStrictEqual(mergedContent, storedContent)) {
            noteChildToolCallState(db, sessionId, mergedContent)
            return { message: toStoredMessage(existing), updated: true }
        }
        const encoded = encodeMessageContent(mergedContent)
        // Same in-place content swap as the queued-message edit path
        // (syncNativeQueuedMessage): no new seq, no content_revision bump.
        prepareCached(db, 'UPDATE messages SET content = ? WHERE id = ?').run(encoded, existing.id)
        const row = prepareCached(db, 'SELECT * FROM messages WHERE id = ?').get(existing.id) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to update tool-call message')
        noteChildToolCallState(db, sessionId, mergedContent)
        return { message: toStoredMessage(row), updated: true }
    })()
}

/** Shared engines own pending native text. Never overwrite an invoked row. */
export function syncNativeQueuedMessage(db: Database, sessionId: string, localId: string, text: string): StoredMessage {
    return db.transaction(() => {
        const initial = { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli', isNativeQueuedMessage: true } }
        const message = addMessage(db, sessionId, initial, localId)
        if (message.invokedAt !== null) return message
        // Native text edits must not erase Web attachments or origin metadata.
        const prior = z.object({ role: z.literal('user'), content: z.object({ type: z.literal('text') }).passthrough() }).passthrough().safeParse(message.content)
        const content = prior.success ? { ...prior.data, content: { ...prior.data.content, text } } : initial
        const encoded = encodeMessageContent(truncateOversizedMessageContent(content))
        prepareCached(db, 'UPDATE messages SET content = ? WHERE session_id = ? AND local_id = ? AND invoked_at IS NULL')
            .run(encoded, sessionId, localId)
        return { ...message, content }
    })()
}

export function copyMessageToSession(
    db: Database,
    sessionId: string,
    message: CopyStoredMessageInput
): StoredMessage {
    return runInTransaction(db, () => {
        const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
        const nextSeq = getMaxSeq(db, sessionId) + 1

        let localId = message.localId
        if (localId) {
            const collision = prepareCached(db,
                'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
            ).get(sessionId, localId) as { 1: number } | undefined
            if (collision) {
                // 中文注释：重复会话合并时如果 localId 撞车，给复制进目标会话的消息生成一个新 localId，避免误判成同一条已存在消息。
                localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
            }
        }

        if (message.scheduledAt != null && !localId && message.invokedAt === null) {
            // 中文注释：未来计划消息仍需要 ack 路径；异常情况下若源数据缺少 localId，这里补一个稳定可写的新值以保留调度语义。
            localId = `merged-scheduled:${randomUUID()}`
        }

        const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
        const id = randomUUID()
        prepareCached(db, `
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, delivery_state
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @delivery_state
            )
        `).run({
            id,
            session_id: sessionId,
            // Lossless re-encode only — copies move existing history between
            // sessions, so no truncation here even for pre-codec oversized rows.
            content: encodeMessageContent(message.content),
            created_at: createdAt,
            seq: nextSeq,
            local_id: localId ?? null,
            invoked_at: invokedAt ?? null,
            scheduled_at: message.scheduledAt ?? null,
            delivery_state: message.deliveryState ?? 'queued'
        })
        indexMessageContent(db, {
            id,
            sessionId,
            content: message.content,
            seq: nextSeq,
            createdAt,
            invokedAt: invokedAt ?? null
        })

        const row = prepareCached(db, 'SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) {
            throw new Error('Failed to copy message into target session')
        }

        // Copies preserve the source display timestamp, so a new high-seq row can
        // still land behind a Web client's cached composite tail cursor. Mark the
        // target history as structurally changed so incremental readers reset.
        recordUserMessage(db, sessionId, message.content, createdAt)
        bumpMessageEpoch(db, sessionId)
        return toStoredMessage(row)
    })
}
/**
 * Batch-hydrate a fork child: one transaction, contiguous seq allocation,
 * single epoch bump. Avoids O(n) max-seq lookups and epoch writes.
 */
export function copyMessagesToSession(
    db: Database,
    sessionId: string,
    messages: CopyStoredMessageInput[]
): number {
    if (messages.length === 0) return 0

    return db.transaction(() => {
        let nextSeq = getMaxSeq(db, sessionId) + 1
        const insert = prepareCached(db, `
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, delivery_state
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @delivery_state
            )
        `)
        const collisionCheck = prepareCached(db,
            'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        )

        for (const message of messages) {
            const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
            let localId = message.localId
            if (localId) {
                const collision = collisionCheck.get(sessionId, localId) as { 1: number } | undefined
                if (collision) {
                    localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
                }
            }
            if (message.scheduledAt != null && !localId && message.invokedAt === null) {
                localId = `merged-scheduled:${randomUUID()}`
            }
            const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
            const id = randomUUID()
            insert.run({
                id,
                session_id: sessionId,
                content: encodeMessageContent(message.content),
                created_at: createdAt,
                seq: nextSeq,
                local_id: localId ?? null,
                invoked_at: invokedAt ?? null,
                scheduled_at: message.scheduledAt ?? null,
                delivery_state: message.deliveryState ?? 'queued'
            })
            indexMessageContent(db, {
                id,
                sessionId,
                content: message.content,
                seq: nextSeq,
                createdAt,
                invokedAt: invokedAt ?? null
            })
            recordUserMessage(db, sessionId, message.content, createdAt)
            nextSeq += 1
        }

        bumpMessageEpoch(db, sessionId)
        return messages.length
    })()
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = prepareCached(db,
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getAllMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = prepareCached(db,
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMessagesAfterSeq(
    db: Database,
    sessionId: string,
    afterSeq: number
): StoredMessage[] {
    const rows = prepareCached(db,
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
    ).all(sessionId, afterSeq) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** Current seq for a message that still lives on this session (merge-stable id). */
export function getMessageSeqById(
    db: Database,
    sessionId: string,
    messageId: string
): number | null {
    const row = prepareCached(db,
        'SELECT seq FROM messages WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as { seq: number } | undefined
    return row ? row.seq : null
}

export function getMessageById(
    db: Database,
    sessionId: string,
    messageId: string
): StoredMessage | null {
    const row = db.prepare(
        'SELECT * FROM messages WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as DbMessageRow | undefined
    return row ? toStoredMessage(row) : null
}

export function getFirstMessages(
    db: Database,
    sessionId: string,
    limit: number = 50
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50

    const rows = prepareCached(db,
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** CLI reconnect backfill: returns messages above the seq cursor that are
 *  deliverable now, i.e. excludes future-scheduled rows (scheduled_at > now).
 *  Without this filter, a CLI reconnect between schedule time and release time
 *  would replay future-scheduled rows via the normal message stream and the
 *  runner would consume them immediately, bypassing the mature-scan path.
 *  Only the CLI backfill route should use this; the Web thread API still calls
 *  byPosition / getMessages and needs the full set so scheduled rows surface in
 *  the queued floating bar. */
export function getDeliverableMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    now: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = prepareCached(db, `
        SELECT * FROM messages
        WHERE session_id = ?
          AND seq > ?
          AND (scheduled_at IS NULL OR scheduled_at <= ?)
          AND delivery_state = 'queued'
        ORDER BY seq ASC
        LIMIT ?
    `).all(sessionId, safeAfterSeq, now, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** How far back to look for a stream's replaceable snapshots.
 *
 *  The CLI re-sends a growing reasoning buffer every few hundred milliseconds,
 *  so the previous snapshot of a stream is always among the newest rows of its
 *  session. Scanning a bounded tail keeps this off the hot path on sessions
 *  with tens of thousands of messages; anything older than the window is left
 *  alone, which errs toward keeping data. */
const REASONING_SNAPSHOT_LOOKBACK = 50

/** Drop the replaceable snapshots of one reasoning stream.
 *
 *  Only messages explicitly marked live are eligible, and `keepMessageId` is
 *  always spared. Callers run this *after* storing the message that supersedes
 *  them, so the stream never passes through a moment with no row at all — the
 *  two statements are separate transactions, and a crash between them must not
 *  be able to take the whole stream with it. Returns how many rows were
 *  removed. */
export function deleteLiveReasoningSnapshots(
    db: Database,
    sessionId: string,
    streamId: string,
    keepMessageId?: string
): number {
    if (db.inTransaction) {
        invalidateLiveTail(db, sessionId)
        const rows = prepareCached(db, `
            SELECT id, content FROM messages
            WHERE session_id = ?
            ORDER BY seq DESC
            LIMIT ?
        `).all(sessionId, REASONING_SNAPSHOT_LOOKBACK) as Array<Pick<DbMessageRow, 'id' | 'content'>>

        const staleIds = rows
            .filter((row) => row.id !== keepMessageId
                && getLiveReasoningStreamId(decodeMessageContent(row.content)) === streamId)
            .map((row) => row.id)
        if (staleIds.length === 0) return 0

        const placeholders = staleIds.map(() => '?').join(', ')
        const result = prepareCached(db,
            `DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`
        ).run(sessionId, ...staleIds)
        return Number(result.changes)
    }

    const tail = getOrWarmLiveTail(db, sessionId)
    const streamIds = tail.reasoningSnapshots.get(streamId)
    if (!streamIds || streamIds.size === 0) return 0

    const staleIds = Array.from(streamIds).filter((id) => id !== keepMessageId)
    if (staleIds.length === 0) return 0

    const placeholders = staleIds.map(() => '?').join(', ')
    const result = prepareCached(db,
        `DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`
    ).run(sessionId, ...staleIds)

    const staleSet = new Set(staleIds)
    tail.tailRows = tail.tailRows.filter((row) => !staleSet.has(row.id))
    const lookback = Math.max(TOOL_CALL_UPSERT_LOOKBACK, REASONING_SNAPSHOT_LOOKBACK)
    if (tail.tailRows.length < lookback) {
        const oldestSeq = tail.tailRows[0]?.seq ?? (tail.headSeq + 1)
        if (oldestSeq > 1) {
            const olderRows = prepareCached(db, `
                SELECT id, seq, content FROM messages
                WHERE session_id = ? AND seq < ?
                ORDER BY seq DESC
                LIMIT ?
            `).all(sessionId, oldestSeq, lookback - tail.tailRows.length) as Array<Pick<DbMessageRow, 'id' | 'seq' | 'content'>>
            if (olderRows.length > 0) {
                const prefix: TailRowMeta[] = []
                for (let i = olderRows.length - 1; i >= 0; i -= 1) {
                    const row = olderRows[i]!
                    prefix.push(classifyTailRow(row.id, row.seq, decodeMessageContent(row.content)))
                }
                tail.tailRows = [...prefix, ...tail.tailRows]
            }
        }
    }
    rebuildTailIndexes(tail)
    if (tail.headId && staleSet.has(tail.headId)) {
        invalidateLiveTail(db, sessionId)
    }
    return Number(result.changes)
}

/** Drop the replaceable live snapshots of one text stream.
 *
 *  Mirrors the reasoning sweep: the CLI re-sends an open text segment as a
 *  growing `live` snapshot under a stable id on every typing pause, and the
 *  boundary flush re-sends the full text under the same id without the live
 *  marker. Without this sweep every pause >1s left a stale prefix row in the
 *  transcript forever. Plain text messages (no stream id) never match.
 *
 *  This is only called from inside addMessageSweepingLiveSnapshots's
 *  transaction, so it takes the transactional path everywhere: invalidate the
 *  live-tail cache (its indexed ids are about to be deleted) and scan the
 *  same bounded lookback window the reasoning sweep uses. */
export function deleteLiveTextSnapshots(
    db: Database,
    sessionId: string,
    streamId: string,
    keepMessageId?: string
): number {
    if (db.inTransaction) {
        invalidateLiveTail(db, sessionId)
    }
    const rows = prepareCached(db, `
        SELECT id, content FROM messages
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
    `).all(sessionId, REASONING_SNAPSHOT_LOOKBACK) as Array<Pick<DbMessageRow, 'id' | 'content'>>

    const staleIds = rows
        .filter((row) => row.id !== keepMessageId
            && getTextLiveStreamId(decodeMessageContent(row.content)) === streamId)
        .map((row) => row.id)
    if (staleIds.length === 0) return 0

    const placeholders = staleIds.map(() => '?').join(', ')
    const result = prepareCached(db,
        `DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`
    ).run(sessionId, ...staleIds)
    return Number(result.changes)
}

export type AddMessageSweepResult = {
    message: StoredMessage
    /** Discriminates against UpsertToolCallResult at the call site. */
    updated: false
    /** Replaceable live snapshot rows retired by the same transaction. */
    sweptSnapshots: number
}

/** Store a message and retire the live snapshots its streams supersede, in
 *  one transaction (INSERT first, then DELETE).
 *
 *  The CLI streams reasoning and text as growing `live` snapshots under a
 *  stable id; every stored stream message makes the earlier snapshots of
 *  that same id dead weight, and the settled message that closes the stream
 *  is never live so it always survives. Doing both statements in a single
 *  transaction is strictly crash-safer than the previous two-commit sequence
 *  (insert, then sweep): a crash now rolls back both, so the stream cannot
 *  lose its newest row either. */
export function addMessageSweepingLiveSnapshots(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string,
    scheduledAt?: number | null,
    createdAt?: number
): AddMessageSweepResult {
    return db.transaction(() => {
        const message = addMessage(db, sessionId, content, localId, scheduledAt, createdAt)
        let sweptSnapshots = 0
        const reasoningStreamId = getReasoningStreamId(content)
        if (reasoningStreamId !== null) {
            sweptSnapshots += deleteLiveReasoningSnapshots(db, sessionId, reasoningStreamId, message.id)
        }
        const textStreamId = getTextStreamId(content)
        if (textStreamId !== null) {
            sweptSnapshots += deleteLiveTextSnapshots(db, sessionId, textStreamId, message.id)
        }
        return { message, updated: false as const, sweptSnapshots }
    })()
}

/** Paginate messages by COALESCE(invoked_at, created_at) DESC, seq DESC.
 *  Results are returned in ascending display order. */
export function getMessagesByPosition(
    db: Database,
    sessionId: string,
    limit: number,
    before?: MessagePosition
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const beforeClause = before
        ? 'AND (COALESCE(invoked_at, created_at) < @beforeAt OR (COALESCE(invoked_at, created_at) = @beforeAt AND seq < @beforeSeq))'
        : ''
    const rows = prepareCached(db, `
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          ${beforeClause}
        ORDER BY position_at DESC, seq DESC
        LIMIT @limit
    `).all({
        sessionId,
        beforeAt: before?.at ?? null,
        beforeSeq: before?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    // Reverse so results are in ascending display order (oldest first)
    return rows.reverse().map(toStoredMessage)
}

/** Return messages strictly after a display-position cursor in ascending order.
 *  `until`, when supplied, is an inclusive fixed snapshot head so a catch-up
 *  loop does not chase messages appended while it is running. */
export function getMessagesAfterPosition(
    db: Database,
    sessionId: string,
    limit: number,
    after: MessagePosition,
    until?: MessagePosition
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const untilClause = until
        ? `AND (
            COALESCE(invoked_at, created_at) < @untilAt
            OR (COALESCE(invoked_at, created_at) = @untilAt AND seq <= @untilSeq)
        )`
        : ''
    const rows = prepareCached(db, `
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          AND (
            COALESCE(invoked_at, created_at) > @afterAt
            OR (COALESCE(invoked_at, created_at) = @afterAt AND seq > @afterSeq)
          )
          ${untilClause}
        ORDER BY position_at ASC, seq ASC
        LIMIT @limit
    `).all({
        sessionId,
        afterAt: after.at,
        afterSeq: after.seq,
        untilAt: until?.at ?? null,
        untilSeq: until?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export function getNewestMessagePosition(db: Database, sessionId: string): MessagePosition | null {
    const row = prepareCached(db, `
        SELECT COALESCE(invoked_at, created_at) AS position_at, seq
        FROM messages
        WHERE session_id = ?
        ORDER BY position_at DESC, seq DESC
        LIMIT 1
    `).get(sessionId) as { position_at: number; seq: number } | undefined
    return row ? { at: row.position_at, seq: row.seq } : null
}

export function getMessageEpoch(db: Database, sessionId: string): number {
    const row = prepareCached(db,
        'SELECT epoch FROM message_epochs WHERE session_id = ?'
    ).get(sessionId) as { epoch: number } | undefined
    return row?.epoch ?? 0
}

export function bumpMessageEpoch(db: Database, sessionId: string): number {
    invalidateLiveTail(db, sessionId)
    prepareCached(db, `
        INSERT INTO message_epochs (session_id, epoch)
        VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1
    `).run(sessionId)
    return getMessageEpoch(db, sessionId)
}

/** Returns user messages that have a localId but no invoked_at.
 *  Includes future scheduled messages — used to surface all queued messages
 *  (including scheduled) for the Web floating bar on refresh / secondary clients. */
export function getUninvokedLocalMessages(
    db: Database,
    sessionId: string,
    options?: { deliverableOnly?: boolean }
): StoredMessage[] {
    const deliverableClause = options?.deliverableOnly ? " AND delivery_state = 'queued'" : ''
    const rows = prepareCached(db,
        `SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL${deliverableClause} ORDER BY seq ASC`
    ).all(sessionId) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export type LocalMessageState = {
    localId: string
    invokedAt: number | null
    deliveryState?: string | null
}

export function getLocalMessageStates(
    db: Database,
    sessionId: string,
    localIds: string[]
): LocalMessageState[] {
    if (localIds.length === 0) {
        return []
    }
    const placeholders = localIds.map(() => '?').join(', ')
    const rows = prepareCached(db, `
        SELECT local_id, invoked_at, delivery_state
        FROM messages
        WHERE session_id = ? AND local_id IN (${placeholders})
        ORDER BY seq ASC
    `).all(sessionId, ...localIds) as Array<{
        local_id: string
        invoked_at: number | null
        delivery_state: string | null
    }>
    return rows.map((row) => ({
        localId: row.local_id,
        invokedAt: row.invoked_at,
        ...(row.delivery_state && row.delivery_state !== 'queued'
            ? { deliveryState: row.delivery_state }
            : {})
    }))
}

/** Returns scheduled messages across all sessions whose scheduled_at <= beforeTime
 *  and have not yet been invoked.  Used by the hub tick to emit mature messages to CLI.
 *  Ordered by scheduled_at ASC (oldest first). */
export function getMatureScheduledMessages(
    db: Database,
    beforeTime: number
): StoredMessage[] {
    const rows = prepareCached(db,
        "SELECT * FROM messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND invoked_at IS NULL AND delivery_state = 'queued' ORDER BY scheduled_at ASC"
    ).all(beforeTime) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

/** Returns immediate-queued local messages for a session — i.e. rows that have
 *  no scheduled_at (scheduled_at IS NULL).  Used by the session-end sweep
 *  (sweepImmediateQueuedOnSessionEnd): these are messages the user posted to a
 *  CLI session that ended before the runner consumed them, so they cannot ever
 *  be delivered and must be force-invoked to clear the floating bar.
 *
 *  Scoped to role='user' on purpose. Some agent session events (the opencode
 *  compaction ":started" status) also carry a durable localId but have no ack
 *  path — nothing ever flips their invoked_at — so without this scope they
 *  matched "queued prompt" selections forever: the session-end sweep would
 *  force-invoke them at reopen time, restamping their display position
 *  (COALESCE(invoked_at, created_at)) to "now" and resurfacing days-old events
 *  at the bottom of the thread as if they had just arrived. Session events are
 *  already stored and rendered; they are never deliverable prompts and must
 *  keep their original position. The check unwraps role-wrapped envelopes via
 *  unwrapRoleWrappedRecordEnvelope, the same helper the delivery/export paths
 *  use (isQueuedUserMessage), so both sides agree on what a queued user prompt
 *  is even if a row stores the role inside an envelope. It runs on the decoded
 *  content rather than json_extract in SQL because compressed rows store
 *  content as a zstd BLOB, which SQLite's JSON functions reject ("malformed
 *  JSON").
 *
 *  Scheduled rows (scheduled_at IS NOT NULL) are *deliberately excluded*, mature
 *  or not.  The mature-scan path (releaseMatureScheduledMessages) is the sole
 *  emit channel for scheduled rows and it does not write invoked_at — the CLI
 *  ack does.  If the session-end sweep stamped a mature scheduled row as
 *  invoked, a subsequent CLI re-attach would never see the row in the
 *  mature-scan results (it filters on invoked_at IS NULL), and the user's
 *  scheduled prompt would be silently dropped.  See HAPI Bot R4 finding. */
export function getImmediateQueuedLocalMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = prepareCached(db, `
        SELECT * FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND delivery_state = 'queued'
        ORDER BY seq ASC
    `).all(sessionId) as DbMessageRow[]
    return rows.map(toStoredMessage)
        .filter((message) => unwrapRoleWrappedRecordEnvelope(message.content)?.role === 'user')
}

/**
 * Total messages persisted for a session - any role, any state (including
 * future-scheduled and never-invoked queued rows). Used as the
 * "is this session non-trivial?" signal for the cursor migrator's size
 * sanity check; intentionally broad so a session with 6 000 unread agent
 * outputs and zero invoked user turns still counts as non-trivial.
 * tiann/hapi#872.
 */
export function countMessages(db: Database, sessionId: string): number {
    const row = prepareCached(db,
        'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number } | undefined
    return row?.count ?? 0
}

/** Count uninvoked local messages scheduled for a future time (session list indicator). */
export function countFutureScheduledLocalMessages(
    db: Database,
    sessionId: string,
    now: number
): number {
    const row = prepareCached(db, `
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
    `).get(sessionId, now) as { count: number } | undefined
    return row?.count ?? 0
}

/** Batch variant for GET /sessions — one query for all session IDs in a namespace. */
export function countFutureScheduledBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const counts = new Map<string, number>()
    if (sessionIds.length === 0) {
        return counts
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = prepareCached(db, `
        SELECT session_id, COUNT(*) AS count
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; count: number }[]

    for (const row of rows) {
        counts.set(row.session_id, row.count)
    }
    return counts
}

/** Earliest future scheduled_at per session (session-list clock tooltip). */
export function minFutureScheduledAtBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const nextAt = new Map<string, number>()
    if (sessionIds.length === 0) {
        return nextAt
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = prepareCached(db, `
        SELECT session_id, MIN(scheduled_at) AS next_at
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; next_at: number }[]

    for (const row of rows) {
        nextAt.set(row.session_id, row.next_at)
    }
    return nextAt
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = prepareCached(db,
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
}

/** Lowest seq still stored for the session (null when the session is empty). */
export function getMinSeq(db: Database, sessionId: string): number | null {
    const row = db.prepare(
        'SELECT MIN(seq) AS minSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { minSeq: number | null } | undefined
    return row?.minSeq ?? null
}

export type CancelQueuedMessageResult =
    | { status: 'cancelled'; localId: string | null }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'busy'; localId: string }

/** Delete a queued (invoked_at IS NULL) message by session + message id.
 *
 * Runs inside a transaction to eliminate the SELECT-then-DELETE race window.
 * Returns a discriminated union so callers can distinguish two zero-delete cases:
 *   - 'cancelled': row was absent (already cancelled, or wrong id/session) — treat as success.
 *   - 'invoked':   row exists but invoked_at IS NOT NULL (CLI consumed it first) —
 *                  caller must revert any optimistic removal using the returned row,
 *                  not a stale client-side snapshot, so invokedAt is authoritative.
 *
 * The invoked_at IS NULL guard ensures cancel and invoke are mutually exclusive at
 * the DB level (first-write-wins, mirrors markMessagesInvoked). */
export function cancelQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): CancelQueuedMessageResult {
    return db.transaction(() => {
        // Accept either the server-assigned uuid (id) or the client localId.
        // This handles the pre-echo window where the web client still holds
        // msg.id === localId and passes that as the messageId parameter.
        // Note: local_id = ? evaluates to NULL (no match) when local_id IS NULL,
        // which is safe — messages without a localId are inserted with invoked_at set
        // and are never queued, so they cannot reach this code path anyway.
        const row = prepareCached(db, `
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

        if (!row) {
            // Row absent: already cancelled or wrong id — fold into 'cancelled'
            return { status: 'cancelled' as const, localId: null }
        }

        if (row.invoked_at !== null) {
            // CLI already consumed this message before the cancel arrived.
            // Return the full row so the web client can restore authoritative invoked state
            // rather than reverting to a stale queued snapshot (invokedAt: null).
            return { status: 'invoked' as const, message: toStoredMessage(row) }
        }

        const deleted = prepareCached(db, `
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)

        if (deleted.changes > 0) {
            removeMessageContentSearchIndex(db, row.id)
            bumpMessageEpoch(db, sessionId)
        }

        return { status: 'cancelled' as const, localId: row.local_id }
    })()
}

export type LookupQueuedMessageResult =
    | { status: 'absent' }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'queued'; localId: string | null; resolvedId: string; scheduledAt: number | null }
    | { status: 'dispatching'; localId: string | null; resolvedId: string; scheduledAt: number | null }
    | { status: 'indeterminate'; localId: string | null; resolvedId: string; scheduledAt: number | null }

/** Look up a queued message without deleting it.
 *
 * Returns one of three discriminated states:
 *   - 'absent':  row not found (already cancelled or wrong id).
 *   - 'invoked': row exists but invoked_at IS NOT NULL (CLI consumed it first).
 *   - 'queued':  row exists and is cancellable; resolvedId is the server-assigned uuid.
 *
 * Used by the service layer to inspect state before issuing a CLI ack round-trip.
 * The actual DELETE (after CLI ack) is performed by deleteQueuedMessageById. */
export function lookupQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): LookupQueuedMessageResult {
    const row = prepareCached(db, `
        SELECT * FROM messages
        WHERE session_id = ? AND (id = ? OR local_id = ?)
        LIMIT 1
    `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

    if (!row) {
        return { status: 'absent' as const }
    }

    if (row.invoked_at !== null) {
        return { status: 'invoked' as const, message: toStoredMessage(row) }
    }

    if (row.delivery_state === 'dispatching') {
        return { status: 'dispatching' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
    }
    if (row.delivery_state === 'indeterminate') {
        return { status: 'indeterminate' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
    }

    return { status: 'queued' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
}

/** Delete a queued (invoked_at IS NULL) message by id or local_id.
 *
 * This is the "confirmed DELETE" step after the service layer has received a
 * CLI ack with removed:true.  Uses the same first-write-wins guard as the
 * original cancelQueuedMessage. */
/** Claim a durable unknown-delivery row for an explicit retry. */
export function claimIndeterminateMessage(
    db: Database,
    sessionId: string,
    messageId: string
): StoredMessage | null {
    return db.transaction(() => {
        const claimed = prepareCached(db, `
            UPDATE messages
            SET delivery_state = 'dispatching'
            WHERE session_id = ?
              AND (id = ? OR local_id = ?)
              AND invoked_at IS NULL
              AND delivery_state = 'indeterminate'
        `).run(sessionId, messageId, messageId)
        if (claimed.changes === 0) return null
        const updated = prepareCached(db, `
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
              AND invoked_at IS NULL
              AND delivery_state = 'dispatching'
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined
        return updated ? toStoredMessage(updated) : null
    })()
}

export function deleteQueuedMessageById(
    db: Database,
    sessionId: string,
    messageId: string
): boolean {
    return db.transaction(() => {
        const row = prepareCached(db, `
            SELECT id FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
            LIMIT 1
        `).get(sessionId, messageId, messageId) as { id: string } | undefined
        const deleted = prepareCached(db, `
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)
        if (deleted.changes > 0) {
            if (row) removeMessageContentSearchIndex(db, row.id)
            bumpMessageEpoch(db, sessionId)
            return true
        }
        return false
    })()
}
/** Mark messages as invoked at the given server timestamp.
 *  Only updates rows whose local_id is in localIds.
 *  First-write-wins: rows with a non-NULL invoked_at are not updated.  A duplicate
 *  ack (e.g. a CLI re-emit) would otherwise re-stamp the timestamp and shuffle
 *  the message's position in the byPosition-ordered thread. */
export function markMessagesInvoked(
    db: Database,
    sessionId: string,
    localIds: string[],
    invokedAt: number
): number {
    if (localIds.length === 0) return 0
    return runInTransaction(db, () => {
        const placeholders = localIds.map(() => '?').join(', ')
        const changes = prepareCached(db,
            `UPDATE messages
             SET invoked_at = ?, delivery_state = 'queued'
             WHERE session_id = ?
               AND local_id IN (${placeholders})
               AND invoked_at IS NULL`
        ).run(invokedAt, sessionId, ...localIds).changes
        if (changes > 0) {
            const rows = prepareCached(db, `
                SELECT id, session_id, content, created_at, seq, invoked_at
                FROM messages
                WHERE session_id = ? AND local_id IN (${placeholders}) AND invoked_at IS NOT NULL
            `).all(sessionId, ...localIds) as DbMessageRow[]
            for (const row of rows) {
                const decoded = decodeMessageContent(row.content)
                indexMessageContent(db, {
                    id: row.id,
                    sessionId: row.session_id,
                    content: decoded,
                    seq: row.seq,
                    createdAt: row.created_at,
                    invokedAt: row.invoked_at
                })
                // Durable ack path: clear only foreground opens at/before this
                // prompt's seq so newer starts survive (#2021 Major).
                if (isUserMessageRow(decoded)) {
                    const state = childToolCallState(db, sessionId)
                    seedDurableChildToolWorkIfNeeded(db, sessionId, state)
                    clearForegroundAtOrBefore(state, row.seq)
                    writeDurableChildToolWork(db, sessionId, state)
                }
            }
        }
        return changes
    })
}
/** Move an uninvoked steer through its durable delivery states. */
export function setMessagesDeliveryState(
    db: Database,
    sessionId: string,
    localIds: string[],
    state: SteerDeliveryState
): number {
    if (localIds.length === 0) return 0
    const placeholders = localIds.map(() => '?').join(', ')
    const fromStates = state === 'queued'
        ? "'dispatching', 'indeterminate'"
        : state === 'dispatching'
            ? "'queued', 'indeterminate'"
            : "'queued', 'dispatching'"
    return prepareCached(db,
        `UPDATE messages
         SET delivery_state = ?
         WHERE session_id = ?
           AND local_id IN (${placeholders})
           AND invoked_at IS NULL
           AND delivery_state IN (${fromStates})`
    ).run(state, sessionId, ...localIds).changes
}

/** Release confirmation-only state when the owning OpenCode worker ends or is replaced. */
export function markDispatchingMessagesIndeterminate(db: Database, sessionId: string): string[] {
    const rows = prepareCached(db, `
        UPDATE messages SET delivery_state = 'indeterminate'
        WHERE session_id = ? AND delivery_state = 'dispatching'
          AND invoked_at IS NULL AND local_id IS NOT NULL
        RETURNING local_id
    `).all(sessionId) as Array<{ local_id: string }>
    return rows.map(row => row.local_id)
}

/** Hold an ambiguous steer out of automatic replay without claiming delivery. */
export function markMessagesIndeterminate(
    db: Database,
    sessionId: string,
    localIds: string[]
): number {
    return setMessagesDeliveryState(db, sessionId, localIds, 'indeterminate')
}

/** Settle immediate queued rows on an archived clear source without touching
 * scheduled rows, which must remain uninvoked for transfer to the replacement. */
export function markUninvokedImmediateMessages(
    db: Database,
    sessionId: string,
    invokedAt: number
): string[] {
    return runInTransaction(db, () => {
        const rows = prepareCached(db, `
            SELECT local_id FROM messages
            WHERE session_id = ?
              AND local_id IS NOT NULL
              AND scheduled_at IS NULL
              AND invoked_at IS NULL
              AND delivery_state = 'queued'
            ORDER BY seq ASC
        `).all(sessionId) as Array<{ local_id: string }>
        if (rows.length === 0) return []

        prepareCached(db, `
            UPDATE messages
            SET invoked_at = ?
            WHERE session_id = ?
              AND local_id IS NOT NULL
              AND scheduled_at IS NULL
              AND invoked_at IS NULL
              AND delivery_state = 'queued'
        `).run(invokedAt, sessionId)
        const invokedRows = prepareCached(db, `
            SELECT id, session_id, content, created_at, seq, invoked_at
            FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL AND scheduled_at IS NULL AND invoked_at = ?
        `).all(sessionId, invokedAt) as DbMessageRow[]
        for (const row of invokedRows) {
            indexMessageContent(db, {
                id: row.id,
                sessionId: row.session_id,
                content: decodeMessageContent(row.content),
                seq: row.seq,
                createdAt: row.created_at,
                invokedAt: row.invoked_at
            })
        }
        return rows.map((row) => row.local_id)
    })
}
/**
 * Reassign only uninvoked scheduled rows when an archived OpenCode session
 * is replaced by /clear. The transaction preserves ids/localIds so the normal
 * scheduled-message ack path continues on the replacement session.
 */
export function moveUninvokedScheduledMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): number {
    if (fromSessionId === toSessionId) return 0

    const rows = prepareCached(db, `
        SELECT id, content, created_at FROM messages
        WHERE session_id = ?
          AND scheduled_at IS NOT NULL
          AND invoked_at IS NULL
        ORDER BY seq ASC
    `).all(fromSessionId) as Array<{ id: string; content: string | Uint8Array; created_at: number }>
    if (rows.length === 0) return 0

    try {
        db.exec('BEGIN')
        let nextSeq = getMaxSeq(db, toSessionId)
        const update = prepareCached(db, 'UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) {
            nextSeq += 1
            update.run(toSessionId, nextSeq, row.id)
            recordUserMessage(db, toSessionId, decodeMessageContent(row.content), row.created_at)
        }
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        db.exec('COMMIT')
        return rows.length
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Move every still-held prompt to a reserved replacement, preserving FIFO.
 * If both sessions already contain the same non-null localId, the replacement
 * row is authoritative (it represents the retry/new owner) and only the
 * uninvoked source duplicate is discarded.
 */
export function moveUninvokedMessages(db: Database, fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) return 0
    return db.transaction(() => {
        const discarded = prepareCached(db, `
            DELETE FROM messages
            WHERE session_id = ?
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM messages AS target
                  WHERE target.session_id = ?
                    AND target.local_id = messages.local_id
              )
        `).run(fromSessionId, toSessionId).changes
        const rows = prepareCached(db, `
            SELECT id, session_id, content, created_at FROM messages
            WHERE session_id IN (?, ?) AND invoked_at IS NULL
            -- created_at is millisecond-granularity; rowid is the durable
            -- cross-session insertion order for ties within this database.
            ORDER BY created_at ASC,
                     rowid ASC,
                     seq ASC,
                     id ASC
        `).all(fromSessionId, toSessionId) as Array<{ id: string; session_id: string; content: string | Uint8Array; created_at: number }>
        const moved = rows.filter((row) => row.session_id === fromSessionId).length
        if (discarded === 0 && moved === 0) return 0
        const invokedMax = prepareCached(db, `
            SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages
            WHERE session_id = ? AND invoked_at IS NOT NULL
        `).get(toSessionId) as { maxSeq: number }
        let nextSeq = invokedMax.maxSeq
        const update = prepareCached(db, 'UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) {
            update.run(toSessionId, ++nextSeq, row.id)
            recordUserMessage(db, toSessionId, decodeMessageContent(row.content), row.created_at)
        }
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        return discarded + moved
    })()
}

export function mergeSessionMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    const oldMaxSeq = getMaxSeq(db, fromSessionId)
    const newMaxSeq = getMaxSeq(db, toSessionId)

    try {
        db.exec('BEGIN')

        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            prepareCached(db,
                'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
            ).run(oldMaxSeq, toSessionId)
        }

        const collisions = prepareCached(db, `
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

        if (collisions.length > 0) {
            const localIds = collisions.map((row) => row.local_id)
            const placeholders = localIds.map(() => '?').join(', ')
            // Force-invoke the older copy: clearing local_id severs its ack path
            // (markMessagesInvoked matches by local_id), so leaving invoked_at
            // NULL would strand the row in the queued floating bar forever.
            // Use COALESCE so an already-invoked row keeps its server timestamp.
            prepareCached(db,
                `UPDATE messages
                 SET local_id = NULL,
                     invoked_at = COALESCE(invoked_at, created_at)
                 WHERE session_id = ? AND local_id IN (${placeholders})`
            ).run(fromSessionId, ...localIds)
        }

        // Revisions belong to a session, unlike stable message IDs. Translate
        // only unread source outputs above the destination head; already-read
        // history is a baseline and must not light up the destination.
        const source = prepareCached(db, 'SELECT content_revision, read_revision, manual_unread FROM sessions WHERE id = ?')
            .get(fromSessionId) as { content_revision: number; read_revision: number; manual_unread: number }
        const target = prepareCached(db, 'SELECT content_revision FROM sessions WHERE id = ?')
            .get(toSessionId) as { content_revision: number }
        prepareCached(db, `UPDATE messages SET content_revision = CASE WHEN content_revision > ?
            THEN ? + content_revision - ? ELSE 0 END WHERE session_id = ?`)
            .run(source.read_revision, target.content_revision, source.read_revision, fromSessionId)
        const additional = Math.max(0, source.content_revision - source.read_revision)
        prepareCached(db, `UPDATE sessions SET content_revision = content_revision + ?,
            manual_unread = MAX(manual_unread, ?),
            read_state_version = read_state_version + CASE WHEN manual_unread < ? THEN 1 ELSE 0 END WHERE id = ?`)
            .run(additional, source.manual_unread, source.manual_unread, toSessionId)
        const result = prepareCached(db,
            'UPDATE messages SET session_id = ? WHERE session_id = ?'
        ).run(toSessionId, fromSessionId)
        // History moves can keep the source session alive. Retire its old
        // unread state as well, so a second merge cannot count it again.
        prepareCached(db, `UPDATE sessions SET read_revision = content_revision, manual_unread = 0,
            read_state_version = read_state_version + 1 WHERE id = ?
            AND (read_revision < content_revision OR manual_unread = 1)`).run(fromSessionId)

        if (result.changes > 0) {
            rebuildMessageContentSearchForSessions(db, [fromSessionId, toSessionId], true)
            prepareCached(db, `
                UPDATE sessions SET last_user_message_at = MAX(COALESCE(last_user_message_at, 0),
                    (SELECT last_user_message_at FROM sessions WHERE id = ?))
                WHERE id = ? AND (SELECT last_user_message_at FROM sessions WHERE id = ?) IS NOT NULL
            `).run(fromSessionId, toSessionId, fromSessionId)
            bumpMessageEpoch(db, fromSessionId)
            bumpMessageEpoch(db, toSessionId)
        }

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Truncate the invocation-ordered suffix at the boundary identified by seq.
 * Bumps message epoch so web clients reset their window.
 */
/**
 * Truncate OpenCode rewind suffix. Returns harvested settlement evidence so the
 * caller can fold it into the enclosing metadata CAS (must not bump
 * metadata_version here — syncEngine CAS would reject) (#2021).
 */
export function truncateOpenCodeRewind(
    db: Database,
    sessionId: string,
    cutoffSeq: number,
    boundaryId: string,
): { epoch: number; harvestedSettledCallIds: string[]; harvestedSettledChildren: string[] } {
    return db.transaction(() => {
        const target = prepareCached(db, `
            SELECT seq, COALESCE(invoked_at, created_at) AS position_at
            FROM messages WHERE session_id = ? AND id = ? AND seq = ?
        `).get(sessionId, boundaryId, cutoffSeq) as { seq: number; position_at: number } | undefined
        if (!target) throw new Error('Rewind boundary not found')
        const deletedRows = prepareCached(db, `
            SELECT id, content FROM messages WHERE session_id = ? AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
            )
        `).all(sessionId, target.position_at, target.position_at, target.seq) as Array<{ id: string; content: string }>
        // Collect terminal evidence only — do not replay running transitions
        // from deleted rows into the settled registry (#2021).
        const harvestedSettledIds = new Set<string>()
        const harvestedSettledChildren = new Set<string>()
        for (const row of deletedRows) {
            const decoded = decodeMessageContent(row.content)
            const resultCallId = toolCallResultCallId(decoded)
            if (resultCallId) harvestedSettledIds.add(resultCallId)
            for (const id of acpTurnCompleteSettledCallIds(decoded)) harvestedSettledIds.add(id)
            for (const id of acpTurnCompleteRetiredChildSessionIds(decoded)) harvestedSettledChildren.add(id)
            const childStatus = acpTurnCompleteChildStatus(decoded)
            if (
                childStatus
                && (childStatus.status === 'completed'
                    || childStatus.status === 'failed'
                    || childStatus.status === 'interrupted')
            ) {
                harvestedSettledChildren.add(childStatus.childSessionId)
            }
            if (isTerminalToolCallRow(decoded)) {
                const callId = getToolCallId(decoded)
                if (callId) harvestedSettledIds.add(callId)
            }
        }
        prepareCached(db, `
            DELETE FROM messages WHERE session_id = ? AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
            )
        `).run(sessionId, target.position_at, target.position_at, target.seq)
        invalidateMessageContentSearchInjectedTurnCache(db, [sessionId])
        for (const row of deletedRows) removeMessageContentSearchIndex(db, row.id)
        // Drop in-memory child-work state, then latch harvested terminals into
        // durable metadata (callers that CAS afterward must re-read
        // metadata_version). Do not replay deleted running markers (#2021).
        const state = childToolCallState(db, sessionId)
        state.rebuilt = false
        state.durableSeeded = false
        state.open.clear()
        state.openForeground.clear()
        state.openForegroundSeq.clear()
        state.settled.clear()
        state.runningChildren.clear()
        state.settledChildren.clear()
        seedDurableChildToolWorkIfNeeded(db, sessionId, state)
        for (const id of harvestedSettledIds) {
            state.settled.add(id)
            state.open.delete(id)
            clearForegroundCall(state, id)
        }
        for (const id of harvestedSettledChildren) {
            state.settledChildren.add(id)
            state.runningChildren.delete(id)
        }
        latchOpenCodeSettledCallIds(db, sessionId, [...harvestedSettledIds])
        writeDurableChildToolWork(db, sessionId, state)
        state.durableSeeded = true
        prepareCached(db, `UPDATE sessions SET read_revision = content_revision, read_state_version = read_state_version + 1
            WHERE id = ? AND read_revision < content_revision AND NOT EXISTS (
                SELECT 1 FROM messages WHERE session_id = sessions.id AND content_revision > sessions.read_revision
            )`).run(sessionId)
        return {
            epoch: bumpMessageEpoch(db, sessionId),
            harvestedSettledCallIds: [...harvestedSettledIds],
            harvestedSettledChildren: [...harvestedSettledChildren],
        }
    })()
}

export function truncateMessagesFromLocalId(
    db: Database,
    sessionId: string,
    localId: string,
    replacement: Array<{
        content: unknown
        localId?: string | null
        createdAt?: number
        invokedAt?: number | null
    }> = [],
    // Rows created after the rewind was dispatched have a higher seq and
    // must survive a delayed or recovery cut.
    upToSeq: number = Number.MAX_SAFE_INTEGER
): { deleted: number; inserted: number; epoch: number } {
    return db.transaction(() => {
        const target = prepareCached(db, `
            SELECT id, seq, COALESCE(invoked_at, created_at) AS position_at
            FROM messages
            WHERE session_id = ? AND local_id = ?
            LIMIT 1
        `).get(sessionId, localId) as { id: string; seq: number; position_at: number } | undefined

        if (!target) {
            throw new Error(`Message not found for localId: ${localId}`)
        }

        const deletedRows = prepareCached(db, `
            SELECT id FROM messages
            WHERE session_id = ?
              AND seq <= ?
              AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
              )
        `).all(sessionId, upToSeq, target.position_at, target.position_at, target.seq) as Array<{ id: string }>
        const deleted = prepareCached(db, `
            DELETE FROM messages
            WHERE session_id = ?
              AND seq <= ?
              AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
              )
        `).run(sessionId, upToSeq, target.position_at, target.position_at, target.seq)
        invalidateMessageContentSearchInjectedTurnCache(db, [sessionId])
        for (const row of deletedRows) removeMessageContentSearchIndex(db, row.id)

        let inserted = 0
        for (const message of replacement) {
            const now = Date.now()
            const msgSeqRow = prepareCached(db,
                'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
            ).get(sessionId) as { nextSeq: number }
            const id = randomUUID()
            const createdAt = message.createdAt ?? now
            const invokedAt = message.invokedAt === undefined ? createdAt : message.invokedAt
            const rowLocalId = message.localId ?? null
            prepareCached(db, `
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
                id,
                sessionId,
                encodeMessageContent(message.content),
                createdAt,
                msgSeqRow.nextSeq,
                rowLocalId,
                invokedAt
            )
            indexMessageContent(db, {
                id,
                sessionId,
                content: message.content,
                seq: msgSeqRow.nextSeq,
                createdAt,
                invokedAt
            })
            recordUserMessage(db, sessionId, message.content, createdAt)
            inserted += 1
        }

        // If rewind removed all unread output, retire that activity without
        // reusing its revision numbers. Explicit manual-unread survives.
        prepareCached(db, `UPDATE sessions SET read_revision = content_revision, read_state_version = read_state_version + 1
            WHERE id = ? AND read_revision < content_revision AND NOT EXISTS (
                SELECT 1 FROM messages WHERE session_id = sessions.id AND content_revision > sessions.read_revision
            )`).run(sessionId)
        const epoch = bumpMessageEpoch(db, sessionId)
        return { deleted: deleted.changes, inserted, epoch }
    })()
}
