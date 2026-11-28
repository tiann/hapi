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

const QQ_ENV_KEYS = [
    'QQBOT_NOTIFICATION', 'QQBOT_APP_ID', 'QQBOT_APP_SECRET', 'QQBOT_USER_OPENID',
    'QQBOT_NAMESPACE', 'QQBOT_BACKGROUND_ONLY', 'HAPI_PUBLIC_URL'
] as const

const qqBotFile = { enabled: true, appId: '12345', appSecret: 'file-secret', userOpenId: 'test-recipient' }
const publicUrl = 'https://hapi.example.test'

describe('loadServerSettings', () => {
    let dir: string | null = null
    const originalBackgroundOnly = process.env.SERVERCHAN_BACKGROUND_ONLY
    const overriddenEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
        delete process.env.SERVERCHAN_BACKGROUND_ONLY
        for (const key of [...PUSH_ENV_KEYS, ...QQ_ENV_KEYS]) {
            overriddenEnv[key] = process.env[key]
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
        for (const key of [...PUSH_ENV_KEYS, ...QQ_ENV_KEYS]) {
            const previous = overriddenEnv[key]
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

    it('persists Android push mode and honors env over file without replacing the file value', async () => {
        dir = makeTempDir()
        const original = process.env.HAPI_ANDROID_PUSH
        try {
            process.env.HAPI_ANDROID_PUSH = 'relay'
            expect((await loadServerSettings(dir)).settings.androidPushMode).toBe('relay')
            expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).androidPushMode).toBe('relay')
            process.env.HAPI_ANDROID_PUSH = 'off'
            const overridden = await loadServerSettings(dir)
            expect(overridden.settings.androidPushMode).toBe('off')
            expect(overridden.sources.androidPushMode).toBe('env')
            delete process.env.HAPI_ANDROID_PUSH
            const restored = await loadServerSettings(dir)
            expect(restored.settings.androidPushMode).toBe('relay')
            expect(restored.sources.androidPushMode).toBe('file')
        } finally {
            if (original === undefined) delete process.env.HAPI_ANDROID_PUSH
            else process.env.HAPI_ANDROID_PUSH = original
        }
    })

    it('keeps QQ bot notifications disabled unless explicitly enabled', async () => {
        dir = makeTempDir()
        const { enabled: _enabled, ...credentials } = qqBotFile
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ qqBot: credentials, publicUrl }))
        expect((await loadServerSettings(dir)).settings.qqBot).toBeNull()
    })

    it('resolves opt-in QQ bot settings with default namespace and visibility', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ qqBot: qqBotFile, publicUrl }))
        expect((await loadServerSettings(dir)).settings.qqBot).toEqual({
            appId: '12345', appSecret: 'file-secret', userOpenId: 'test-recipient', namespace: 'default', backgroundOnly: false
        })
        process.env.QQBOT_NOTIFICATION = 'false'
        expect((await loadServerSettings(dir)).settings.qqBot).toBeNull()
    })

    it('applies QQ bot environment overrides without persisting credentials or flags', async () => {
        dir = makeTempDir()
        const path = join(dir, 'settings.json')
        writeFileSync(path, JSON.stringify({ qqBot: { enabled: false, userOpenId: 'file-recipient' } }))
        process.env.QQBOT_NOTIFICATION = 'true'
        process.env.QQBOT_APP_ID = '789'
        process.env.QQBOT_APP_SECRET = 'env-secret'
        process.env.QQBOT_USER_OPENID = 'env-recipient'
        process.env.QQBOT_NAMESPACE = 'team'
        process.env.QQBOT_BACKGROUND_ONLY = 'true'
        process.env.HAPI_PUBLIC_URL = publicUrl
        expect((await loadServerSettings(dir)).settings.qqBot).toEqual({
            appId: '789', appSecret: 'env-secret', userOpenId: 'env-recipient', namespace: 'team', backgroundOnly: true
        })
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
            qqBot: { enabled: false, userOpenId: 'file-recipient' }, publicUrl
        })
    })

    it('accepts the same namespace with internal spaces from settings and environment', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ qqBot: { ...qqBotFile, namespace: 'team west' }, publicUrl }))
        expect((await loadServerSettings(dir)).settings.qqBot?.namespace).toBe('team west')
        process.env.QQBOT_NAMESPACE = 'team east'
        expect((await loadServerSettings(dir)).settings.qqBot?.namespace).toBe('team east')
    })

    it.each(['', ' team west', 'team west ', 'team:west'])('rejects invalid QQ namespace %j', async (namespace) => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ qqBot: { ...qqBotFile, namespace }, publicUrl }))
        await expect(loadServerSettings(dir)).rejects.toThrow(/QQBOT_NAMESPACE/)
    })

    it('rejects enabled QQ bot credentials missing an OpenID and does not print the secret', async () => {
        dir = makeTempDir()
        const path = join(dir, 'settings.json')
        writeFileSync(path, JSON.stringify({ qqBot: { ...qqBotFile, userOpenId: ' ' }, publicUrl }))
        await expect(loadServerSettings(dir)).rejects.toThrow(/^QQBOT_USER_OPENID \/ qqBot\.userOpenId is required and must be valid when QQ Bot notifications are enabled$/)
    })

    it.each([undefined, 'not-a-url', 'file:///a', 'https://user:private@hapi.example.test'])(
        'requires an explicit HTTP(S) HAPI origin without user credentials (%s)', async (url) => {
            dir = makeTempDir()
            writeFileSync(join(dir, 'settings.json'), JSON.stringify({ qqBot: qqBotFile, publicUrl: url }))
            await expect(loadServerSettings(dir)).rejects.toThrow(/HAPI_PUBLIC_URL/)
        }
    )

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
