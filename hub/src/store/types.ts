export type StoredSession = {
    id: string
    tag: string | null
    namespace: string
    machineId: string | null
    createdAt: number
    updatedAt: number
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
    id: string
    sessionId: string
    content: unknown
    createdAt: number
    seq: number
    localId: string | null
    invokedAt: number | null
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
     * Required for `ios` rows (PUSH SPEC v1 envelope); always null for
     * phone/wear rows.
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

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }
