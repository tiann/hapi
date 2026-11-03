import type { Database } from 'bun:sqlite'
import type { SessionReadState, SessionReadStateRequest } from '@hapi/protocol'
import { prepareCached } from './statementCache'

type ReadRow = { content_revision: number; read_revision: number; read_state_version: number; manual_unread: number }
export type ReadStateResult = { status: 'ok' | 'conflict' | 'invalid'; readState: SessionReadState; contentRevision: number }

export function updateSessionReadState(db: Database, sessionId: string, namespace: string, request: SessionReadStateRequest): ReadStateResult | null {
    return db.transaction(() => {
        const row = prepareCached(db, `SELECT content_revision, read_revision, read_state_version, manual_unread
            FROM sessions WHERE id = ? AND namespace = ?`).get(sessionId, namespace) as ReadRow | undefined
        if (!row) return null
        const state: SessionReadState = { readRevision: row.read_revision, version: row.read_state_version, manualUnread: row.manual_unread === 1 }
        const result = (status: ReadStateResult['status']): ReadStateResult => ({ status, readState: state, contentRevision: row.content_revision })
        if (request.type === 'read' && request.readRevision > row.content_revision) return result('invalid')
        if (request.type === 'unread' && request.expectedVersion !== state.version) return result('conflict')

        const readRevision = request.type === 'read' ? Math.max(state.readRevision, request.readRevision) : state.readRevision
        // An older read can advance the watermark, but cannot erase a newer
        // explicit unread operation from a different client.
        const manualUnread = request.type === 'unread' || (state.manualUnread && request.expectedVersion !== state.version)
        if (readRevision === state.readRevision && manualUnread === state.manualUnread) return result('ok')
        prepareCached(db, `UPDATE sessions SET read_revision = ?, manual_unread = ?, read_state_version = read_state_version + 1
            WHERE id = ? AND namespace = ?`).run(readRevision, manualUnread ? 1 : 0, sessionId, namespace)
        state.readRevision = readRevision
        state.manualUnread = manualUnread
        state.version += 1
        return result('ok')
    })()
}
