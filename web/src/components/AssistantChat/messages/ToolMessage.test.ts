import { describe, expect, it } from 'vitest'
import { computeTinyImageScale } from './ToolMessage'

describe('computeTinyImageScale', () => {
    it('leaves already-readable images alone', () => {
        expect(computeTinyImageScale(64, 64)).toBe(1)
        expect(computeTinyImageScale(128, 96)).toBe(1)
    })

    it('scales small icons up using the larger side', () => {
        expect(computeTinyImageScale(16, 32)).toBe(2)
        expect(computeTinyImageScale(32, 16)).toBe(2)
    })

    it('does not explode skinny images into huge transforms', () => {
        expect(computeTinyImageScale(1, 1000)).toBe(1)
        expect(computeTinyImageScale(1000, 1)).toBe(1)
    })

    it('rejects non-positive dimensions', () => {
        expect(computeTinyImageScale(0, 32)).toBe(1)
        expect(computeTinyImageScale(32, -1)).toBe(1)
    })
})
