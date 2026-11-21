import type { SessionReadState } from '@hapi/protocol'

export type StoredSession = {
    contentRevision?: number
    readState?: SessionReadState
    id: string
    tag: string | null
    namespace: string
    machineId: string | null
    createdAt: number
    updatedAt: number
    lastUserMessageAt?: number
    pinned: boolean
    globalPinned: boolean
    metadata: unknown | null
    metadataVersion: number
    agentState: unknown | null
    agentStateVersion: number
    model: string | null
    modelReasoningEffort: string | null
    effort: string | null
    serviceTier: string | null
    todos: unknown | null
    todosUpdatedAt: number | null
    teamState: unknown | null
    teamStateUpdatedAt: number | null
    lastNotifyStatus: string | null
    lastNotifyAt: number | null
    lastNotifyNote: string | null
    blockedAckAt: number | null
    blockedAckReason: string | null
    blockedAckKeys: string[] | null
    lastNotifyClearedAt: number | null
    lastNotifyReceivedAt: number | null
    lastNotifyClearedAuthorAt: number | null
    lastNotifyUpdatedAt: number | null
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredMachine = {
    id: string
    namespace: string
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    runnerState: unknown | null
    runnerStateVersion: number
    active: boolean
    activeAt: number | null
    seq: number
}

export type MessageDeliveryState = 'indeterminate'

export type StoredMessage = {
    deliveryPending?: true
    contentRevision?: number
    id: string
    sessionId: string
    content: unknown
    createdAt: number
    seq: number
    localId: string | null
    invokedAt: number | null
    /** Recovered delivery time for BLOCKER RECONCILIATION only — never for
     *  display position, which stays `COALESCE(invokedAt, createdAt)` off
     *  `invokedAt` alone. Set when a session merge recovers a duplicate's
     *  genuine delivery time onto the row that survives, so the recovery
     *  cannot move the row's place in the transcript (#1717 cold-review
     *  round 23). */
    reconciledInvokedAt?: number | null
    /** Whether this row was created by `addImportedMessage`, set once at
     *  insert time. The explicit provenance fact — never infer it from a
     *  clock coincidence; `invokedAt === createdAt` is true for every live
     *  footer too, and `receivedAt === createdAt` can coincide for a
     *  genuine live message (#1717 cold-review round 23). `null` means
     *  UNKNOWN, not "live": a row written before this column existed never
     *  had the fact recorded at all, live or imported — callers that care
     *  fall back to the clock heuristic for exactly that case, matching the
     *  behaviour this hub already shipped for historical data. */
    imported?: boolean | null
    /** Set when the session-end sweep stamped `invokedAt` without a runtime
     *  ACK, so a reply can be told apart from one the agent actually got. */
    sweptAt?: number | null
    /** When the HUB received this message, vs `createdAt`'s runner clock (#1717). */
    receivedAt?: number | null
    /** 1 if the delivery reached the agent, 0 if handled locally, NULL if unknown (#1717). */
    agentDelivered?: number | null
    scheduledAt: number | null
    /** Omitted for ordinary queued/delivered rows; set when steer outcome is unknown. */
    deliveryState?: MessageDeliveryState
}

export type StoredUser = {
    id: number
    platform: string
    platformUserId: string
    namespace: string
    createdAt: number
}

export type StoredPushSubscription = {
    id: number
    namespace: string
    endpoint: string
    p256dh: string
    auth: string
    createdAt: number
}

export type NativeDevicePlatform = 'phone' | 'wear' | 'ios'

export type StoredFcmDevice = {
    id: number
    namespace: string
    /** FCM registration token (phone/wear) or hex APNs device token (ios). */
    token: string
    platform: NativeDevicePlatform
    deviceId: string
    /**
     * base64 of the device-generated 32-byte E2E push encryption key.
     * Required for `ios`, optional for `phone` (relay capable clients),
     * null for legacy phone/Wear registrations.
     */
    pushKey: string | null
    createdAt: number
    updatedAt: number
}

export type StoredScratchlistEntry = {
    sessionId: string
    entryId: string
    text: string
    createdAt: number
    updatedAt: number
    attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
}

export type StoredSessionJob = {
    sessionId: string
    key: string
    label: string
    status: import('@hapi/protocol').AttachedJobStatus
    done?: number
    total?: number
    remaining?: number
    unit?: string
    detail?: string
    runId?: string
    /** Opt-in terminal wake (#1489). */
    wakeOnTerminal: boolean
    wakePrompt?: string
    /** Dedup: runId for which a wake was already claimed. */
    wakeEmittedRunId?: string
    heartbeatAt: number
    startedAt: number
    updatedAt: number
}

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }
