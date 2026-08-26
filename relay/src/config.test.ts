import { describe, expect, test } from 'bun:test'
import {
    APNS_HOSTS,
    DEFAULT_RELAY_PORT,
    loadConfigFromEnv,
    readRelayVersion
} from './config'

function baseEnv(): Record<string, string | undefined> {
    return {
        RELAY_APNS_KEY_P8_PATH: '/keys/AuthKey_ABC123DEF4.p8',
        RELAY_APNS_KEY_ID: 'ABC123DEF4',
        RELAY_APNS_TEAM_ID: 'TEAM123456',
        RELAY_APNS_BUNDLE_ID: 'app.hapi.ios'
    }
}

describe('loadConfigFromEnv', () => {
    test('parses a full environment with defaults applied', () => {
        const config = loadConfigFromEnv(baseEnv())
        expect(config).toEqual({
            apnsKeyP8Path: '/keys/AuthKey_ABC123DEF4.p8',
            apnsKeyId: 'ABC123DEF4',
            apnsTeamId: 'TEAM123456',
            apnsBundleId: 'app.hapi.ios',
            apnsEnv: 'production',
            port: DEFAULT_RELAY_PORT,
            trustProxy: false
        })
        expect(config.port).toBe(8790)
    })

    test('maps apnsEnv to the right APNs hosts', () => {
        expect(APNS_HOSTS.production).toBe('https://api.push.apple.com')
        expect(APNS_HOSTS.sandbox).toBe('https://api.sandbox.push.apple.com')
        const config = loadConfigFromEnv({ ...baseEnv(), RELAY_APNS_ENV: 'sandbox' })
        expect(config.apnsEnv).toBe('sandbox')
    })

    test('rejects an unknown RELAY_APNS_ENV', () => {
        expect(() => loadConfigFromEnv({ ...baseEnv(), RELAY_APNS_ENV: 'staging' }))
            .toThrow(/RELAY_APNS_ENV/)
    })

    test.each([
        'RELAY_APNS_KEY_P8_PATH',
        'RELAY_APNS_KEY_ID',
        'RELAY_APNS_TEAM_ID',
        'RELAY_APNS_BUNDLE_ID'
    ])('requires %s', (name) => {
        const env = baseEnv()
        delete env[name]
        expect(() => loadConfigFromEnv(env)).toThrow(new RegExp(name))
        env[name] = '   '
        expect(() => loadConfigFromEnv(env)).toThrow(new RegExp(name))
    })

    test('parses RELAY_PORT and rejects nonsense values', () => {
        expect(loadConfigFromEnv({ ...baseEnv(), RELAY_PORT: '9000' }).port).toBe(9000)
        expect(() => loadConfigFromEnv({ ...baseEnv(), RELAY_PORT: 'abc' })).toThrow(/RELAY_PORT/)
        expect(() => loadConfigFromEnv({ ...baseEnv(), RELAY_PORT: '0' })).toThrow(/RELAY_PORT/)
        expect(() => loadConfigFromEnv({ ...baseEnv(), RELAY_PORT: '70000' })).toThrow(/RELAY_PORT/)
    })

    test('parses RELAY_TRUST_PROXY', () => {
        expect(loadConfigFromEnv({ ...baseEnv(), RELAY_TRUST_PROXY: '1' }).trustProxy).toBe(true)
        expect(loadConfigFromEnv({ ...baseEnv(), RELAY_TRUST_PROXY: 'true' }).trustProxy).toBe(true)
        expect(loadConfigFromEnv({ ...baseEnv(), RELAY_TRUST_PROXY: 'false' }).trustProxy).toBe(false)
        expect(loadConfigFromEnv(baseEnv()).trustProxy).toBe(false)
    })
})

describe('readRelayVersion', () => {
    test('reports the version from relay/package.json', async () => {
        const pkg = await Bun.file(new URL('../package.json', import.meta.url).pathname).json() as {
            version: string
        }
        expect(await readRelayVersion()).toBe(pkg.version)
    })
})
