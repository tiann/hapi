import { describe, expect, it } from 'vitest'
import { extractErrorInfo, apiValidationError } from './errorUtils'

describe('extractErrorInfo', () => {
    it('extracts serverProtocolVersion from axios-style response header', () => {
        const error = {
            message: 'Request failed with status code 400',
            response: {
                status: 400,
                headers: { 'x-hapi-protocol-version': '2' },
                data: { error: 'Invalid body' }
            }
        }
        const info = extractErrorInfo(error)
        expect(info.serverProtocolVersion).toBe(2)
        expect(info.httpStatus).toBe(400)
        expect(info.responseErrorText).toBe('Invalid body')
    })

    it('extracts serverProtocolVersion from direct property (apiValidationError)', () => {
        const error = new Error('Invalid /cli/machines response')
        ;(error as unknown as Record<string, unknown>).serverProtocolVersion = 1
        const info = extractErrorInfo(error)
        expect(info.serverProtocolVersion).toBe(1)
        expect(info.message).toBe('Invalid /cli/machines response')
    })

    it('prefers direct property over header', () => {
        const error = Object.assign(new Error('test'), {
            serverProtocolVersion: 3,
            response: {
                status: 200,
                headers: { 'x-hapi-protocol-version': '5' },
                data: {}
            }
        })
        const info = extractErrorInfo(error)
        expect(info.serverProtocolVersion).toBe(3)
    })

    it('returns undefined serverProtocolVersion when neither source present', () => {
        const error = new Error('some error')
        const info = extractErrorInfo(error)
        expect(info.serverProtocolVersion).toBeUndefined()
    })

    it('handles non-numeric protocol header gracefully', () => {
        const error = {
            message: 'fail',
            response: {
                status: 200,
                headers: { 'x-hapi-protocol-version': 'abc' },
                data: {}
            }
        }
        const info = extractErrorInfo(error)
        expect(info.serverProtocolVersion).toBeUndefined()
    })
})

describe('apiValidationError', () => {
    it('creates error with serverProtocolVersion from response header', () => {
        const fakeResponse = {
            headers: { 'x-hapi-protocol-version': '1' }
        }
        const err = apiValidationError('Invalid /cli/machines response', fakeResponse as any)
        expect(err.message).toBe('Invalid /cli/machines response')
        expect((err as any).serverProtocolVersion).toBe(1)
    })

    it('creates error without serverProtocolVersion when header missing', () => {
        const fakeResponse = { headers: {} }
        const err = apiValidationError('Invalid /cli/sessions response', fakeResponse as any)
        expect(err.message).toBe('Invalid /cli/sessions response')
        expect((err as any).serverProtocolVersion).toBeUndefined()
    })

    it('round-trips through extractErrorInfo', () => {
        const fakeResponse = {
            headers: { 'x-hapi-protocol-version': '2' }
        }
        const err = apiValidationError('Invalid /cli/machines response', fakeResponse as any)
        const info = extractErrorInfo(err)
        expect(info.serverProtocolVersion).toBe(2)
        expect(info.messageLower).toContain('invalid /cli/')
    })
})
