import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { formatReopenError } from './reopenError'

describe('formatReopenError', () => {
    it('renders error + missing fields from a 422 ApiError body', () => {
        const error = new ApiError(
            'HTTP 422 Unprocessable Entity: {"error":"Cursor session id is missing","missing":["cursorSessionId"]}',
            422,
            'Cursor session id is missing',
            '{"error":"Cursor session id is missing","missing":["cursorSessionId"]}'
        )

        expect(formatReopenError(error)).toBe(
            'Cursor session id is missing (missing: cursorSessionId)'
        )
    })

    it('renders error only when missing is empty', () => {
        const error = new ApiError(
            'HTTP 503 Service Unavailable: {"error":"No machine online","code":"no_machine_online"}',
            503,
            'no_machine_online',
            '{"error":"No machine online","code":"no_machine_online"}'
        )

        expect(formatReopenError(error)).toBe('No machine online')
    })

    it('falls back to Error.message when there is no JSON body to parse', () => {
        expect(formatReopenError(new Error('boom'))).toBe('boom')
    })

    it('falls back to a generic message when the value is not an Error', () => {
        expect(formatReopenError('plain string')).toBe('Failed to reopen session')
    })

    it('parses JSON embedded in plain Error messages when no ApiError body is set', () => {
        // Older callers wrap the body in the Error message string.
        const error = new Error(
            'HTTP 422: {"error":"Cursor session id is missing","missing":["cursorSessionId","cursorSessionProtocol"]}'
        )

        expect(formatReopenError(error)).toBe(
            'Cursor session id is missing (missing: cursorSessionId, cursorSessionProtocol)'
        )
    })

    it('falls back to the raw message when JSON cannot be parsed', () => {
        const error = new Error('HTTP 500: not actually json {bad}')
        expect(formatReopenError(error)).toBe('HTTP 500: not actually json {bad}')
    })
})
