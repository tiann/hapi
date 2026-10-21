import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSelectedSessionSeen } from '@/hooks/useSelectedSessionSeen'
import type { SessionReadMutation, SessionReadState } from '@hapi/protocol'
import type { SessionsResponse } from '@/types/api'
import { ApiError } from '@/api/client'
import { startSessionReadSync, sessionReadScope } from './sessionReadSync'
import { getSessionLastSeenAt, getSessionManualUnreadAt, markAllSessionsSeen, markSessionSeen, markSessionUnread } from './sessionLastSeen'

const scope = JSON.stringify(['http://hub', 'default'])
let sync: ReturnType<typeof startSessionReadSync> | undefined
const state = (version: number, lastSeenAt = 100, manualUnreadAt: number | null = null): SessionReadState =>
    ({ sessionId: 'a', version, lastSeenAt, manualUnreadAt })
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

function mockApi(initial: SessionReadState[] = []) {
    const records = new Map(initial.map(row => [row.sessionId, row]))
    const mutationIds = new Map<string, string>()
    return {
        records,
        getSessions: vi.fn(async (): Promise<SessionsResponse> => ({ sessions: [{ id: 'a', updatedAt: 100 } as SessionsResponse['sessions'][number]] })),
        getSessionReadState: vi.fn(async () => ({ states: [...records.values()] })),
        updateSessionReadState: vi.fn(async (mutations: SessionReadMutation[]) => {
            const acceptedSessionIds: string[] = []
            const states = mutations.flatMap(mutation => {
            const current = records.get(mutation.sessionId)
            if (current && mutationIds.get(mutation.sessionId) === mutation.mutationId) {
                acceptedSessionIds.push(current.sessionId)
                return [current]
            }
            if ((current?.version ?? 0) === mutation.expectedVersion) {
                const next = {
                    sessionId: mutation.sessionId,
                    version: mutation.expectedVersion + 1,
                    lastSeenAt: mutation.kind === 'seen' ? mutation.activityAt : Math.max(0, mutation.activityAt - 1),
                    manualUnreadAt: mutation.kind === 'seen' ? null : mutation.activityAt
                }
                records.set(next.sessionId, next)
                mutationIds.set(next.sessionId, mutation.mutationId)
                acceptedSessionIds.push(next.sessionId)
                return [next]
            }
            return current ? [current] : []
            })
            return { states, acceptedSessionIds }
        })
    }
}
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear() })
afterEach(() => { sync?.stop(); sync = undefined; vi.useRealTimers(); vi.restoreAllMocks() })

describe('Hub read-state synchronization', () => {
    it('starts a fresh snapshot after a connection refresh overlaps an older request', async () => {
        const api = mockApi([state(2, 99, 100)])
        let release!: (value: { states: SessionReadState[] }) => void
        api.getSessionReadState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
        sync = startSessionReadSync(api, scope)
        const connectedRefresh = sync.refresh()
        release({ states: [state(1, 100)] })
        await connectedRefresh
        await tick()
        expect(api.getSessionReadState).toHaveBeenCalledTimes(2)
        expect(getSessionManualUnreadAt('a')).toBe(100)
    })

    it('keeps a fresh intent ordered after a dependent write already in flight', async () => {
        const api = mockApi([state(1, 50)])
        const update = api.updateSessionReadState.getMockImplementation()!
        let release!: () => void
        api.updateSessionReadState.mockImplementationOnce(update).mockImplementationOnce(async mutations => {
            await new Promise<void>(resolve => { release = resolve })
            return update(mutations)
        })
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('a', 100)
        markSessionUnread('a', 100)
        await tick()
        markSessionSeen('a', 100)
        release()
        await tick()
        expect(api.records.get('a')).toMatchObject({ version: 4, lastSeenAt: 100, manualUnreadAt: null })
    })

    it('retains an independent fresh intent when a stale in-flight request is rejected', async () => {
        const api = mockApi([state(1, 50)])
        let release!: (value: { states: SessionReadState[]; acceptedSessionIds: string[] }) => void
        api.updateSessionReadState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('a', 100)
        await tick()
        api.records.set('a', state(2, 99, 100))
        sync.receive([state(2, 99, 100)])
        markAllSessionsSeen([{ id: 'a', updatedAt: 100 }])
        release({ states: [state(2, 99, 100)], acceptedSessionIds: [] })
        await tick()
        expect(api.records.get('a')).toMatchObject({ version: 3, lastSeenAt: 100, manualUnreadAt: null })
    })

    it('preserves a fresh action based on a peer update when an older offline chain is rejected', async () => {
        const api = mockApi([state(1, 50)])
        const update = api.updateSessionReadState.getMockImplementation()!
        api.updateSessionReadState.mockRejectedValue(new TypeError('offline'))
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('a', 100)
        await tick()
        api.records.set('a', state(2, 99, 100))
        sync.receive([state(2, 99, 100)])
        api.updateSessionReadState.mockImplementation(update)
        markAllSessionsSeen([{ id: 'a', updatedAt: 100 }])
        await tick()
        expect(api.records.get('a')).toMatchObject({ version: 3, lastSeenAt: 100, manualUnreadAt: null })
    })

    it('acknowledges the selected session after a deferred Hub snapshot instead of trusting cached readiness', async () => {
        localStorage.setItem(`hapi.sessionReadSync.v1:${scope}`, JSON.stringify({ states: [state(1, 100)] }))
        const api = mockApi([state(2, 99, 100)])
        let release!: (value: { states: SessionReadState[] }) => void
        api.getSessionReadState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
        sync = startSessionReadSync(api, scope)
        const hook = renderHook(() => useSelectedSessionSeen('a', 100))
        try {
            expect(api.updateSessionReadState).not.toHaveBeenCalled()
            await act(async () => { release({ states: [state(2, 99, 100)] }); await tick() })
            expect(api.records.get('a')).toMatchObject({ version: 3, lastSeenAt: 100, manualUnreadAt: null })
            act(() => sync!.receive([state(4, 99, 100)]))
            await tick()
            expect(getSessionManualUnreadAt('a')).toBe(100)
            expect(api.updateSessionReadState).toHaveBeenCalledTimes(1)
        } finally { hook.unmount() }
    })

    it('starts and creates mutations when randomUUID is unavailable on HTTP LAN origins', async () => {
        vi.stubGlobal('crypto', {})
        try {
            const api = mockApi()
            sync = startSessionReadSync(api, scope)
            await tick()
            markSessionUnread('a', 100)
            await tick()
            expect(api.records.get('a')?.manualUnreadAt).toBe(100)
        } finally { vi.unstubAllGlobals() }
    })

    it('recovers an offline action after the tab closes and sessionStorage is discarded', async () => {
        const api = mockApi([state(1, 50)])
        const update = api.updateSessionReadState.getMockImplementation()!
        api.updateSessionReadState.mockRejectedValue(new TypeError('offline'))
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionUnread('a', 100)
        await tick()
        sync.stop()
        sessionStorage.clear()
        api.updateSessionReadState.mockImplementation(update)
        sync = startSessionReadSync(api, scope)
        await tick()
        expect(api.records.get('a')).toMatchObject({ version: 2, manualUnreadAt: 100 })
    })

    it('leaves a live peer queue alone and recovers it only after its owner expires', async () => {
        const prefix = `hapi.sessionReadSync.v1:${scope}`
        localStorage.setItem(`${prefix}:pending:peer`, JSON.stringify([
            { mutationId: 'offline-peer', sessionId: 'a', kind: 'unread', activityAt: 100, expectedVersion: 1 }
        ]))
        localStorage.setItem(`${prefix}:owner:peer`, String(Date.now()))
        const api = mockApi([state(1, 50)])
        sync = startSessionReadSync(api, scope)
        await tick()
        expect(api.updateSessionReadState).not.toHaveBeenCalled()
        expect(localStorage.getItem(`${prefix}:pending:peer`)).not.toBeNull()
        await vi.advanceTimersByTimeAsync(61000)
        expect(api.records.get('a')).toMatchObject({ version: 2, manualUnreadAt: 100 })
        expect(localStorage.getItem(`${prefix}:pending:peer`)).toBeNull()
    })

    it('does not adopt an orphan belonging to another namespace', async () => {
        const otherScope = JSON.stringify(['http://hub', 'other'])
        const key = `hapi.sessionReadSync.v1:${otherScope}:pending:closed`
        localStorage.setItem(key, JSON.stringify([
            { mutationId: 'foreign-action', sessionId: 'a', kind: 'unread', activityAt: 100, expectedVersion: 1 }
        ]))
        const api = mockApi([state(1, 50)])
        sync = startSessionReadSync(api, scope)
        await tick()
        expect(api.updateSessionReadState).not.toHaveBeenCalled()
        expect(localStorage.getItem(key)).not.toBeNull()
    })

    it('retains an orphan source when persisting the recovered copy fails', async () => {
        const key = `hapi.sessionReadSync.v1:${scope}:pending:closed`
        const saved = JSON.stringify([
            { mutationId: 'recover-me', sessionId: 'a', kind: 'unread', activityAt: 100, expectedVersion: 1 }
        ])
        localStorage.setItem(key, saved)
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
        const api = mockApi([state(1, 50)])
        api.updateSessionReadState.mockRejectedValue(new TypeError('offline'))
        sync = startSessionReadSync(api, scope)
        await tick()
        expect(localStorage.getItem(key)).toBe(saved)
    })

    it('loads Hub state instead of promoting a legacy read baseline', async () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ a: 9999 }))
        const api = mockApi([state(2, 99, 100)])
        sync = startSessionReadSync(api, scope)
        await tick()
        expect(getSessionLastSeenAt('a')).toBe(99)
        expect(getSessionManualUnreadAt('a')).toBe(100)
        expect(api.updateSessionReadState).not.toHaveBeenCalled()
    })

    it('synchronizes sequential seen, manual unread, and bulk read actions', async () => {
        const api = mockApi()
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('a', 100)
        markSessionUnread('a', 100)
        await tick()
        expect(api.records.get('a')).toMatchObject({ version: 2, manualUnreadAt: 100 })
        expect(getSessionManualUnreadAt('a')).toBe(100)
        expect(markAllSessionsSeen([{ id: 'a', updatedAt: 100 }, { id: 'b', updatedAt: 200 }])).toBe(2)
        await tick()
        expect(api.records.get('a')).toMatchObject({ lastSeenAt: 100, manualUnreadAt: null, version: 3 })
        expect(api.records.get('b')).toMatchObject({ lastSeenAt: 200 })
    })

    it('ignores out-of-order SSE and snapshots without generating echo writes', async () => {
        const api = mockApi([state(1)])
        sync = startSessionReadSync(api, scope)
        await tick()
        sync.receive([state(3, 99, 100)])
        sync.receive([state(2)])
        await sync.refresh()
        expect(getSessionManualUnreadAt('a')).toBe(100)
        expect(api.updateSessionReadState).not.toHaveBeenCalled()
    })

    it('reconciles stale offline seen against a newer peer unread marker without rebasing', async () => {
        const api = mockApi([state(1, 50)])
        const originalUpdate = api.updateSessionReadState.getMockImplementation()!
        api.updateSessionReadState.mockRejectedValue(new TypeError('offline'))
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('a', 100)
        await tick()
        api.records.set('a', state(2, 99, 100))
        api.updateSessionReadState.mockImplementation(originalUpdate)
        await sync.refresh()
        expect(getSessionManualUnreadAt('a')).toBe(100)
        expect(api.updateSessionReadState.mock.calls.at(-1)?.[0][0]?.expectedVersion).toBe(1)
    })

    it('persists pending actions across a reload and retries lost responses idempotently', async () => {
        const api = mockApi([state(1, 50)])
        const originalUpdate = api.updateSessionReadState.getMockImplementation()!
        api.updateSessionReadState.mockImplementationOnce(async mutations => {
            await originalUpdate(mutations)
            throw new TypeError('response lost')
        })
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionUnread('a', 100)
        await tick()
        sync.stop()
        sync = startSessionReadSync(api, scope)
        await tick()
        expect(api.records.get('a')).toMatchObject({ version: 2, manualUnreadAt: 100 })
        expect(getSessionManualUnreadAt('a')).toBe(100)
        expect(api.updateSessionReadState).toHaveBeenCalledTimes(2)
    })

    it('drops dependent offline operations after a peer version collision', async () => {
        const api = mockApi([state(1, 50)])
        const update = api.updateSessionReadState.getMockImplementation()!
        api.updateSessionReadState.mockRejectedValue(new TypeError('offline'))
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('a', 100)
        markSessionUnread('a', 100)
        markSessionSeen('a', 100)
        await tick()
        api.records.set('a', state(2, 99, 100))
        api.updateSessionReadState.mockImplementation(update)
        await sync.refresh()
        expect(api.records.get('a')).toEqual(state(2, 99, 100))
        expect(getSessionManualUnreadAt('a')).toBe(100)
    })

    it('retries a committed operation after response loss before applying its dependent manual unread', async () => {
        const api = mockApi([state(1, 50)])
        const update = api.updateSessionReadState.getMockImplementation()!
        api.updateSessionReadState.mockImplementationOnce(async mutations => {
            await update(mutations)
            throw new TypeError('response lost')
        })
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('a', 100)
        markSessionUnread('a', 100)
        await tick()
        await sync.refresh()
        expect(api.records.get('a')).toMatchObject({ version: 3, manualUnreadAt: 100 })
        expect(getSessionManualUnreadAt('a')).toBe(100)
    })

    it('imports an explicit legacy unread only for the known default Hub', async () => {
        localStorage.setItem('hapi.sessionLastSeenBaseline.v1:http://hub', '1')
        localStorage.setItem('hapi.sessionManualUnread.v1', JSON.stringify({ a: 100, b: 200 }))
        const api = mockApi()
        sync = startSessionReadSync(api, scope)
        await tick()
        expect(api.updateSessionReadState).toHaveBeenCalledWith([
            { mutationId: expect.any(String), sessionId: 'a', kind: 'import-unread', activityAt: 100, expectedVersion: 0, baseVersion: 0 }
        ])
        sync.stop()
        const other = mockApi()
        sync = startSessionReadSync(other, JSON.stringify(['http://hub', 'other']))
        await tick()
        expect(getSessionManualUnreadAt('a')).toBeNull()
        expect(other.updateSessionReadState).not.toHaveBeenCalled()
    })

    it('discards deleted targets so one failed operation does not block later actions', async () => {
        const api = mockApi()
        api.updateSessionReadState.mockRejectedValueOnce(new ApiError('not found', 404))
        sync = startSessionReadSync(api, scope)
        await tick()
        markSessionSeen('deleted', 100)
        markSessionUnread('a', 100)
        await tick()
        await vi.advanceTimersByTimeAsync(5000)
        expect(api.records.get('a')?.manualUnreadAt).toBe(100)
    })

    it('continues online without localStorage and isolates delayed responses after a Hub switch', async () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
        const api = mockApi([state(1, 50)])
        let release!: (value: { states: SessionReadState[] }) => void
        api.getSessionReadState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
        sync = startSessionReadSync(api, scope)
        sync.stop()
        const other = mockApi([state(2, 70)])
        sync = startSessionReadSync(other, JSON.stringify(['http://other', 'default']))
        await tick()
        release({ states: [state(10, 999)] })
        await tick()
        expect(getSessionLastSeenAt('a')).toBe(70)
        markSessionSeen('a', 100)
        await tick()
        expect(other.records.get('a')?.lastSeenAt).toBe(100)
    })

    it('uses Hub and namespace as identity across JWT refreshes', () => {
        const jwt = (ns: string, exp: number) => `header.${btoa(JSON.stringify({ ns, exp }))}.sig`
        expect(sessionReadScope('hub-a', jwt('default', 1))).toBe(sessionReadScope('hub-a', jwt('default', 2)))
        expect(sessionReadScope('hub-a', jwt('other', 1))).not.toBe(sessionReadScope('hub-a', jwt('default', 1)))
        expect(sessionReadScope('hub-b', jwt('default', 1))).not.toBe(sessionReadScope('hub-a', jwt('default', 1)))
    })
})
