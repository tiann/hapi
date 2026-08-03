import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'hapi:queued-edit-recovery'

async function loadStore() {
    return await import('./queued-edit-recovery')
}

beforeEach(() => {
    sessionStorage.clear()
    vi.resetModules()
})

describe('queued-edit-recovery', () => {
    it('drops invalid persisted schedules and rewrites the sanitized cache', async () => {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
            badPreset: {
                id: 'bad-preset',
                text: 'text',
                pendingSchedule: { type: 'preset', preset: '+99m' },
                composerTextAtEdit: '',
                pendingScheduleAtEdit: null,
            },
            badAbsolute: {
                id: 'bad-absolute',
                text: 'text',
                pendingSchedule: { type: 'absolute', ms: Infinity },
                composerTextAtEdit: '',
                pendingScheduleAtEdit: null,
            },
        }))

        const store = await loadStore()
        expect(store.getQueuedEditRecovery('badPreset')).toBeNull()
        expect(store.getQueuedEditRecovery('badAbsolute')).toBeNull()
        expect(sessionStorage.getItem(STORAGE_KEY)).toBe('{}')
    })

    it('notifies session listeners and returns isolated recovery copies', async () => {
        const store = await loadStore()
        const listener = vi.fn()
        const unsubscribe = store.subscribeQueuedEditRecovery('session-1', listener)

        store.saveQueuedEditRecovery('session-1', {
            text: 'queued edit',
            pendingSchedule: { type: 'preset', preset: '+30m' },
            composerTextAtEdit: 'before edit',
            pendingScheduleAtEdit: null,
        })

        expect(listener).toHaveBeenCalledTimes(1)
        expect(store.isQueuedOperationPending('session-1')).toBe(true)
        expect(store.beginQueuedOperation('session-1')).toBeNull()
        const first = store.getQueuedEditRecovery('session-1')!
        first.pendingSchedule = null
        expect(store.getQueuedEditRecovery('session-1')?.pendingSchedule).toEqual({ type: 'preset', preset: '+30m' })

        unsubscribe()
        store.saveQueuedEditRecovery('session-1', {
            text: 'latest edit',
            pendingSchedule: null,
            composerTextAtEdit: '',
            pendingScheduleAtEdit: null,
        })
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('keeps at most one pending operation per session and token-protects newer work', async () => {
        const store = await loadStore()
        const listener = vi.fn()
        const unsubscribe = store.subscribeQueuedOperation('session-1', listener)
        const first = store.beginQueuedOperation('session-1')

        expect(first).not.toBeNull()
        expect(store.isQueuedOperationPending('session-1')).toBe(true)
        expect(store.beginQueuedOperation('session-1')).toBeNull()
        expect(listener).toHaveBeenCalledTimes(1)

        store.endQueuedOperation('session-1', first!)
        const second = store.beginQueuedOperation('session-1')!
        store.endQueuedOperation('session-1', first!)
        expect(store.isQueuedOperationPending('session-1')).toBe(true)
        store.endQueuedOperation('session-1', second)
        expect(store.isQueuedOperationPending('session-1')).toBe(false)
        expect(listener).toHaveBeenCalledTimes(4)
        unsubscribe()
    })

    it('retains every unconsumed recovery beyond the former session cap', async () => {
        const store = await loadStore()
        for (let index = 0; index <= 50; index++) {
            store.saveQueuedEditRecovery(`session-${index}`, {
                text: String(index),
                pendingSchedule: null,
                composerTextAtEdit: '',
                pendingScheduleAtEdit: null,
            })
        }

        expect(store.getQueuedEditRecovery('session-0')?.text).toBe('0')
        expect(store.getQueuedEditRecovery('session-50')?.text).toBe('50')
    })
})
