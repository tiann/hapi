import { afterEach, describe, expect, it } from 'vitest'
import { configuration } from '@/configuration'
import {
    assertLocalDisplayLinksTarget,
    displayLinksAuthRequestHeaders,
    displayLinksSessionRequestHeaders,
    parseDisplayLinksArgs,
} from './displayLinks'

describe('parseDisplayLinksArgs', () => {
    it('treats a leading http(s) href as self-target', () => {
        const href = 'https://github.com/tia' + 'nn' + '/hapi/issues/1516'
        expect(parseDisplayLinksArgs([href, 'Issue 1516'])).toEqual({
            help: false,
            sessionArg: null,
            href,
            texts: [],
            title: 'Issue 1516',
            readTextFromStdin: false,
        })
    })

    it('parses session prefix + href + title', () => {
        expect(parseDisplayLinksArgs(['abc12345', 'https://example.com', 'Example'])).toEqual({
            help: false,
            sessionArg: 'abc12345',
            href: 'https://example.com',
            texts: [],
            title: 'Example',
            readTextFromStdin: false,
        })
    })

    it('parses self token', () => {
        expect(parseDisplayLinksArgs(['self', 'https://example.com'])).toEqual({
            help: false,
            sessionArg: 'self',
            href: 'https://example.com',
            texts: [],
            title: undefined,
            readTextFromStdin: false,
        })
    })

    it('parses --help', () => {
        expect(parseDisplayLinksArgs(['--help']).help).toBe(true)
    })

    it('parses --text exact-copy value by concatenation', () => {
        const value = 'VK' + 'K'
        expect(parseDisplayLinksArgs(['--text', value, 'gate'])).toEqual({
            help: false,
            sessionArg: null,
            href: '',
            texts: [{ value, title: 'gate' }],
            title: undefined,
            readTextFromStdin: false,
        })
    })

    it('parses self --text', () => {
        const value = 'dead' + 'beef'
        expect(parseDisplayLinksArgs(['self', '--text', value])).toEqual({
            help: false,
            sessionArg: 'self',
            href: '',
            texts: [{ value }],
            title: undefined,
            readTextFromStdin: false,
        })
    })

    it('parses --text-stdin without putting the secret on argv-derived texts', () => {
        const parsed = parseDisplayLinksArgs(['--text-stdin', 'gate'])
        expect(parsed.readTextFromStdin).toBe(true)
        expect(parsed.texts).toEqual([])
        expect(parsed.title).toBe('gate')
        expect(JSON.stringify(parsed)).not.toContain('SENTINEL')
    })

    it('throws when href and --text are missing', () => {
        expect(() => parseDisplayLinksArgs([])).toThrow(/missing href|--text/)
        expect(() => parseDisplayLinksArgs(['self'])).toThrow(/missing href|--text/)
    })
})

describe('assertLocalDisplayLinksTarget', () => {
    const previous = process.env.HAPI_SESSION_ID
    const selfId = '2acd2599-525c-4774-825f-09ce7802549d'

    afterEach(() => {
        if (previous === undefined) {
            delete process.env.HAPI_SESSION_ID
        } else {
            process.env.HAPI_SESSION_ID = previous
        }
    })

    it('allows omitted session arg and self tokens', () => {
        process.env.HAPI_SESSION_ID = selfId
        expect(() => assertLocalDisplayLinksTarget(null)).not.toThrow()
        expect(() => assertLocalDisplayLinksTarget('self')).not.toThrow()
        expect(() => assertLocalDisplayLinksTarget('@me')).not.toThrow()
    })

    it('allows targeting the current session by id or prefix', () => {
        process.env.HAPI_SESSION_ID = selfId
        expect(() => assertLocalDisplayLinksTarget(selfId)).not.toThrow()
        expect(() => assertLocalDisplayLinksTarget(selfId.slice(0, 8))).not.toThrow()
    })

    it('refuses another session id so loopback hapiMcpUrl is not opened on the caller', () => {
        process.env.HAPI_SESSION_ID = selfId
        expect(() => assertLocalDisplayLinksTarget('9b46cfe7-daf1-446a-bb24-a23208ed9e2a')).toThrow(
            /current local session/
        )
    })

    it('refuses an explicit prefix when HAPI_SESSION_ID is unset', () => {
        delete process.env.HAPI_SESSION_ID
        expect(() => assertLocalDisplayLinksTarget('9b46cfe7')).toThrow(/current local session/)
    })
})

describe('display-links hub extra headers', () => {
    afterEach(() => {
        configuration._setExtraHeaders({})
    })

    it('includes configured extraHeaders on auth and session requests', () => {
        configuration._setExtraHeaders({ Cookie: 'CF_Authorization=from-settings' })
        expect(displayLinksAuthRequestHeaders()).toEqual({
            Cookie: 'CF_Authorization=from-settings',
            'Content-Type': 'application/json',
        })
        expect(displayLinksSessionRequestHeaders('jwt-token')).toEqual({
            Cookie: 'CF_Authorization=from-settings',
            Authorization: 'Bearer jwt-token',
        })
    })
})
