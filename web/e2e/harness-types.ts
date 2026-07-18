export type MessageWindowScenario = 'tool-dense' | 'history' | 'single-row-history' | 'live-cap' | 'ten-thousand'

export type MessageWindowPageRequest = {
    beforeSeq: number | null
    afterSeq: number | null
    limit: number
    responseCount: number
    startComplete: boolean
    endComplete: boolean
}

export type MessageWindowHarnessSnapshot = {
    rawCount: number
    pendingCount: number
    blockCount: number
    firstSeq: number | null
    lastSeq: number | null
    sequences: number[]
    duplicateCount: number
    gaps: Array<{ afterSeq: number; beforeSeq: number }>
    hasOlder: boolean
    hasNewer: boolean
    atBottom: boolean
    pageRequests: MessageWindowPageRequest[]
    sseConnected: boolean
    sseSubscriptionId: string | null
    sseEmittedCount: number
    sseReceivedCount: number
}

export type MessageWindowHarnessApi = {
    snapshot: () => Promise<MessageWindowHarnessSnapshot>
    loadScenario: (scenario: MessageWindowScenario) => Promise<void>
    prepareReconnect: () => void
    disconnectSse: () => void
    reviewAndStream: (count: number) => Promise<{
        sameVisibleReference: boolean
        sameVisibleOrder: boolean
    }>
    streamAtLiveBottom: (count: number, options?: { newTurns?: boolean }) => Promise<void>
    returnToLatest: () => Promise<void>
    ready: () => Promise<void>
}

declare global {
    interface Window {
        hapiE2E: MessageWindowHarnessApi
    }
}
