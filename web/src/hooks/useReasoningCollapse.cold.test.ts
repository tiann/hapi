import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

const STORAGE_KEY = 'hapi-reasoning-collapsed'

describe('useReasoningCollapse cold load', () => {
    afterEach(() => {
        cleanup()
        window.localStorage.clear()
    })

    it('hydrates the stored preference before the first render', async () => {
        window.localStorage.setItem(STORAGE_KEY, 'true')
        const { useReasoningCollapse } = await import('./useReasoningCollapse')
        const renderedSnapshots: boolean[] = []

        const { result } = renderHook(() => {
            const { reasoningCollapsed } = useReasoningCollapse()
            renderedSnapshots.push(reasoningCollapsed)
            return reasoningCollapsed
        })

        expect(renderedSnapshots[0]).toBe(true)
        expect(result.current).toBe(true)
    })
})
