import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-server-settings-test-'))
}

const PUSH_ENV_KEYS = [
    'FCM_SERVICE_ACCOUNT_PATH',
    'HAPI_IOS_PUSH',
    'HAPI_PUSH_RELAY_URL',
    'APNS_KEY_P8_PATH',
    'APNS_KEY_ID',
    'APNS_TEAM_ID',
    'APNS_BUNDLE_ID',
    'APNS_ENV',
] as const

describe('loadServerSettings', () => {
    let dir: string | null = null
    const originalBackgroundOnly = process.env.SERVERCHAN_BACKGROUND_ONLY
    const originalPushEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
        delete process.env.SERVERCHAN_BACKGROUND_ONLY
        for (const key of PUSH_ENV_KEYS) {
            originalPushEnv[key] = process.env[key]
            delete process.env[key]
        }
    })

    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
        if (originalBackgroundOnly === undefined) {
            delete process.env.SERVERCHAN_BACKGROUND_ONLY
        } else {
            process.env.SERVERCHAN_BACKGROUND_ONLY = originalBackgroundOnly
        }
        for (const key of PUSH_ENV_KEYS) {
            const previous = originalPushEnv[key]
            if (previous === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = previous
            }
        }
    })

    it('rejects old webapp settings fields instead of migrating them', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            webappHost: '0.0.0.0',
            webappPort: 3007,
            webappUrl: 'http://localhost:3007',
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('Unsupported old settings field')
    })

    it('defaults githubPrAwareness to false', async () => {
        dir = makeTempDir()
        const result = await loadServerSettings(dir)
        expect(result.settings.githubPrAwareness).toBe(false)
        expect(result.sources.githubPrAwareness).toBe('default')
    })

    it('honors HAPI_GITHUB_PR_AWARENESS env override', async () => {
        dir = makeTempDir()
        const previous = process.env.HAPI_GITHUB_PR_AWARENESS
        process.env.HAPI_GITHUB_PR_AWARENESS = '1'
        try {
            const result = await loadServerSettings(dir)
            expect(result.settings.githubPrAwareness).toBe(true)
            expect(result.sources.githubPrAwareness).toBe('env')
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_GITHUB_PR_AWARENESS
            } else {
                process.env.HAPI_GITHUB_PR_AWARENESS = previous
            }
        }
    })

    it('rejects a non-boolean githubPrAwareness setting', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            githubPrAwareness: 'false'
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('githubPrAwareness must be a boolean')
    })

    it('defaults ServerChan background-only mode to disabled', async () => {
        dir = makeTempDir()

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(false)
        expect(result.sources.serverChanBackgroundOnly).toBe('default')
    })

    it('loads ServerChan background-only mode from settings.json', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: true
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(true)
        expect(result.sources.serverChanBackgroundOnly).toBe('file')
    })

    it('loads ServerChan background-only mode with environment precedence', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: false
        }))
        process.env.SERVERCHAN_BACKGROUND_ONLY = 'true'

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(true)
        expect(result.sources.serverChanBackgroundOnly).toBe('env')
    })

    it('rejects a non-boolean ServerChan background-only setting', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: 'false'
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('serverChanBackgroundOnly must be a boolean')
    })

    it('defaults push settings to null', async () => {
        dir = makeTempDir()

        const result = await loadServerSettings(dir)

        expect(result.settings.fcmServiceAccountPath).toBeNull()
        expect(result.settings.iosPushMode).toBeNull()
        expect(result.sources.fcmServiceAccountPath).toBe('default')
    })

    it('persists a push env value to settings.json on first sight', async () => {
        dir = makeTempDir()
        process.env.FCM_SERVICE_ACCOUNT_PATH = '/tmp/sa.json'
        try {
            const result = await loadServerSettings(dir)

            expect(result.settings.fcmServiceAccountPath).toBe('/tmp/sa.json')
            expect(result.sources.fcmServiceAccountPath).toBe('env')
            expect(result.savedToFile).toBe(true)

            const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
            expect(written.fcmServiceAccountPath).toBe('/tmp/sa.json')
        } finally {
            delete process.env.FCM_SERVICE_ACCOUNT_PATH
        }
    })

    it('loads push settings from settings.json when the env is unset', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            fcmServiceAccountPath: '~/.hapi/sa.json',
            iosPushMode: 'off'
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.fcmServiceAccountPath).toBe('~/.hapi/sa.json')
        expect(result.sources.fcmServiceAccountPath).toBe('file')
        expect(result.settings.iosPushMode).toBe('off')
        expect(result.sources.iosPushMode).toBe('file')
    })
})
