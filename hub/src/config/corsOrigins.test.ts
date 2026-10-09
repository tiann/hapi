import { describe, expect, it } from 'bun:test'
import {
    deriveCorsOrigins,
    mergeCorsOrigins,
    normalizeOrigin,
    normalizeOrigins,
    parseCorsOriginsEnv
} from './corsOrigins'

describe('normalizeOrigin', () => {
    it('normalizes scheme-less and trailing-slash values to an origin', () => {
        expect(normalizeOrigin('https://app.example.com/')).toBe('https://app.example.com')
        expect(normalizeOrigin('hub.example.com')).toBe('https://hub.example.com')
        expect(normalizeOrigin('  https://app.example.com:8443/path  ')).toBe('https://app.example.com:8443')
    })

    it('rejects values that cannot be origins', () => {
        expect(normalizeOrigin('not a url')).toBeNull()
        expect(normalizeOrigin('ftp://app.example.com')).toBeNull()
        expect(normalizeOrigin('*')).toBeNull()
        expect(normalizeOrigin('null')).toBeNull()
        expect(normalizeOrigin(' NULL ')).toBeNull()
        expect(normalizeOrigin('')).toBeNull()
    })
})

describe('normalizeOrigins', () => {
    it('normalizes, dedupes and reports dropped entries', () => {
        const result = normalizeOrigins([
            'https://app.example.com/',
            'app.example.com',
            'ftp://other.example.com',
            'not a url'
        ])
        expect(result.origins).toEqual(['https://app.example.com'])
        expect(result.dropped).toEqual(['ftp://other.example.com', 'not a url'])
        expect(result.repaired).toEqual([
            { from: 'https://app.example.com/', to: 'https://app.example.com' },
            { from: 'app.example.com', to: 'https://app.example.com' }
        ])
    })

    it('reports the opaque null origin as dropped', () => {
        expect(normalizeOrigins(['null'])).toEqual({
            origins: [],
            dropped: ['null'],
            repaired: []
        })
    })

    it('short-circuits to allow-all when a wildcard is present', () => {
        expect(normalizeOrigins(['*', 'not a url'])).toEqual({ origins: ['*'], dropped: [], repaired: [] })
    })
})

describe('parseCorsOriginsEnv', () => {
    it('splits, trims and drops empty entries', () => {
        expect(parseCorsOriginsEnv(' https://a.example.com , hub-b.example.com ,, '))
            .toEqual(['https://a.example.com', 'hub-b.example.com'])
    })
})

describe('deriveCorsOrigins', () => {
    it('derives the origin from a normalized public URL', () => {
        expect(deriveCorsOrigins('https://hub.example.com')).toEqual(['https://hub.example.com'])
        expect(deriveCorsOrigins('https://hub.example.com/base')).toEqual(['https://hub.example.com'])
    })

    it('returns an empty list for values that cannot be hub URLs', () => {
        expect(deriveCorsOrigins('not a url')).toEqual([])
    })
})

describe('mergeCorsOrigins', () => {
    it('merges and dedupes both lists', () => {
        expect(mergeCorsOrigins(
            ['https://a.example.com'],
            ['https://a.example.com', 'https://b.example.com']
        )).toEqual(['https://a.example.com', 'https://b.example.com'])
    })

    it('keeps the wildcard short-circuit', () => {
        expect(mergeCorsOrigins(['*'], ['https://a.example.com'])).toEqual(['*'])
        expect(mergeCorsOrigins(['https://a.example.com'], ['*'])).toEqual(['*'])
    })
})
