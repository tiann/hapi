import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    configureSessionReadState, flushSessionReadState, followSessionTail, getSessionLastSeenAt,
    getSessionManualUnreadAt, getUnreadSessionCount, markAllSessionsSeen,
    markSessionSeen, markSessionUnread, observeSessionReadStates,
} from './sessionLastSeen'
import type { SessionReadState, SessionReadStateRequest } from '@hapi/protocol'

const server = (readRevision = 0, version = 0, manualUnread = false): SessionReadState => ({ readRevision, version, manualUnread })
const dormant = () => Promise.reject(new Error('offline'))
let cleanup = () => {}
function offlineScope(scope: string) { cleanup(); cleanup = configureSessionReadState(scope, dormant); cleanup() }

beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    offlineScope('hub-a:alice')
})
afterEach(async () => { cleanup(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); vi.restoreAllMocks() })

describe('durable session read state', () => {
    it('reads persisted state once per synchronous pass instead of once per row', async () => {
        markSessionSeen('s', 2)
        await Promise.resolve()
        const parse = vi.spyOn(JSON, 'parse')
        const getItem = vi.spyOn(Storage.prototype, 'getItem')
        for (let i = 0; i < 500; i += 1) {
            getSessionLastSeenAt('s')
            getSessionManualUnreadAt('s')
        }
        expect(parse).not.toHaveBeenCalled()
        expect(getItem).toHaveBeenCalledTimes(1)
        expect(getSessionLastSeenAt('s')).toBe(2)
    })

    it('observes writes from other tabs or code after the next microtask checkpoint', async () => {
        markSessionSeen('s', 2)
        localStorage.setItem('hapi.sessionReadState.v1:hub-a:alice', JSON.stringify({ s: { server: server(7) } }))
        await Promise.resolve()
        expect(getSessionLastSeenAt('s')).toBe(7)
        localStorage.clear()
        await Promise.resolve()
        expect(getSessionLastSeenAt('s')).toBe(0)
    })

    it('does not keep an unsaved mutation when persistence fails', () => {
        markSessionSeen('s', 2)
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
        markSessionSeen('s', 9)
        expect(getSessionLastSeenAt('s')).toBe(2)
    })

    it('ignores legacy timestamps and metadata-only changes', () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ s: Date.now() }))
        expect(getSessionLastSeenAt('s')).toBe(0)
        expect(getUnreadSessionCount([{ id: 's', contentRevision: 0 }])).toBe(0)
        expect(getUnreadSessionCount([{ id: 's', contentRevision: 1 }])).toBe(1)
    })

    it('persists the exact observed revision monotonically and scopes by hub and namespace', () => {
        markSessionSeen('s', 3)
        markSessionSeen('s', 1)
        expect(getSessionLastSeenAt('s')).toBe(3)
        offlineScope('hub-a:bob')
        expect(getSessionLastSeenAt('s')).toBe(0)
        offlineScope('hub-b:alice')
        expect(getSessionLastSeenAt('s')).toBe(0)
        offlineScope('hub-a:alice')
        expect(getSessionLastSeenAt('s')).toBe(3)
        expect(getUnreadSessionCount([{ id: 's', contentRevision: 4 }])).toBe(1)
    })

    it('merges reads from other clients without allowing a stale response to erase manual unread', () => {
        observeSessionReadStates([{ id: 's', readState: server(3, 2, true) }])
        observeSessionReadStates([{ id: 's', readState: server(2, 1) }])
        markSessionSeen('s', 3, 1)
        expect(getSessionManualUnreadAt('s')).toBe(0)
        markSessionSeen('s', 3, 2)
        expect(getSessionManualUnreadAt('s')).toBeNull()
        expect(getUnreadSessionCount([{ id: 's', contentRevision: 3, readState: server(3, 3, true) }])).toBe(1)
    })

    it('counts running output and hides only a followed tail until it is acknowledged', () => {
        const row = { id: 's', contentRevision: 2, active: true, thinking: true }
        expect(getUnreadSessionCount([row])).toBe(1)
        const release = followSessionTail('s')
        const again = followSessionTail('s')
        expect(getUnreadSessionCount([row])).toBe(0)
        expect(markAllSessionsSeen([row])).toBe(0)
        expect(getSessionLastSeenAt('s')).toBe(0)
        markSessionUnread('s')
        expect(getUnreadSessionCount([row])).toBe(1)
        release()
        again()
        expect(markAllSessionsSeen([row])).toBe(1)
        expect(getSessionLastSeenAt('s')).toBe(2)
        expect(getUnreadSessionCount([{ ...row, contentRevision: 3 }])).toBe(1)
    })

    it('does not claim a read when durable storage fails', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
        markSessionSeen('s', 3)
        expect(getSessionLastSeenAt('s')).toBe(0)
    })

    it('retries the persisted operation and preserves a newer operation during acknowledgement', async () => {
        markSessionSeen('s', 3)
        let resolve!: (value: { readState: SessionReadState }) => void
        const sent: SessionReadStateRequest[] = []
        cleanup = configureSessionReadState('hub-a:alice', async (_id, request) => {
            sent.push({ ...request })
            if (sent.length === 1) return new Promise(r => { resolve = r })
            return { readState: server(request.type === 'read' ? request.readRevision : 0, 2) }
        })
        markSessionSeen('s', 4)
        resolve({ readState: server(3, 1) })
        await vi.advanceTimersByTimeAsync(0)
        await flushSessionReadState()
        expect(sent.map(r => r.type === 'read' ? r.readRevision : null)).toEqual([3, 4])
        expect(getSessionLastSeenAt('s')).toBe(4)
        expect(JSON.parse(localStorage.getItem('hapi.sessionReadState.v1:hub-a:alice')!).s.pending).toBeUndefined()
    })

    it('rolls back a rejected operation to authoritative state', async () => {
        markSessionSeen('s', 9)
        cleanup = configureSessionReadState('hub-a:alice', async () => {
            throw { status: 409, body: JSON.stringify({ readState: server(2, 3, true) }) }
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(getSessionLastSeenAt('s')).toBe(2)
        expect(getSessionManualUnreadAt('s')).toBe(0)
    })
})
