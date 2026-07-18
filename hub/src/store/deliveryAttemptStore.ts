import type { Database } from 'bun:sqlite'
import type { DeliveryAttemptState } from '@hapi/protocol'

export type DeliveryAttemptInput = {
    idempotencyKey: string
    namespace: string
    canonicalSessionId: string
    messageId: string
    attemptId: string
    launchNonce: string
    sequence: number
    state: DeliveryAttemptState
    createdAt: number
}

export type StoredDeliveryAttempt = DeliveryAttemptInput & { id: number }

type Row = {
    id: number
    namespace: string
    canonical_session_id: string
    message_id: string
    attempt_id: string
    launch_nonce: string
    sequence: number
    state: DeliveryAttemptState
    created_at: number
    idempotency_key: string
}

const TERMINAL = new Set<DeliveryAttemptState>(['accepted', 'definitive-rejected', 'definitive-no-write', 'ambiguous', 'canceled', 'superseded'])
const BLOCKS_NEW_ATTEMPT = new Set<DeliveryAttemptState>(['accepted', 'definitive-rejected', 'ambiguous', 'canceled', 'superseded'])

function decode(row: Row): StoredDeliveryAttempt {
    return {
        id: row.id, idempotencyKey: row.idempotency_key, namespace: row.namespace, canonicalSessionId: row.canonical_session_id,
        messageId: row.message_id, attemptId: row.attempt_id, launchNonce: row.launch_nonce,
        sequence: row.sequence, state: row.state, createdAt: row.created_at
    }
}

function canTransition(previous: DeliveryAttemptState | null, next: DeliveryAttemptState): boolean {
    if (previous === next) return true
    if (previous === null) return next === 'prepared' || next === 'definitive-no-write' || next === 'canceled' || next === 'superseded'
    if (TERMINAL.has(previous)) return false
    if (previous === 'prepared') return ['written', 'definitive-no-write', 'ambiguous', 'canceled', 'superseded'].includes(next)
    if (previous === 'written') return ['accepted', 'definitive-rejected', 'definitive-no-write', 'ambiguous', 'canceled', 'superseded'].includes(next)
    return false
}

export class DeliveryAttemptStore {
    constructor(private readonly db: Database) {}

    append(input: DeliveryAttemptInput): { result: 'success'; state: DeliveryAttemptState } | { result: 'error'; reason: 'invalid-transition' } {
        const replay = this.db.prepare(`
            SELECT * FROM delivery_attempts WHERE namespace = ? AND idempotency_key = ? LIMIT 1
        `).get(input.namespace, input.idempotencyKey) as Row | undefined
        if (replay) {
            return replay.message_id === input.messageId && replay.attempt_id === input.attemptId && replay.state === input.state
                ? { result: 'success', state: replay.state }
                : { result: 'error', reason: 'invalid-transition' }
        }
        const latestMessage = this.latestMessage(input.namespace, input.canonicalSessionId, input.messageId)
        if (latestMessage && latestMessage.attemptId !== input.attemptId
            && (BLOCKS_NEW_ATTEMPT.has(latestMessage.state) || latestMessage.state === 'written')) {
            return { result: 'error', reason: 'invalid-transition' }
        }
        const latest = this.latest(input.namespace, input.canonicalSessionId, input.messageId, input.attemptId)
        if (!canTransition(latest?.state ?? null, input.state)) return { result: 'error', reason: 'invalid-transition' }
        if (latest?.state === input.state) return { result: 'success', state: input.state }
        this.db.prepare(`
            INSERT INTO delivery_attempts(namespace, canonical_session_id, message_id, attempt_id, launch_nonce, sequence, state, created_at, idempotency_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(input.namespace, input.canonicalSessionId, input.messageId, input.attemptId, input.launchNonce, input.sequence, input.state, input.createdAt, input.idempotencyKey)
        return { result: 'success', state: input.state }
    }

    prepareBatch(inputs: Array<Omit<DeliveryAttemptInput, 'state'>>): { result: 'success' } | { result: 'error'; reason: 'invalid-transition' } {
        const transaction = this.db.transaction(() => {
            for (const input of inputs) {
                const prepared = this.append({ ...input, idempotencyKey: `${input.idempotencyKey}:prepared`, state: 'prepared' })
                if (prepared.result === 'error') throw new Error('invalid-transition')
            }
            for (const input of inputs) {
                const written = this.append({ ...input, idempotencyKey: `${input.idempotencyKey}:written`, state: 'written', createdAt: Math.max(input.createdAt, Date.now()) })
                if (written.result === 'error') throw new Error('invalid-transition')
            }
        })
        try {
            transaction()
            return { result: 'success' }
        } catch {
            return { result: 'error', reason: 'invalid-transition' }
        }
    }

    latest(namespace: string, canonicalSessionId: string, messageId: string, attemptId: string): StoredDeliveryAttempt | null {
        const row = this.db.prepare(`
            SELECT * FROM delivery_attempts WHERE namespace = ? AND canonical_session_id = ? AND message_id = ? AND attempt_id = ?
            ORDER BY id DESC LIMIT 1
        `).get(namespace, canonicalSessionId, messageId, attemptId) as Row | undefined
        return row ? decode(row) : null
    }

    latestMessage(namespace: string, canonicalSessionId: string, messageId: string): StoredDeliveryAttempt | null {
        const row = this.db.prepare(`
            SELECT * FROM delivery_attempts WHERE namespace = ? AND canonical_session_id = ? AND message_id = ?
            ORDER BY id DESC LIMIT 1
        `).get(namespace, canonicalSessionId, messageId) as Row | undefined
        return row ? decode(row) : null
    }

    latestBatch(namespace: string, canonicalSessionId: string, attemptId: string): StoredDeliveryAttempt[] {
        const rows = this.db.prepare(`
            SELECT d.* FROM delivery_attempts d
            JOIN (
                SELECT message_id, MAX(id) AS max_id FROM delivery_attempts
                WHERE namespace = ? AND canonical_session_id = ? AND attempt_id = ? GROUP BY message_id
            ) latest ON latest.max_id = d.id
            ORDER BY d.sequence ASC
        `).all(namespace, canonicalSessionId, attemptId) as Row[]
        return rows.map(decode)
    }

    recoverable(namespace: string, canonicalSessionId: string): StoredDeliveryAttempt[] {
        const rows = this.db.prepare(`
            SELECT d.* FROM delivery_attempts d
            JOIN (
                SELECT message_id, MAX(id) AS max_id FROM delivery_attempts
                WHERE namespace = ? AND canonical_session_id = ? GROUP BY message_id
            ) latest ON latest.max_id = d.id
            ORDER BY d.sequence ASC, d.id ASC
        `).all(namespace, canonicalSessionId) as Row[]
        return rows.map(decode).filter((item) => item.state === 'prepared' || item.state === 'definitive-no-write')
    }

    hasUnresolvedAmbiguous(namespace: string, canonicalSessionId: string): boolean {
        const row = this.db.prepare(`
            SELECT 1 AS found FROM delivery_attempts d
            JOIN (
                SELECT message_id, MAX(id) AS max_id FROM delivery_attempts
                WHERE namespace = ? AND canonical_session_id = ? GROUP BY message_id
            ) latest ON latest.max_id = d.id
            WHERE d.state = 'ambiguous' LIMIT 1
        `).get(namespace, canonicalSessionId) as { found: number } | undefined
        return Boolean(row)
    }
}
