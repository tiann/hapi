import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'
import type { PaginationFixtureCase } from './types'

/**
 * Hand-authored window-store scenarios. Positions use small millisecond
 * values (the protocol only compares them); `at = invokedAt ?? createdAt`
 * and every cursor is an (at, seq) pair. Cases avoid position ties so the
 * merge order never depends on the id tie-breaker (web uses localeCompare —
 * keep ids ASCII and positions distinct).
 */

function agentMessage(init: { id: string; seq: number; at: number }): DecryptedMessage {
    return {
        id: init.id,
        seq: init.seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: init.id } }
        },
        createdAt: init.at,
        invokedAt: init.at
    }
}

/** A throttled live snapshot of a reasoning stream: the CLI re-sends the
 *  growing buffer under one stable stream id, so only the newest row of a
 *  stream carries information. `live: false` marks the settled message that
 *  closes the stream. */
function reasoningSnapshot(init: {
    id: string
    seq: number
    at: number
    streamId: string
    text: string
    live?: boolean
}): DecryptedMessage {
    return {
        id: init.id,
        seq: init.seq,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'reasoning',
                    message: init.text,
                    id: init.streamId,
                    ...(init.live === false ? {} : { live: true })
                }
            }
        },
        createdAt: init.at,
        invokedAt: init.at
    }
}

/** A row the chat pipeline hides (normalizes to null): meta system output. */
function hiddenAgentMessage(init: { id: string; seq: number; at: number }): DecryptedMessage {
    return {
        id: init.id,
        seq: init.seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'output', data: { type: 'system', isMeta: true } }
        },
        createdAt: init.at,
        invokedAt: init.at
    }
}

function userMessage(init: {
    id: string
    seq?: number | null
    localId?: string | null
    createdAt: number
    invokedAt?: number | null
    status?: MessageStatus
    text?: string
}): DecryptedMessage {
    return {
        id: init.id,
        seq: init.seq ?? null,
        localId: init.localId ?? null,
        content: {
            role: 'user',
            content: { type: 'text', text: init.text ?? init.id }
        },
        createdAt: init.createdAt,
        ...(init.invokedAt !== undefined ? { invokedAt: init.invokedAt } : {}),
        ...(init.status !== undefined ? { status: init.status } : {})
    }
}

type Position = { at: number; seq: number }

function pageResponse(
    messages: DecryptedMessage[],
    page: {
        direction: 'latest' | 'before' | 'after'
        epoch: number
        hasMore: boolean
        reset?: boolean
        nextBefore?: Position | null
        nextAfter?: Position | null
        snapshotHead?: Position | null
    }
): MessagesResponse {
    return {
        messages,
        page: {
            direction: page.direction,
            limit: 200,
            epoch: page.epoch,
            reset: page.reset ?? false,
            nextBeforeAt: page.nextBefore?.at ?? null,
            nextBeforeSeq: page.nextBefore?.seq ?? null,
            nextAfterAt: page.nextAfter?.at ?? null,
            nextAfterSeq: page.nextAfter?.seq ?? null,
            snapshotHeadAt: page.snapshotHead?.at ?? null,
            snapshotHeadSeq: page.snapshotHead?.seq ?? null,
            hasMore: page.hasMore
        }
    }
}

function paddedAgentRun(fromSeq: number, toSeq: number): DecryptedMessage[] {
    const rows: DecryptedMessage[] = []
    for (let seq = fromSeq; seq <= toSeq; seq += 1) {
        rows.push(agentMessage({ id: `a-${String(seq).padStart(3, '0')}`, seq, at: seq * 1000 }))
    }
    return rows
}

export const paginationFixtureCases: PaginationFixtureCase[] = [
    {
        name: 'latest-page-then-sse-ingest',
        description: 'Cold start: a latest page seeds the window, epoch, older cursor (page.nextBefore) and newest cursor (page.snapshotHead); a live SSE message appends and advances the newest cursor to its position.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([
                        agentMessage({ id: 'a-1', seq: 1, at: 1_000 }),
                        agentMessage({ id: 'a-2', seq: 2, at: 2_000 })
                    ], {
                        direction: 'latest',
                        epoch: 0,
                        hasMore: true,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 2_000, seq: 2 }
                    })
                ]
            },
            {
                op: 'sse-messages',
                messages: [agentMessage({ id: 'a-3', seq: 3, at: 3_000 })]
            }
        ]
    },
    {
        name: 'fetch-older-before-cursor',
        description: 'Older pagination sends the compound (beforeAt, beforeSeq) pair from the current older cursor, prepends the rows, and adopts the response page.nextBefore as the new older cursor and page.hasMore as the exhaustion flag.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([agentMessage({ id: 'a-10', seq: 10, at: 10_000 })], {
                        direction: 'latest',
                        epoch: 4,
                        hasMore: true,
                        nextBefore: { at: 10_000, seq: 10 },
                        snapshotHead: { at: 10_000, seq: 10 }
                    })
                ]
            },
            {
                op: 'fetch-older',
                responses: [
                    pageResponse([agentMessage({ id: 'a-9', seq: 9, at: 9_000 })], {
                        direction: 'before',
                        epoch: 4,
                        hasMore: false,
                        nextBefore: { at: 9_000, seq: 9 }
                    })
                ]
            }
        ]
    },
    {
        name: 'older-page-epoch-mismatch-resets',
        description: 'An older page answering with a different epoch invalidates every cursor: the load stops with epoch-reset, the window is discarded, and a fresh latest request (issued by the store within the same operation) replaces it wholesale.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([agentMessage({ id: 'a-10', seq: 10, at: 10_000 })], {
                        direction: 'latest',
                        epoch: 1,
                        hasMore: true,
                        nextBefore: { at: 10_000, seq: 10 },
                        snapshotHead: { at: 10_000, seq: 10 }
                    })
                ]
            },
            {
                op: 'fetch-older',
                responses: [
                    pageResponse([], {
                        direction: 'before',
                        epoch: 2,
                        hasMore: false,
                        nextBefore: null
                    }),
                    pageResponse([agentMessage({ id: 'f-20', seq: 20, at: 20_000 })], {
                        direction: 'latest',
                        epoch: 2,
                        hasMore: false,
                        nextBefore: { at: 20_000, seq: 20 },
                        snapshotHead: { at: 20_000, seq: 20 }
                    })
                ]
            }
        ]
    },
    {
        name: 'reset-latest-preserves-optimistic',
        description: 'A tail sync that gets page.reset:true replaces every server row from before the request but keeps optimistic rows (id === localId): the not-yet-echoed send survives the epoch bump and the window adopts the new epoch and cursors.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([agentMessage({ id: 'old-1', seq: 1, at: 1_000 })], {
                        direction: 'latest',
                        epoch: 1,
                        hasMore: false,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 1_000, seq: 1 }
                    })
                ]
            },
            {
                op: 'append-optimistic',
                message: userMessage({
                    id: 'local-1',
                    localId: 'local-1',
                    createdAt: 1_500,
                    invokedAt: null,
                    status: 'sending',
                    text: 'optimistic send'
                })
            },
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([agentMessage({ id: 'fresh-2', seq: 2, at: 2_000 })], {
                        direction: 'latest',
                        epoch: 2,
                        hasMore: false,
                        reset: true,
                        nextBefore: { at: 2_000, seq: 2 },
                        snapshotHead: { at: 2_000, seq: 2 }
                    })
                ]
            }
        ]
    },
    {
        name: 'optimistic-echo-reconciles-by-localid',
        description: 'The message-received echo of the caller\'s own send (server id, real seq, same localId) replaces the optimistic row while preserving the client-side status; only one row remains and it is no longer optimistic.',
        ops: [
            {
                op: 'append-optimistic',
                message: userMessage({
                    id: 'local-1',
                    localId: 'local-1',
                    createdAt: 1_000,
                    invokedAt: null,
                    status: 'sending',
                    text: 'hello agent'
                })
            },
            { op: 'update-status', localId: 'local-1', status: 'queued' },
            {
                op: 'sse-messages',
                messages: [
                    userMessage({
                        id: 'srv-1',
                        seq: 1,
                        localId: 'local-1',
                        createdAt: 1_000,
                        invokedAt: null,
                        text: 'hello agent'
                    })
                ]
            }
        ]
    },
    {
        name: 'messages-consumed-stamps-invoked-at',
        description: 'messages-consumed stamps invokedAt and flips status to sent: the row leaves the queued bar and moves to its invocation position (after the agent row), while the newest cursor does NOT advance from this out-of-band update.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([
                        userMessage({
                            id: 'q-1',
                            seq: 1,
                            localId: 'local-1',
                            createdAt: 1_000,
                            invokedAt: null,
                            text: 'queued question'
                        }),
                        agentMessage({ id: 'a-2', seq: 2, at: 2_000 })
                    ], {
                        direction: 'latest',
                        epoch: 0,
                        hasMore: false,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 2_000, seq: 2 }
                    })
                ]
            },
            { op: 'messages-consumed', localIds: ['local-1'], invokedAt: 3_000 }
        ]
    },
    {
        name: 'message-cancelled-removes-queued-row',
        description: 'message-cancelled removes the queued row by localId; a repeat delivery is an idempotent no-op on the already-empty window.',
        ops: [
            {
                op: 'append-optimistic',
                message: userMessage({
                    id: 'local-1',
                    localId: 'local-1',
                    createdAt: 1_000,
                    invokedAt: null,
                    status: 'queued',
                    text: 'cancel me'
                })
            },
            { op: 'message-cancelled', localId: 'local-1' },
            { op: 'message-cancelled', localId: 'local-1' }
        ]
    },
    {
        name: 'cancel-too-late-ingests-invoked-row',
        description: 'DELETE answered status:invoked (the agent consumed the message before the cancel landed): the queued snapshot must NOT be resurrected — the returned authoritative row is ingested with its server invokedAt and client status sent, landing in the thread at its invocation position.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([
                        userMessage({
                            id: 'srv-1',
                            seq: 1,
                            localId: 'local-1',
                            createdAt: 1_000,
                            invokedAt: null,
                            text: 'race with the agent'
                        })
                    ], {
                        direction: 'latest',
                        epoch: 0,
                        hasMore: false,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 1_000, seq: 1 }
                    })
                ]
            },
            {
                op: 'cancel-invoked',
                localId: 'local-1',
                message: userMessage({
                    id: 'srv-1',
                    seq: 1,
                    localId: 'local-1',
                    createdAt: 1_000,
                    invokedAt: 5_000,
                    text: 'race with the agent'
                })
            }
        ]
    },
    {
        name: 'sse-hidden-rows-advance-cursor-only',
        description: 'SSE rows the chat pipeline hides (e.g. meta system output) are not retained in the window, but the newest cursor still advances past their position so a later tail sync does not refetch them.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([agentMessage({ id: 'a-1', seq: 1, at: 1_000 })], {
                        direction: 'latest',
                        epoch: 0,
                        hasMore: false,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 1_000, seq: 1 }
                    })
                ]
            },
            {
                op: 'sse-messages',
                messages: [
                    agentMessage({ id: 'a-2', seq: 2, at: 2_000 }),
                    hiddenAgentMessage({ id: 'hidden-3', seq: 3, at: 3_000 })
                ]
            }
        ]
    },
    {
        name: 'trim-preserves-queued-and-recomputes-cursor',
        description: 'Tail-mode overflow past the 400-row visible window trims the oldest regular rows: queued rows are never trimmed (the regular budget shrinks by their count), hasMore flips true, and the older cursor is recomputed from the oldest kept row.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([
                        ...paddedAgentRun(1, 199),
                        userMessage({
                            id: 'q-200',
                            seq: 200,
                            localId: 'local-q',
                            createdAt: 350_000,
                            invokedAt: null,
                            text: 'still queued'
                        })
                    ], {
                        direction: 'latest',
                        epoch: 0,
                        hasMore: false,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 350_000, seq: 200 }
                    })
                ]
            },
            {
                op: 'sse-messages',
                messages: paddedAgentRun(201, 402)
            }
        ]
    },
    {
        name: 'reasoning-snapshots-collapse-to-newest',
        description: 'A reasoning stream arrives as repeated growing snapshots under one stream id. Only the newest snapshot of each stream survives the window (the timeline folds them into a single block anyway), streams collapse independently, the settled row that closes a stream supersedes its live snapshots, and rows without a stream id are untouched.',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([
                        agentMessage({ id: 'a-1', seq: 1, at: 1_000 }),
                        reasoningSnapshot({ id: 's-1', seq: 2, at: 2_000, streamId: 'stream-a', text: 'th' }),
                        reasoningSnapshot({ id: 's-2', seq: 3, at: 3_000, streamId: 'stream-a', text: 'thin' }),
                        reasoningSnapshot({ id: 's-3', seq: 4, at: 4_000, streamId: 'stream-a', text: 'thinking' }),
                        agentMessage({ id: 'a-2', seq: 5, at: 5_000 }),
                        reasoningSnapshot({ id: 's-4', seq: 6, at: 6_000, streamId: 'stream-b', text: 'more' }),
                        reasoningSnapshot({ id: 's-5', seq: 7, at: 7_000, streamId: 'stream-b', text: 'more still', live: false })
                    ], {
                        direction: 'latest',
                        epoch: 0,
                        hasMore: false,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 7_000, seq: 7 }
                    })
                ]
            },
            {
                op: 'sse-messages',
                messages: [
                    reasoningSnapshot({ id: 's-6', seq: 8, at: 8_000, streamId: 'stream-c', text: 'later' }),
                    reasoningSnapshot({ id: 's-7', seq: 9, at: 9_000, streamId: 'stream-c', text: 'later still' })
                ]
            }
        ]
    },
    {
        name: 'queued-state-reconciliation-drops-deleted',
        description: 'Queued-state recovery after a resume gap: candidates are the user rows with invokedAt strictly null; the server verdict stamps invoked ones like messages-consumed, keeps the still-queued one, and drops candidates in neither list (deleted server-side).',
        ops: [
            {
                op: 'sync-tail',
                responses: [
                    pageResponse([
                        userMessage({
                            id: 'u-1',
                            seq: 1,
                            localId: 'local-stale',
                            createdAt: 1_000,
                            invokedAt: null,
                            text: 'deleted server-side'
                        }),
                        userMessage({
                            id: 'u-2',
                            seq: 2,
                            localId: 'local-kept',
                            createdAt: 2_000,
                            invokedAt: null,
                            text: 'still queued'
                        }),
                        userMessage({
                            id: 'u-3',
                            seq: 3,
                            localId: 'local-consumed',
                            createdAt: 3_000,
                            invokedAt: null,
                            text: 'consumed during the gap'
                        })
                    ], {
                        direction: 'latest',
                        epoch: 0,
                        hasMore: false,
                        nextBefore: { at: 1_000, seq: 1 },
                        snapshotHead: { at: 3_000, seq: 3 }
                    })
                ]
            },
            {
                op: 'queued-state',
                queuedLocalIds: ['local-kept'],
                invoked: [{ localId: 'local-consumed', invokedAt: 4_000 }]
            }
        ]
    }
]
