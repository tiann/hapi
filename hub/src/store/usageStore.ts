import type { Database } from 'bun:sqlite'

import {
    getUsageEvents,
    getUsageScanStates,
    recordUsageScan,
    transferUsageSession,
    type UsageEvent,
    type UsageScanState
} from './usage'

export class UsageStore {
    constructor(private readonly db: Database) {}

    recordScan(
        sessionId: string,
        messageEpoch: number,
        lastSeq: number,
        events: UsageEvent[],
        replaceEvents: boolean
    ): void {
        recordUsageScan(this.db, sessionId, messageEpoch, lastSeq, events, replaceEvents)
    }

    getEvents(sessionIds: string[]): UsageEvent[] {
        return getUsageEvents(this.db, sessionIds)
    }

    getScanStates(sessionIds: string[]): Map<string, UsageScanState> {
        return getUsageScanStates(this.db, sessionIds)
    }

    transferSession(fromSessionId: string, toSessionId: string): void {
        transferUsageSession(this.db, fromSessionId, toSessionId)
    }
}
