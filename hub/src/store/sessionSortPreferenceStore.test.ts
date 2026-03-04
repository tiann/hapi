import { describe, expect, it } from 'bun:test'

import { Store } from './index'

describe('SessionSortPreferenceStore', () => {
    it('returns default preference when no row exists', () => {
        const store = new Store(':memory:')

        const preference = store.sessionSortPreferences.getByUser(1, 'alpha')

        expect(preference.sortMode).toBe('auto')
        expect(preference.manualOrder).toEqual({ groupOrder: [], sessionOrder: {} })
        expect(preference.version).toBe(1)
        expect(preference.updatedAt).toBe(0)
    })

    it('persists preference updates for user and namespace', () => {
        const store = new Store(':memory:')

        const result = store.sessionSortPreferences.upsertByUser(
            1,
            'alpha',
            {
                sortMode: 'manual',
                manualOrder: {
                    groupOrder: ['m1::/repo/app'],
                    sessionOrder: {
                        'm1::/repo/app': ['session-1']
                    }
                }
            },
            1
        )

        expect(result.result).toBe('success')
        if (result.result !== 'success') {
            return
        }
        expect(result.preference.version).toBe(2)

        const stored = store.sessionSortPreferences.getByUser(1, 'alpha')
        expect(stored.sortMode).toBe('manual')
        expect(stored.manualOrder.groupOrder).toEqual(['m1::/repo/app'])
        expect(stored.manualOrder.sessionOrder['m1::/repo/app']).toEqual(['session-1'])
        expect(stored.version).toBe(2)
        expect(stored.updatedAt).toBeGreaterThan(0)
    })

    it('returns version mismatch with latest preference', () => {
        const store = new Store(':memory:')

        store.sessionSortPreferences.upsertByUser(
            1,
            'alpha',
            {
                sortMode: 'manual',
                manualOrder: {
                    groupOrder: ['m1::/repo/app'],
                    sessionOrder: {
                        'm1::/repo/app': ['session-1']
                    }
                }
            },
            1
        )

        const mismatch = store.sessionSortPreferences.upsertByUser(
            1,
            'alpha',
            {
                sortMode: 'auto',
                manualOrder: {
                    groupOrder: [],
                    sessionOrder: {}
                }
            },
            1
        )

        expect(mismatch.result).toBe('version-mismatch')
        if (mismatch.result !== 'version-mismatch') {
            return
        }

        expect(mismatch.preference.sortMode).toBe('manual')
        expect(mismatch.preference.version).toBe(2)
    })

    it('returns version mismatch when first write uses stale expected version', () => {
        const store = new Store(':memory:')

        const mismatch = store.sessionSortPreferences.upsertByUser(
            1,
            'alpha',
            {
                sortMode: 'manual',
                manualOrder: {
                    groupOrder: ['m1::/repo/app'],
                    sessionOrder: {
                        'm1::/repo/app': ['session-1']
                    }
                }
            },
            9
        )

        expect(mismatch.result).toBe('version-mismatch')
        if (mismatch.result !== 'version-mismatch') {
            return
        }

        expect(mismatch.preference.sortMode).toBe('auto')
        expect(mismatch.preference.version).toBe(1)
    })
})
