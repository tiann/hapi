import { describe, expect, it } from 'vitest'
import { calculateServerTimeOffset } from './useMachines'

describe('calculateServerTimeOffset', () => {
    it('uses the request midpoint to compensate for response latency', () => {
        expect(calculateServerTimeOffset(5_000, 1_000, 1_200)).toBe(3_900)
    })

    it('falls back to the local clock when the Hub does not report server time', () => {
        expect(calculateServerTimeOffset(undefined, 1_000, 1_200)).toBe(0)
    })
})
