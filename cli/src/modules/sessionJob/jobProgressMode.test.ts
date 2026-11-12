import { describe, expect, it } from 'vitest'
import { SessionJobError } from './sessionJob'
import {
    assertCreateProgressMode,
    assertNumericSleepUsesUntil,
    commandLooksLikeNumericSleep,
    parseUntilTimestamp,
    stampUntilProgress
} from './jobProgressMode'

describe('commandLooksLikeNumericSleep', () => {
    it('detects sleep N and rejects infinity / bare sleep', () => {
        expect(commandLooksLikeNumericSleep(['sleep', '150747'])).toBe(true)
        expect(commandLooksLikeNumericSleep(['/bin/sleep', '60'])).toBe(true)
        expect(commandLooksLikeNumericSleep(['sleep', '999999'])).toBe(true)
        expect(commandLooksLikeNumericSleep(['sleep', 'infinity'])).toBe(false)
        expect(commandLooksLikeNumericSleep(['sleep'])).toBe(false)
        expect(commandLooksLikeNumericSleep(['./beets-import.sh'])).toBe(false)
    })
})

describe('assertNumericSleepUsesUntil', () => {
    it('refuses numeric sleep under unknown (dogfootgun)', () => {
        expect(() => assertNumericSleepUsesUntil('unknown', ['sleep', '150747']))
            .toThrow(/--progress until/)
        expect(() => assertNumericSleepUsesUntil('fraction', ['sleep', '60']))
            .toThrow(/--progress until/)
        expect(() => assertNumericSleepUsesUntil('until', ['sleep', '150747']))
            .not.toThrow()
        expect(() => assertNumericSleepUsesUntil('unknown', ['sleep', 'infinity']))
            .not.toThrow()
    })
})


describe('assertCreateProgressMode', () => {
    it('requires --progress on create', () => {
        expect(() => assertCreateProgressMode('run', {})).toThrow(/requires --progress/)
        expect(() => assertCreateProgressMode('set', {})).toThrow(/requires --progress/)
    })

    it('unknown forbids count and until fields', () => {
        expect(() => assertCreateProgressMode('run', {
            progress: 'unknown',
            remaining: 1
        })).toThrow(/forbids/)
        expect(() => assertCreateProgressMode('run', {
            progress: 'unknown',
            untilMs: Date.now() + 60_000
        })).toThrow(/forbids/)
        expect(() => assertCreateProgressMode('run', { progress: 'unknown' })).not.toThrow()
    })

    it('fraction requires a remaining+total or done+total pair', () => {
        expect(() => assertCreateProgressMode('set', {
            progress: 'fraction',
            remaining: 10
        })).toThrow(/requires --remaining N --total M/)
        expect(() => assertCreateProgressMode('set', {
            progress: 'fraction',
            remaining: 10,
            total: 100
        })).not.toThrow()
        expect(() => assertCreateProgressMode('set', {
            progress: 'fraction',
            done: 3,
            total: 10
        })).not.toThrow()
    })

    it('until requires --until and forbids manual counts', () => {
        expect(() => assertCreateProgressMode('run', { progress: 'until' }))
            .toThrow(/requires --until/)
        expect(() => assertCreateProgressMode('run', {
            progress: 'until',
            untilMs: Date.now() + 60_000,
            remaining: 1
        })).toThrow(/derives remaining\/total/)
        expect(() => assertCreateProgressMode('run', {
            progress: 'until',
            untilMs: Date.now() + 60_000
        })).not.toThrow()
    })
})

describe('parseUntilTimestamp', () => {
    it('parses ISO and rejects past', () => {
        const now = Date.parse('2026-11-08T03:00:00.000Z')
        expect(parseUntilTimestamp('2026-11-09T21:20:14.000Z', now))
            .toBe(Date.parse('2026-11-09T21:20:14.000Z'))
        expect(() => parseUntilTimestamp('2026-11-07T00:00:00.000Z', now))
            .toThrow(SessionJobError)
    })

    it('parses relative durations (+5m, 300s, 1h)', () => {
        const now = 1_000_000
        expect(parseUntilTimestamp('+5m', now)).toBe(now + 5 * 60 * 1000)
        expect(parseUntilTimestamp('300s', now)).toBe(now + 300 * 1000)
        expect(parseUntilTimestamp('+1h', now)).toBe(now + 3600 * 1000)
        expect(parseUntilTimestamp('2d', now)).toBe(now + 2 * 86400 * 1000)
    })
})

describe('stampUntilProgress', () => {
    it('stamps remaining/total in seconds from until and start', () => {
        const start = Date.parse('2026-11-07T21:20:14.000Z')
        const until = Date.parse('2026-11-09T21:20:14.000Z')
        const mid = Date.parse('2026-11-08T21:20:14.000Z')
        const stamped = stampUntilProgress(until, mid, start)
        expect(stamped.unit).toBe('s')
        expect(stamped.total).toBe(172_800)
        expect(stamped.remaining).toBe(86_400)
    })

    it('clamps remaining to total when now is before window start', () => {
        const start = Date.parse('2026-11-08T00:00:00.000Z')
        const until = Date.parse('2026-11-09T00:00:00.000Z')
        const before = Date.parse('2026-11-07T00:00:00.000Z')
        const stamped = stampUntilProgress(until, before, start)
        expect(stamped.total).toBe(86_400)
        expect(stamped.remaining).toBe(86_400)
    })
})
