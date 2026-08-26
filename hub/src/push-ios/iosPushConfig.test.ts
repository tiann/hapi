import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { APNS_PRODUCTION_HOST, APNS_SANDBOX_HOST } from './apnsClient'
import { DEFAULT_PUSH_RELAY_URL, resolveIosPushConfig, type IosPushSettings } from './iosPushConfig'

const tempDirs: string[] = []
afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function makeP8File(baseDir: string = tmpdir()): string {
    const dir = mkdtempSync(join(baseDir, 'hapi-apns-key-'))
    tempDirs.push(dir)
    const path = join(dir, 'AuthKey_TEST.p8')
    writeFileSync(path, '-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----\n')
    return path
}

/** All-null settings (the unconfigured hub) with per-test overrides. */
function settings(overrides: Partial<IosPushSettings> = {}): IosPushSettings {
    return {
        iosPushMode: null,
        iosPushRelayUrl: null,
        apnsKeyP8Path: null,
        apnsKeyId: null,
        apnsTeamId: null,
        apnsBundleId: null,
        apnsEnv: null,
        ...overrides,
    }
}

describe('resolveIosPushConfig', () => {
    it('defaults to relay mode with the official relay URL', () => {
        const config = resolveIosPushConfig(settings())
        expect(config).toEqual({ mode: 'relay', relayUrl: DEFAULT_PUSH_RELAY_URL, source: 'default' })
        expect(DEFAULT_PUSH_RELAY_URL).toBe('https://push.hapi.run')
    })

    it('honors an explicit relay URL', () => {
        const config = resolveIosPushConfig(settings({
            iosPushMode: 'relay',
            iosPushRelayUrl: 'https://relay.internal.example'
        }))
        expect(config).toEqual({ mode: 'relay', relayUrl: 'https://relay.internal.example', source: 'configured' })
    })

    it('returns off when iosPushMode=off', () => {
        const config = resolveIosPushConfig(settings({ iosPushMode: 'off' }))
        expect(config.mode).toBe('off')
    })

    it('falls back to the relay default on an unknown iosPushMode value', () => {
        const config = resolveIosPushConfig(settings({ iosPushMode: 'bogus' }))
        expect(config.mode).toBe('relay')
    })

    it('resolves apns mode with all credentials, defaulting to the production host', () => {
        const p8Path = makeP8File()
        const config = resolveIosPushConfig(settings({
            iosPushMode: 'apns',
            apnsKeyP8Path: p8Path,
            apnsKeyId: 'KEY123',
            apnsTeamId: 'TEAM456',
            apnsBundleId: 'run.hapi.ios'
        }))
        expect(config.mode).toBe('apns')
        if (config.mode !== 'apns') throw new Error('unreachable')
        expect(config.keyId).toBe('KEY123')
        expect(config.teamId).toBe('TEAM456')
        expect(config.bundleId).toBe('run.hapi.ios')
        expect(config.env).toBe('production')
        expect(config.host).toBe(APNS_PRODUCTION_HOST)
        expect(config.keyP8).toContain('BEGIN PRIVATE KEY')
    })

    it('expands ~ in the .p8 path', () => {
        const p8Path = makeP8File(homedir())
        const config = resolveIosPushConfig(settings({
            iosPushMode: 'apns',
            apnsKeyP8Path: `~/${relative(homedir(), p8Path)}`,
            apnsKeyId: 'K',
            apnsTeamId: 'T',
            apnsBundleId: 'b'
        }))
        expect(config.mode).toBe('apns')
        if (config.mode !== 'apns') throw new Error('unreachable')
        expect(config.keyP8Path).toBe(p8Path)
    })

    it('uses the sandbox host when apnsEnv=sandbox', () => {
        const config = resolveIosPushConfig(settings({
            iosPushMode: 'apns',
            apnsKeyP8Path: makeP8File(),
            apnsKeyId: 'K',
            apnsTeamId: 'T',
            apnsBundleId: 'b',
            apnsEnv: 'sandbox'
        }))
        if (config.mode !== 'apns') throw new Error('expected apns mode')
        expect(config.env).toBe('sandbox')
        expect(config.host).toBe(APNS_SANDBOX_HOST)
    })

    it('disables push when apns is selected but credentials are missing', () => {
        const config = resolveIosPushConfig(settings({
            iosPushMode: 'apns',
            apnsKeyId: 'K'
        }))
        expect(config.mode).toBe('off')
        if (config.mode !== 'off') throw new Error('unreachable')
        expect(config.reason).toContain('apnsKeyP8Path')
        expect(config.reason).toContain('apnsTeamId')
        expect(config.reason).toContain('apnsBundleId')
        expect(config.reason).not.toContain('apnsKeyId (')
    })

    it('disables push when the .p8 file cannot be read', () => {
        const config = resolveIosPushConfig(settings({
            iosPushMode: 'apns',
            apnsKeyP8Path: '/nonexistent/AuthKey.p8',
            apnsKeyId: 'K',
            apnsTeamId: 'T',
            apnsBundleId: 'b'
        }))
        expect(config.mode).toBe('off')
        if (config.mode !== 'off') throw new Error('unreachable')
        expect(config.reason).toContain('cannot read apnsKeyP8Path')
    })
})
