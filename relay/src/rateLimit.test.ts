import { describe, expect, test } from 'bun:test'
import { TokenBucketLimiter } from './rateLimit'

function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
    let nowMs = startMs
    return {
        now: () => nowMs,
        advance: (ms: number) => {
            nowMs += ms
        }
    }
}

describe('TokenBucketLimiter', () => {
    test('allows a burst up to capacity, then denies', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({ capacity: 30, refillPerMinute: 30, now: clock.now })
        for (let i = 0; i < 30; i++) {
            expect(limiter.tryTake('key')).toBe(true)
        }
        expect(limiter.tryTake('key')).toBe(false)
    })

    test('refills continuously at refillPerMinute', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({ capacity: 2, refillPerMinute: 60, now: clock.now })
        expect(limiter.tryTake('key')).toBe(true)
        expect(limiter.tryTake('key')).toBe(true)
        expect(limiter.tryTake('key')).toBe(false)
        clock.advance(1000) // 60/min = 1 token per second
        expect(limiter.tryTake('key')).toBe(true)
        expect(limiter.tryTake('key')).toBe(false)
        clock.advance(500) // half a token - not enough
        expect(limiter.tryTake('key')).toBe(false)
        clock.advance(500)
        expect(limiter.tryTake('key')).toBe(true)
    })

    test('refill is capped at capacity', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({ capacity: 3, refillPerMinute: 60, now: clock.now })
        for (let i = 0; i < 3; i++) {
            expect(limiter.tryTake('key')).toBe(true)
        }
        clock.advance(60 * 60 * 1000) // an hour refills far more than capacity...
        for (let i = 0; i < 3; i++) {
            expect(limiter.tryTake('key')).toBe(true)
        }
        expect(limiter.tryTake('key')).toBe(false) // ...but only capacity is stored
    })

    test('keys are independent', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({ capacity: 1, refillPerMinute: 1, now: clock.now })
        expect(limiter.tryTake('a')).toBe(true)
        expect(limiter.tryTake('a')).toBe(false)
        expect(limiter.tryTake('b')).toBe(true)
    })

    test('the 30/min per-token defaults deny the 31st push in a minute', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({ capacity: 30, refillPerMinute: 30, now: clock.now })
        for (let i = 0; i < 30; i++) {
            expect(limiter.tryTake('token')).toBe(true)
        }
        expect(limiter.tryTake('token')).toBe(false)
        clock.advance(2000) // 30/min = 1 token per 2 seconds
        expect(limiter.tryTake('token')).toBe(true)
        expect(limiter.tryTake('token')).toBe(false)
    })

    test('prunes fully-refilled (idle) keys first, preserving drained state', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({
            capacity: 2,
            refillPerMinute: 60,
            now: clock.now,
            maxKeys: 2
        })
        expect(limiter.tryTake('idle')).toBe(true)
        clock.advance(100)
        expect(limiter.tryTake('hot')).toBe(true)
        expect(limiter.tryTake('hot')).toBe(true)
        clock.advance(2000) // 'idle' fully refills (1 token/s); 'hot' refills too...
        // ...so drain 'hot' again right before the bound is hit: only 'idle'
        // is fully refilled at prune time.
        expect(limiter.tryTake('hot')).toBe(true)
        expect(limiter.tryTake('hot')).toBe(true)
        expect(limiter.tryTake('hot')).toBe(false)
        // Inserting a new key hits maxKeys: 'idle' (fully refilled) is pruned,
        // 'hot' (drained) survives with its drained state intact.
        expect(limiter.tryTake('new')).toBe(true)
        expect(limiter.size).toBe(2)
        expect(limiter.tryTake('hot')).toBe(false)
    })

    test('falls back to LRU eviction when nothing is idle', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({
            capacity: 1,
            refillPerMinute: 0.0001, // effectively no refill in test time
            now: clock.now,
            maxKeys: 2
        })
        expect(limiter.tryTake('a')).toBe(true)
        clock.advance(10)
        expect(limiter.tryTake('b')).toBe(true)
        clock.advance(10)
        // Map is full with two drained keys; inserting 'c' evicts the least
        // recently used ('a').
        expect(limiter.tryTake('c')).toBe(true)
        expect(limiter.size).toBe(2)
        expect(limiter.tryTake('b')).toBe(false) // still tracked, still drained
        expect(limiter.tryTake('a')).toBe(true) // was evicted - budget reset
    })

    test('touching a key refreshes its LRU position', () => {
        const clock = makeClock()
        const limiter = new TokenBucketLimiter({
            capacity: 1,
            refillPerMinute: 0.0001,
            now: clock.now,
            maxKeys: 2
        })
        expect(limiter.tryTake('a')).toBe(true)
        clock.advance(10)
        expect(limiter.tryTake('b')).toBe(true)
        clock.advance(10)
        expect(limiter.tryTake('a')).toBe(false) // denied, but touches 'a' -> 'b' is now LRU
        expect(limiter.tryTake('c')).toBe(true) // evicts 'b'
        expect(limiter.tryTake('a')).toBe(false) // 'a' survived with drained state
    })

    test('rejects nonsense constructor options', () => {
        expect(() => new TokenBucketLimiter({ capacity: 0, refillPerMinute: 1 })).toThrow()
        expect(() => new TokenBucketLimiter({ capacity: 1, refillPerMinute: 0 })).toThrow()
    })
})
