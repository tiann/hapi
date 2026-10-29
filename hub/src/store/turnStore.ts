import type { Database } from 'bun:sqlite'

import {
    abandonSessionTurnRecovery,
    closeDanglingSessionTurns,
    closeSessionTurn,
    listSessionTurns,
    openSessionTurn,
    resumeInterruptedSessionTurn,
    transferSessionTurns,
    type SessionTurn,
    type SessionTurnEndReason,
    type SessionTurnTrigger
} from './turns'

/** When agents were working: one row per stretch a session was thinking. */
export class TurnStore {
    constructor(private readonly db: Database) {}

    open(sessionId: string, namespace: string, startedAt: number, trigger: SessionTurnTrigger): boolean {
        return openSessionTurn(this.db, sessionId, namespace, startedAt, trigger)
    }

    close(sessionId: string, endedAt: number, reason: SessionTurnEndReason): boolean {
        return closeSessionTurn(this.db, sessionId, endedAt, reason)
    }

    closeDangling(now: number, recoveryWindowMs: number): string[] {
        return closeDanglingSessionTurns(this.db, now, recoveryWindowMs)
    }

    resumeInterrupted(sessionId: string, now: number): boolean {
        return resumeInterruptedSessionTurn(this.db, sessionId, now)
    }

    abandonRecovery(sessionId: string): void {
        abandonSessionTurnRecovery(this.db, sessionId)
    }

    list(namespace: string, since: number, until: number): SessionTurn[] {
        return listSessionTurns(this.db, namespace, since, until)
    }

    transferSession(fromSessionId: string, toSessionId: string, now: number = Date.now()): void {
        transferSessionTurns(this.db, fromSessionId, toSessionId, now)
    }
}
