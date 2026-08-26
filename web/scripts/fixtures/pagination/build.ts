import { DecryptedMessageSchema } from '@hapi/protocol/schemas'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { FIXTURE_VERSION } from '../fixtureTypes'
import { toCanonicalJson } from '../serialize'
import {
    mergeOpObservations,
    paginationFixtureSessionId,
    runPaginationScript
} from './runner'
import type { PaginationFixtureCase, PaginationFixtureDocument, PaginationOp } from './types'

const MESSAGE_STATUSES = new Set(['queued', 'sending', 'sent', 'failed'])
const PAGE_DIRECTIONS = new Set(['latest', 'before', 'after'])
const PAGE_KEYS = [
    'direction', 'limit', 'epoch', 'reset',
    'nextBeforeAt', 'nextBeforeSeq', 'nextAfterAt', 'nextAfterSeq',
    'snapshotHeadAt', 'snapshotHeadSeq', 'hasMore'
] as const

function fail(label: string, reason: string): never {
    throw new Error(`${label}: ${reason}`)
}

/** Validate a wire DecryptedMessage. The protocol schema gates the required
 *  envelope; on top of it only the client-side `status` extension is allowed
 *  so authored inputs cannot smuggle non-wire keys into fixtures. */
function validateMessage(message: DecryptedMessage, label: string): void {
    const result = DecryptedMessageSchema.safeParse(message)
    if (!result.success) {
        fail(label, `invalid DecryptedMessage: ${result.error.message}`)
    }
    const allowed = new Set([...Object.keys(DecryptedMessageSchema.shape), 'status'])
    for (const key of Object.keys(message)) {
        if (!allowed.has(key)) {
            fail(label, `unexpected DecryptedMessage key '${key}'`)
        }
    }
    if (message.status !== undefined && !MESSAGE_STATUSES.has(message.status)) {
        fail(label, `invalid status '${String(message.status)}'`)
    }
}

function isNullableNumber(value: unknown): boolean {
    return value === null || typeof value === 'number'
}

/** Structural gate for a scripted MessagesResponse (`shared/src/apiTypes.ts`
 *  has no zod schema for it — mirror the wire contract by hand). */
function validateResponse(response: MessagesResponse, label: string): void {
    if (!Array.isArray(response.messages)) {
        fail(label, 'messages must be an array')
    }
    response.messages.forEach((message, index) => validateMessage(message, `${label}.messages[${index}]`))
    const page = response.page as Record<string, unknown>
    if (!page || typeof page !== 'object') {
        fail(label, 'page must be an object')
    }
    for (const key of Object.keys(page)) {
        if (!PAGE_KEYS.includes(key as typeof PAGE_KEYS[number])) {
            fail(label, `unexpected page key '${key}'`)
        }
    }
    if (!PAGE_DIRECTIONS.has(page.direction as string)) fail(label, 'invalid page.direction')
    if (typeof page.limit !== 'number' || !Number.isInteger(page.limit)) fail(label, 'page.limit must be an integer')
    if (typeof page.epoch !== 'number' || !Number.isInteger(page.epoch) || page.epoch < 0) {
        fail(label, 'page.epoch must be a non-negative integer')
    }
    if (typeof page.reset !== 'boolean') fail(label, 'page.reset must be a boolean')
    if (typeof page.hasMore !== 'boolean') fail(label, 'page.hasMore must be a boolean')
    for (const key of ['nextBeforeAt', 'nextBeforeSeq', 'nextAfterAt', 'nextAfterSeq', 'snapshotHeadAt', 'snapshotHeadSeq'] as const) {
        if (!isNullableNumber(page[key])) fail(label, `page.${key} must be a number or null`)
    }
    for (const [atKey, seqKey] of [
        ['nextBeforeAt', 'nextBeforeSeq'],
        ['nextAfterAt', 'nextAfterSeq'],
        ['snapshotHeadAt', 'snapshotHeadSeq']
    ] as const) {
        if ((page[atKey] === null) !== (page[seqKey] === null)) {
            fail(label, `${atKey}/${seqKey} must be paired (both null or both numbers)`)
        }
    }
}

function validateOp(op: PaginationOp, label: string): void {
    switch (op.op) {
        case 'sync-tail':
        case 'fetch-older':
            op.responses.forEach((response, index) => validateResponse(response, `${label}.responses[${index}]`))
            return
        case 'sse-messages':
            op.messages.forEach((message, index) => validateMessage(message, `${label}.messages[${index}]`))
            return
        case 'append-optimistic':
            validateMessage(op.message, `${label}.message`)
            return
        case 'cancel-invoked':
            validateMessage(op.message, `${label}.message`)
            return
        case 'update-status':
        case 'messages-consumed':
        case 'message-cancelled':
        case 'set-view-mode':
        case 'queued-state':
            return
        default: {
            const exhaustive: never = op
            fail(label, `unknown op ${JSON.stringify(exhaustive)}`)
        }
    }
}

export async function buildPaginationFixtureDocument(
    fixtureCase: PaginationFixtureCase
): Promise<PaginationFixtureDocument> {
    // Round-trip the ops through canonical JSON before running, so the
    // expectations are computed from exactly the bytes the file will carry.
    const ops = JSON.parse(toCanonicalJson(fixtureCase.ops)) as PaginationOp[]
    ops.forEach((op, index) => validateOp(op, `${fixtureCase.name}: ops[${index}]`))
    const { observations, expectedState } = await runPaginationScript(
        paginationFixtureSessionId(fixtureCase.name),
        ops
    )
    return {
        fixtureVersion: FIXTURE_VERSION,
        name: fixtureCase.name,
        description: fixtureCase.description,
        ops: mergeOpObservations(ops, observations),
        expectedState
    }
}
