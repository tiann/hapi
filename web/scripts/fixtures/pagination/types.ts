import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'

/** Exact argument object the store passed to `getMessages` (canonicalized:
 *  sorted keys, `undefined` entries stripped, `null` entries preserved). */
export type PageRequest = Record<string, number | null>

/** Projection of `fetchOlderMessages`' outcome. `historyVersion` (a web
 *  render counter) is dropped; `failed` outcomes are never scripted. */
export type ProjectedOlderOutcome =
    | { kind: 'applied'; hasMore: boolean; addedRenderableCount: number }
    | { kind: 'stopped'; reason: 'unavailable' | 'busy' | 'invalidated' | 'epoch-reset' | 'exhausted' }

/**
 * One scripted operation against the message-window store. Fields named
 * `expected*` are machine-generated observations of the real web store —
 * absent from hand-authored cases, present in the emitted document.
 */
export type PaginationOp =
    | {
        /** Run a full tail sync (`syncTailMessages`). `responses` feed the
         *  scripted ApiClient in order; every response must be consumed. */
        op: 'sync-tail'
        responses: MessagesResponse[]
        expectedRequests?: PageRequest[]
    }
    | {
        /** Load one older page (`fetchOlderMessages`). On an epoch mismatch
         *  the store runs an internal tail sync, whose responses (and
         *  recorded requests) belong to this same op. */
        op: 'fetch-older'
        responses: MessagesResponse[]
        expectedRequests?: PageRequest[]
        expectedOutcome?: ProjectedOlderOutcome
    }
    | {
        /** SSE `message-received` delivery (`ingestIncomingMessages`). */
        op: 'sse-messages'
        messages: DecryptedMessage[]
    }
    | {
        /** Local optimistic send append (`appendOptimisticMessage`). The
         *  message is optimistic iff `id === localId`. */
        op: 'append-optimistic'
        message: DecryptedMessage
    }
    | {
        /** Client-side send-state transition (`updateMessageStatus`). */
        op: 'update-status'
        localId: string
        status: MessageStatus
    }
    | {
        /** SSE `messages-consumed` event (`markMessagesConsumed`). */
        op: 'messages-consumed'
        localIds: string[]
        invokedAt: number
    }
    | {
        /** SSE `message-cancelled` event, or the optimistic removal before a
         *  DELETE (`removeOptimisticMessage`; matches localId OR id). */
        op: 'message-cancelled'
        localId: string
    }
    | {
        /** Client handling of a DELETE answered `{"status":"invoked"}`:
         *  remove the queued row by localId, then re-ingest the returned
         *  authoritative message with client status `sent` (the harness adds
         *  the status, mirroring the web mutation). */
        op: 'cancel-invoked'
        localId: string
        message: DecryptedMessage
    }
    | {
        /** Switch view mode (`setMessageViewMode`). */
        op: 'set-view-mode'
        mode: 'tail' | 'history'
    }
    | {
        /** Queued-state recovery round trip after a `resume: 'gap'`:
         *  candidates are collected from the window
         *  (`getQueuedReconcileCandidateLocalIds` — pinned in
         *  `expectedCandidates`), the scripted server verdict is applied via
         *  `markMessagesConsumed` per invoked entry, then
         *  `reconcileQueuedLocalIds` drops candidates in neither list. */
        op: 'queued-state'
        queuedLocalIds: string[]
        invoked: Array<{ localId: string; invokedAt: number }>
        expectedCandidates?: string[]
    }

/** Observation of one executed op, recorded from the real store. */
export type PaginationOpObservation = {
    requests?: PageRequest[]
    outcome?: ProjectedOlderOutcome
    candidates?: string[]
}

/** Normative projection of one window row. `invokedAt` / `scheduledAt`
 *  mirror the wire tri-state (absent / null / number); `status` is the
 *  client-side optimistic send state when present. `queued` and `optimistic`
 *  are the derived predicates natives must reproduce. */
export type ProjectedWindowMessage = {
    id: string
    localId: string | null
    seq: number | null
    createdAt: number
    invokedAt?: number | null
    scheduledAt?: number | null
    status?: MessageStatus
    queued: boolean
    optimistic: boolean
}

/** Normative projection of the window state after all ops. The cursors are
 *  the store's compound paging positions: `olderCursor` feeds the next
 *  before-request, `newestCursor` the next after-request. */
export type ProjectedWindowState = {
    messages: ProjectedWindowMessage[]
    hasMore: boolean
    epoch: number | null
    viewMode: 'tail' | 'history'
    olderCursor: { at: number; seq: number } | null
    newestCursor: { at: number; seq: number } | null
}

/**
 * A hand-authored pagination case: op scripts with wire-shaped inputs only.
 * The emitted document carries the same ops with `expected*` observations
 * filled in, plus the final `expectedState` — all machine-generated by
 * driving the real web store.
 */
export type PaginationFixtureCase = {
    /** Kebab-case name; becomes shared/fixtures/pagination/<name>.json */
    name: string
    description: string
    ops: PaginationOp[]
}

export type PaginationFixtureDocument = {
    fixtureVersion: number
    name: string
    description: string
    ops: PaginationOp[]
    expectedState: ProjectedWindowState
}
