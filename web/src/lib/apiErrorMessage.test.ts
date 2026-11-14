import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { getApiErrorMessage, getApiErrorUrl } from './apiErrorMessage'

describe('getApiErrorMessage', () => {
    it('extracts the hub\'s { error } message from an ApiError body', () => {
        const err = new ApiError('HTTP 502', 502, undefined, JSON.stringify({ error: 'rate limited' }))
        expect(getApiErrorMessage(err, 'fallback')).toBe('rate limited')
    })

    it('falls back to the raw Error message when the body is not that shape', () => {
        const err = new ApiError('HTTP 502 Bad Gateway: oops', 502, undefined, 'not json')
        expect(getApiErrorMessage(err, 'fallback')).toBe('HTTP 502 Bad Gateway: oops')
    })

    it('falls back to the caller-supplied default for a non-Error value', () => {
        expect(getApiErrorMessage('boom', 'fallback')).toBe('fallback')
    })
})

describe('getApiErrorUrl', () => {
    it('extracts a url the hub attached alongside the error, for partial-failure writes', () => {
        const err = new ApiError('HTTP 502', 502, undefined, JSON.stringify({
            error: 'Issue created at https://github.com/heavygee/hapi/issues/42 but could not be added to the board: boom',
            url: 'https://github.com/heavygee/hapi/issues/42'
        }))
        expect(getApiErrorUrl(err)).toBe('https://github.com/heavygee/hapi/issues/42')
    })

    it('returns null when the error body carries no url', () => {
        const err = new ApiError('HTTP 502', 502, undefined, JSON.stringify({ error: 'rate limited' }))
        expect(getApiErrorUrl(err)).toBeNull()
    })

    it('returns null for a non-ApiError value', () => {
        expect(getApiErrorUrl(new Error('boom'))).toBeNull()
    })
})
