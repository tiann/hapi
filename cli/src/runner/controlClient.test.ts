import { describe, expect, it } from 'vitest'

import { formatRunnerHttpError, resolveRunnerHttpTimeout } from './controlClient'

describe('formatRunnerHttpError', () => {
    it('keeps the HTTP status and a bounded single-line Runner error detail', () => {
        expect(formatRunnerHttpError('/spawn-session', 500, {
            error: 'Failed to spawn session:\n  ownership validation failed'
        })).toBe('Request failed: /spawn-session, HTTP 500: Failed to spawn session: ownership validation failed')
    })

    it('falls back to the status-only error for malformed response bodies', () => {
        expect(formatRunnerHttpError('/spawn-session', 500, { error: 42 })).toBe(
            'Request failed: /spawn-session, HTTP 500'
        )
    })
})

describe('resolveRunnerHttpTimeout', () => {
    it('honors a request deadline without weakening a required minimum', () => {
        expect(resolveRunnerHttpTimeout('10000', { maximumTimeoutMs: 2_500 })).toBe(2_500)
        expect(resolveRunnerHttpTimeout('10000', { minimumTimeoutMs: 20_000 })).toBe(20_000)
        expect(resolveRunnerHttpTimeout('invalid', {})).toBe(10_000)
    })
})
