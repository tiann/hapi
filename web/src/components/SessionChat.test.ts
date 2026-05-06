import { describe, expect, it, vi } from 'vitest'
import { loadOutlineTarget } from '@/components/SessionChat'

describe('loadOutlineTarget', () => {
    it('keeps loading older pages until the target is found', async () => {
        let loaded = false
        const loadMore = vi.fn(async () => {
            loaded = true
        })

        const found = await loadOutlineTarget({
            findTarget: () => (loaded ? document.body : null),
            hasMore: () => !loaded,
            loadMore,
            maxAttempts: 3,
        })

        expect(found).toBe(true)
        expect(loadMore).toHaveBeenCalledTimes(1)
    })

    it('stops when no older pages remain', async () => {
        const loadMore = vi.fn()

        const found = await loadOutlineTarget({
            findTarget: () => null,
            hasMore: () => false,
            loadMore,
        })

        expect(found).toBe(false)
        expect(loadMore).not.toHaveBeenCalled()
    })
})
