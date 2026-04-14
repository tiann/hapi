import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration, parseExtraHeaders } from '@/configuration'
import { buildHubRequestHeaders, buildSocketIoExtraHeaderOptions } from './hubExtraHeaders'

describe('parseExtraHeaders', () => {
    it('parses a JSON object with string values', () => {
        expect(parseExtraHeaders('{"Cookie":"a=b","X-Test":"1"}')).toEqual({
            Cookie: 'a=b',
            'X-Test': '1'
        })
    })

    it('drops non-string values', () => {
        const warn = vi.fn()
        expect(parseExtraHeaders('{"Cookie":"a=b","X-Num":1,"X-Bool":true}', warn)).toEqual({
            Cookie: 'a=b'
        })
        expect(warn).toHaveBeenCalledOnce()
    })

    it('returns empty object and warns for invalid json', () => {
        const warn = vi.fn()
        expect(parseExtraHeaders('{not-json', warn)).toEqual({})
        expect(warn).toHaveBeenCalledOnce()
    })

    it('returns empty object and warns for non-object json', () => {
        const warn = vi.fn()
        expect(parseExtraHeaders('["a"]', warn)).toEqual({})
        expect(warn).toHaveBeenCalledOnce()
    })
})

describe('hub extra headers helpers', () => {
    beforeEach(() => {
        configuration._setExtraHeaders({})
    })

    it('merges custom headers into REST requests without overriding built-in auth headers', () => {
        configuration._setExtraHeaders({
            Cookie: 'CF_Authorization=token',
            Authorization: 'should-not-win'
        })

        expect(buildHubRequestHeaders({
            Authorization: 'Bearer cli-token',
            'Content-Type': 'application/json'
        })).toEqual({
            Cookie: 'CF_Authorization=token',
            Authorization: 'Bearer cli-token',
            'Content-Type': 'application/json'
        })
    })

    it('builds socket transport options when extra headers are configured', () => {
        configuration._setExtraHeaders({
            Cookie: 'CF_Authorization=token',
            'X-Test': '1'
        })

        expect(buildSocketIoExtraHeaderOptions()).toEqual({
            extraHeaders: {
                Cookie: 'CF_Authorization=token',
                'X-Test': '1'
            }
        })
    })

    it('returns empty socket options when no extra headers are configured', () => {
        expect(buildSocketIoExtraHeaderOptions()).toEqual({})
    })
})
