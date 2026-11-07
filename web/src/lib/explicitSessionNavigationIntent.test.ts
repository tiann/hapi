import { describe, expect, it } from 'vitest'
import { consumeExplicitSessionNavigationIntent, markExplicitSessionNavigationIntent } from './explicitSessionNavigationIntent'

describe('explicitSessionNavigationIntent', () => {
    it('defaults to false when nothing has marked it', () => {
        expect(consumeExplicitSessionNavigationIntent()).toBe(false)
    })

    it('reports true exactly once after marking, then resets', () => {
        markExplicitSessionNavigationIntent()
        expect(consumeExplicitSessionNavigationIntent()).toBe(true)
        expect(consumeExplicitSessionNavigationIntent()).toBe(false)
    })

    it('consuming without marking never flips it true on its own', () => {
        expect(consumeExplicitSessionNavigationIntent()).toBe(false)
        expect(consumeExplicitSessionNavigationIntent()).toBe(false)
    })
})
