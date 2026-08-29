import { describe, expect, it } from 'bun:test'
import {
    buildDisplayLinksPayload,
    buildDisplayLinksToolName,
    isDisplayableHttpHref,
    parseDisplayLinksInput,
    parseDisplayLinksToolInput,
    parseDisplayTextsInput,
    assertBoundDisplayLinksSession,
    redactDisplayLinksToolInput,
    isDisplayLinksToolName,
    safeParseDisplayLinksInput,
    safeParseDisplayTextsInput,
} from './displayLinks'

describe('isDisplayableHttpHref', () => {
    it('accepts a landmine URL built by concatenation without rewriting bytes', () => {
        const href = 'https://github.com/tia' + 'nn' + '/hapi/issues/1516'
        expect(href).toBe('https://github.com/tiann/hapi/issues/1516')
        expect(isDisplayableHttpHref(href)).toBe(true)
    })

    it('accepts http and https', () => {
        expect(isDisplayableHttpHref('https://hapi-gc-oos.forest-adder.ts.net/sessions/abc')).toBe(true)
        expect(isDisplayableHttpHref('http://example.com/path')).toBe(true)
    })

    it.each([
        'javascript:alert(1)',
        'data:text/html,xss',
        'vbscript:msgbox(1)',
        'file:///tmp/secret',
        'mailto:ops@example.com',
        '/relative/path',
        'not a url',
        '',
    ])('rejects %s', (href) => {
        expect(isDisplayableHttpHref(href)).toBe(false)
    })

    it('rejects encoded javascript bypasses', () => {
        expect(isDisplayableHttpHref('javascript%3Aalert(1)')).toBe(false)
        expect(isDisplayableHttpHref('jav%61script:alert(1)')).toBe(false)
    })
})

describe('parseDisplayLinksInput', () => {
    it('round-trips a concatenated landmine href as stored bytes', () => {
        const href = 'https://github.com/tia' + 'nn' + '/hapi/issues/1516'
        const urls = parseDisplayLinksInput([{ href, title: 'Issue 1516' }])
        expect(urls).toEqual([{ href: 'https://github.com/tiann/hapi/issues/1516', title: 'Issue 1516' }])
        expect(urls[0]?.href).toBe(href)
    })

    it('accepts a bare href string in the urls array', () => {
        const href = 'https://example.com/a'
        expect(parseDisplayLinksInput([href])).toEqual([{ href }])
    })

    it('omits empty titles rather than storing blanks', () => {
        expect(parseDisplayLinksInput([{ href: 'https://example.com', title: '  ' }])).toEqual([
            { href: 'https://example.com' },
        ])
    })

    it('throws when urls is missing or empty', () => {
        expect(() => parseDisplayLinksInput(undefined)).toThrow(/urls/)
        expect(() => parseDisplayLinksInput([])).toThrow(/at least one/)
    })

    it('throws on deny-scheme hrefs instead of rewriting them', () => {
        expect(() => parseDisplayLinksInput([{ href: 'javascript:alert(1)' }])).toThrow(/rejected/)
    })
})

describe('safeParseDisplayLinksInput', () => {
    it('drops invalid entries instead of throwing (untrusted stored payloads)', () => {
        const href = 'https://github.com/tia' + 'nn' + '/hapi/issues/1516'
        expect(safeParseDisplayLinksInput([
            { href: 'javascript:alert(1)' },
            { href },
            { href: 'not-a-url' },
        ])).toEqual([{ href }])
    })

    it('returns [] for non-arrays', () => {
        expect(safeParseDisplayLinksInput(null)).toEqual([])
        expect(safeParseDisplayLinksInput({ href: 'https://example.com' })).toEqual([])
    })
})

describe('parseDisplayTextsInput', () => {
    it('round-trips a concatenated doubled-letter secret as stored bytes', () => {
        const value = 'VK' + 'K'
        const texts = parseDisplayTextsInput([{ value, title: 'gate' }])
        expect(texts).toEqual([{ value: 'VKK', title: 'gate' }])
        expect(texts[0]?.value).toBe(value)
        expect(texts[0]?.value).not.toBe('VK')
    })

    it('accepts a bare string in the texts array', () => {
        const value = 'abc' + 'c' + 'def'
        expect(parseDisplayTextsInput([value])).toEqual([{ value }])
    })

    it('throws when texts is missing or empty', () => {
        expect(() => parseDisplayTextsInput(undefined)).toThrow(/texts/)
        expect(() => parseDisplayTextsInput([])).toThrow(/at least one/)
    })

    it('throws on empty values instead of storing blanks', () => {
        expect(() => parseDisplayTextsInput([{ value: '   ' }])).toThrow(/rejected/)
    })
})

describe('safeParseDisplayTextsInput', () => {
    it('drops empty entries instead of throwing (untrusted stored payloads)', () => {
        const value = 'VK' + 'K'
        expect(safeParseDisplayTextsInput([
            { value: '' },
            { value },
            { value: '  ' },
        ])).toEqual([{ value }])
    })
})

describe('parseDisplayLinksToolInput', () => {
    it('accepts texts without urls', () => {
        const value = 'dead' + 'beef'
        expect(parseDisplayLinksToolInput({ texts: [{ value, title: 'sha' }] })).toEqual({
            urls: [],
            texts: [{ value, title: 'sha' }],
        })
    })

    it('accepts urls without texts', () => {
        const href = 'https://example.com/a'
        expect(parseDisplayLinksToolInput({ urls: [{ href }] })).toEqual({
            urls: [{ href }],
            texts: [],
        })
    })

    it('throws when both urls and texts are missing', () => {
        expect(() => parseDisplayLinksToolInput({})).toThrow(/urls|texts/)
    })
})

describe('buildDisplayLinksPayload', () => {
    it('stores caller href bytes on the wire payload', () => {
        const href = 'https://github.com/tia' + 'nn' + '/hapi/issues/1516'
        const payload = buildDisplayLinksPayload({
            urls: [{ href, title: 'display_links' }],
            id: 'link-1',
        })
        expect(payload.type).toBe('display-links')
        expect(payload.urls[0]?.href).toBe(href)
        expect(JSON.stringify(payload)).toContain('tiann/hapi')
        expect(JSON.stringify(payload)).not.toContain('tian/hapi')
    })

    it('stores concatenated exact-copy bytes without echoing a mangled sibling', () => {
        const value = 'VK' + 'K'
        const payload = buildDisplayLinksPayload({
            urls: [],
            texts: [{ value, title: 'gate' }],
            id: 'text-1',
        })
        expect(payload.texts[0]?.value).toBe(value)
        expect(JSON.stringify(payload)).toContain('VKK')
        expect(JSON.stringify(payload)).not.toMatch(/"VK"/)
    })
})

describe('assertBoundDisplayLinksSession', () => {
    const bound = 'cc4c5807-34ce-4f2f-b8c1-b18ddc191ff0'

    it('accepts an exact match', () => {
        expect(() => assertBoundDisplayLinksSession(bound, bound)).not.toThrow()
    })

    it('rejects a missing caller id', () => {
        expect(() => assertBoundDisplayLinksSession(bound, undefined)).toThrow(/requires sessionId/)
        expect(() => assertBoundDisplayLinksSession(bound, '')).toThrow(/requires sessionId/)
    })

    it('rejects a Kinrupt id on a Sparling-bound server', () => {
        const kinrupt = '472632df-0000-0000-0000-000000000000'
        expect(() => assertBoundDisplayLinksSession(bound, kinrupt)).toThrow(/wrong-session/)
    })
})

describe('redactDisplayLinksToolInput', () => {
    it('replaces exact-copy values and leaves urls intact', () => {
        const secret = 'SENTINEL_SECRET_VK' + 'K'
        const href = 'https://example.com/public'
        const redacted = redactDisplayLinksToolInput({
            urls: [{ href, title: 'Public' }],
            texts: [{ value: secret, title: 'gate' }],
            sessionId: 'abc',
        }) as { texts: Array<{ value: string; title?: string }>; urls: Array<{ href: string }> }
        expect(JSON.stringify(redacted)).not.toContain(secret)
        expect(redacted.texts[0]?.value).toBe('[omitted]')
        expect(redacted.texts[0]?.title).toBe('gate')
        expect(redacted.urls[0]?.href).toBe(href)
    })

    it('fail-closes when texts is malformed or carries extra secret fields', () => {
        const secret = 'SENTINEL_BACKUP_VK' + 'K'
        const objectTexts = redactDisplayLinksToolInput({
            texts: { value: secret },
        }) as { texts: string }
        expect(objectTexts.texts).toBe('[omitted]')
        expect(JSON.stringify(objectTexts)).not.toContain(secret)

        const withBackup = redactDisplayLinksToolInput({
            texts: [{ value: secret, backup: secret, title: 't' }],
            backup: secret,
            urls: [{ href: 'https://example.com', backup: secret }],
        }) as { texts: Array<Record<string, unknown>>; urls: unknown[]; backup?: unknown }
        expect(withBackup.texts[0]).toEqual({ value: '[omitted]', title: 't' })
        expect(withBackup).not.toHaveProperty('backup')
        expect(JSON.stringify(withBackup)).not.toContain(secret)
        expect(withBackup.texts[0]).not.toHaveProperty('backup')
        expect(JSON.stringify(withBackup.urls)).not.toContain('backup')
    })

    it('fail-closes for primitive and array tool inputs', () => {
        const secret = 'SENTINEL_PRIMITIVE_VK' + 'K'
        expect(redactDisplayLinksToolInput(secret)).toBe('[omitted]')
        expect(redactDisplayLinksToolInput([secret])).toBe('[omitted]')
        expect(redactDisplayLinksToolInput(null)).toBeNull()
    })

    it('recognizes Cursor-prefixed display_links tool names', () => {
        expect(isDisplayLinksToolName('display_links')).toBe(true)
        expect(isDisplayLinksToolName('Display Links')).toBe(true)
        expect(isDisplayLinksToolName('mcp__hapi__display_links')).toBe(true)
        expect(isDisplayLinksToolName('hapi_2acd2599_525c_4774_825f_09ce7802549d_display_links')).toBe(true)
        expect(isDisplayLinksToolName('Bash')).toBe(false)
    })

    it('builds a per-session display_links tool name', () => {
        expect(buildDisplayLinksToolName('2acd2599-525c-4774-825f-09ce7802549d')).toBe(
            'hapi_2acd2599_525c_4774_825f_09ce7802549d_display_links',
        )
    })
})
