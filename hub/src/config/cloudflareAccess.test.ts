import { describe, expect, test } from 'bun:test'
import { parseCloudflareAccessConfig } from './cloudflareAccess'

const VALID_TEAM_DOMAIN = 'example.cloudflareaccess.com'
const VALID_AUD = 'test-audience'
const VALID_USERS = JSON.stringify({ 'Alice@Example.com': 'default' })

function envWith(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
        HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN: VALID_TEAM_DOMAIN,
        HAPI_CLOUDFLARE_ACCESS_AUD: VALID_AUD,
        HAPI_CLOUDFLARE_ACCESS_USERS: VALID_USERS
    }
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key]
        else env[key] = value
    }
    return env
}

describe('parseCloudflareAccessConfig', () => {
    test('returns null when every variable is absent', () => {
        expect(parseCloudflareAccessConfig({})).toBeNull()
    })

    test('returns null when every variable is an empty string', () => {
        expect(parseCloudflareAccessConfig(envWith({
            HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN: '',
            HAPI_CLOUDFLARE_ACCESS_AUD: '',
            HAPI_CLOUDFLARE_ACCESS_USERS: ''
        }))).toBeNull()
    })

    test('throws when only the team domain is set', () => {
        expect(() => parseCloudflareAccessConfig(envWith({
            HAPI_CLOUDFLARE_ACCESS_AUD: undefined,
            HAPI_CLOUDFLARE_ACCESS_USERS: undefined
        }))).toThrow()
    })

    test('throws when only the audience is set', () => {
        expect(() => parseCloudflareAccessConfig(envWith({
            HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN: undefined,
            HAPI_CLOUDFLARE_ACCESS_USERS: undefined
        }))).toThrow()
    })

    test('throws when only the users map is set', () => {
        expect(() => parseCloudflareAccessConfig(envWith({
            HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN: undefined,
            HAPI_CLOUDFLARE_ACCESS_AUD: undefined
        }))).toThrow()
    })

    test('throws when the users map is missing but the rest is valid', () => {
        expect(() => parseCloudflareAccessConfig(envWith({
            HAPI_CLOUDFLARE_ACCESS_USERS: undefined
        }))).toThrow()
    })

    test('parses a valid bundle and normalizes case', () => {
        const config = parseCloudflareAccessConfig(envWith())
        expect(config).not.toBeNull()
        expect(config?.teamDomain).toBe('example.cloudflareaccess.com')
        expect(config?.audience).toBe(VALID_AUD)
        expect(config?.users).toEqual({ 'alice@example.com': 'default' })
    })

    test('normalizes an uppercase team domain', () => {
        const config = parseCloudflareAccessConfig(envWith({
            HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'Example.CloudflareAccess.com'
        }))
        expect(config?.teamDomain).toBe('example.cloudflareaccess.com')
    })

    describe('team domain validation', () => {
        const badDomains = [
            'https://example.cloudflareaccess.com',
            'http://example.cloudflareaccess.com',
            'example.cloudflareaccess.com:443',
            'example.cloudflareaccess.com/',
            'example.cloudflareaccess.com/path',
            'user@example.cloudflareaccess.com',
            'example.cloudflareaccess.com?query=1',
            'example.cloudflareaccess.com#fragment',
            ' example.cloudflareaccess.com',
            'example.cloudflareaccess.com ',
            'example.cloudflareaccess.com\n',
            'example.cloudflareaccess.com\t',
            'example.com',
            'cloudflareaccess.com',
            '.cloudflareaccess.com',
            'a.b.cloudflareaccess.com',
            '-example.cloudflareaccess.com',
            'example-.cloudflareaccess.com',
            'exam_ple.cloudflareaccess.com',
            'example.cloudflareaccess.com.evil.com',
            ''
        ]
        for (const teamDomain of badDomains) {
            test(`rejects team domain ${JSON.stringify(teamDomain)}`, () => {
                expect(() => parseCloudflareAccessConfig(envWith({
                    HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN: teamDomain
                }))).toThrow()
            })
        }
    })

    describe('audience validation', () => {
        test('rejects an empty audience', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_AUD: ''
            }))).toThrow()
        })

        test('rejects a whitespace-only audience', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_AUD: '   '
            }))).toThrow()
        })
    })

    describe('users map validation', () => {
        test('rejects invalid JSON', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: '{not json'
            }))).toThrow()
        })

        test('rejects a non-object JSON value', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: '"alice@example.com"'
            }))).toThrow()
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: '["alice@example.com"]'
            }))).toThrow()
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: '42'
            }))).toThrow()
        })

        test('rejects an empty map', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: '{}'
            }))).toThrow()
        })

        test('rejects an invalid email key', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: JSON.stringify({ 'not-an-email': 'default' })
            }))).toThrow()
        })

        test('rejects an email key with whitespace', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: JSON.stringify({ ' alice@example.com ': 'default' })
            }))).toThrow()
        })

        test('rejects case-folded duplicate emails', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: JSON.stringify({
                    'alice@example.com': 'default',
                    'ALICE@example.com': 'other'
                })
            }))).toThrow()
        })

        test('rejects an empty namespace', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: JSON.stringify({ 'alice@example.com': '' })
            }))).toThrow()
        })

        test('rejects a whitespace-padded namespace', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: JSON.stringify({ 'alice@example.com': ' default ' })
            }))).toThrow()
        })

        test('rejects a non-string namespace', () => {
            expect(() => parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: JSON.stringify({ 'alice@example.com': 42 })
            }))).toThrow()
        })

        test('accepts distinct emails mapping to distinct namespaces', () => {
            const config = parseCloudflareAccessConfig(envWith({
                HAPI_CLOUDFLARE_ACCESS_USERS: JSON.stringify({
                    'alice@example.com': 'default',
                    'bob@example.com': 'work'
                })
            }))
            expect(config?.users).toEqual({
                'alice@example.com': 'default',
                'bob@example.com': 'work'
            })
        })
    })
})
