import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-server-settings-test-'))
}

const PUSH_ENV_KEYS = [
    'WXPUSHER_APP_TOKEN',
    'WXPUSHER_UIDS',
    'WXPUSHER_TOPIC_IDS',
    'WXPUSHER_NOTIFICATION',
    'WXPUSHER_BACKGROUND_ONLY',
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

    it('defaults WxPusher settings to disabled without credentials or recipients', async () => {
        dir = makeTempDir()

        const result = await loadServerSettings(dir)

        expect(result.settings.wxPusherAppToken).toBeNull()
        expect(result.settings.wxPusherUids).toEqual([])
        expect(result.settings.wxPusherTopicIds).toEqual([])
        expect(result.settings.wxPusherNotification).toBe(true)
        expect(result.settings.wxPusherBackgroundOnly).toBe(false)
        expect(result.sources.wxPusherAppToken).toBe('default')
        expect(result.sources.wxPusherUids).toBe('default')
        expect(result.sources.wxPusherTopicIds).toBe('default')
    })

    it('loads WxPusher settings from environment variables with normalized recipients', async () => {
        dir = makeTempDir()
        process.env.WXPUSHER_APP_TOKEN = 'AT_TEST'
        process.env.WXPUSHER_UIDS = ' UID_ONE,UID_TWO,UID_ONE '
        process.env.WXPUSHER_TOPIC_IDS = '12, 34,12'
        process.env.WXPUSHER_NOTIFICATION = 'true'
        process.env.WXPUSHER_BACKGROUND_ONLY = 'true'

        const result = await loadServerSettings(dir)

        expect(result.settings.wxPusherAppToken).toBe('AT_TEST')
        expect(result.settings.wxPusherUids).toEqual(['UID_ONE', 'UID_TWO'])
        expect(result.settings.wxPusherTopicIds).toEqual([12, 34])
        expect(result.settings.wxPusherNotification).toBe(true)
        expect(result.settings.wxPusherBackgroundOnly).toBe(true)
        expect(result.sources.wxPusherAppToken).toBe('env')
        expect(result.sources.wxPusherUids).toBe('env')
        expect(result.sources.wxPusherTopicIds).toBe('env')
        expect(result.sources.wxPusherNotification).toBe('env')
        expect(result.sources.wxPusherBackgroundOnly).toBe('env')
    })

    it.each(['env', 'file'] as const)('skips destination validation and preserves saved values when disabled by %s', async source => {
        dir = makeTempDir()
        if (source === 'env') process.env.WXPUSHER_NOTIFICATION = 'false'
        process.env.WXPUSHER_TOPIC_IDS = 'invalid'
        const saved = {
            wxPusherNotification: source === 'file' ? false : true,
            wxPusherByNamespace: { team: { appToken: 'fixture', topicIds: ['42'] } },
            wxPusherUids: ['saved-recipient'],
        }
        const file = join(dir, 'settings.json')
        writeFileSync(file, JSON.stringify(saved))
        const { settings, sources } = await loadServerSettings(dir)
        expect(settings.wxPusherNotification).toBe(false)
        expect(settings.wxPusherDestinations.size).toBe(0)
        expect(settings.wxPusherTopicIds).toEqual([])
        expect(sources.wxPusherNotification).toBe(source)
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject(saved)
        process.env.WXPUSHER_NOTIFICATION = 'true'
        await expect(loadServerSettings(dir)).rejects.toThrow(/wxPusherByNamespace/)
    })

    it('limits legacy WxPusher settings to default and never fills other namespace entries', async () => {
        dir = makeTempDir()
        process.env.WXPUSHER_APP_TOKEN = 'AT_LEGACY'
        process.env.WXPUSHER_UIDS = 'UID_LEGACY'
        process.env.WXPUSHER_BACKGROUND_ONLY = 'true'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ wxPusherByNamespace: {
            'team-a': { appToken: ' AT_EXPLICIT ', topicIds: [7, 7] },
        } }))
        const { settings } = await loadServerSettings(dir)
        expect(settings.wxPusherDestinations.get('default')).toEqual({
            appToken: 'AT_LEGACY', uids: ['UID_LEGACY'], topicIds: [], backgroundOnly: true,
        })
        expect(settings.wxPusherDestinations.get('team-a')).toEqual({
            appToken: 'AT_EXPLICIT', uids: [], topicIds: [7], backgroundOnly: false,
        })
        expect(settings.wxPusherDestinations.get('team-b')).toBeUndefined()
    })

    it('replaces the whole legacy destination with an explicit default', async () => {
        dir = makeTempDir()
        process.env.WXPUSHER_APP_TOKEN = 'AT_LEGACY'
        process.env.WXPUSHER_UIDS = 'UID_LEGACY'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ wxPusherByNamespace: {
            default: { appToken: 'AT_EXPLICIT', topicIds: [7], backgroundOnly: true },
        } }))
        expect((await loadServerSettings(dir)).settings.wxPusherDestinations.get('default')).toEqual({
            appToken: 'AT_EXPLICIT', uids: [], topicIds: [7], backgroundOnly: true,
        })
    })

    it.each([
        [{ ' team': { appToken: 'AT_EXPLICIT', uids: ['UID_ONE'] } }, /invalid namespace/],
        [{ team: { uids: ['UID_ONE'] } }, /appToken must be a non-empty string/],
        [{ team: { appToken: 'AT_EXPLICIT', uids: [' '] } }, /at least one UID or topic ID/],
        [{ team: { appToken: 'AT_EXPLICIT', uids: ['UID_ONE'], backgroundOnly: 'true' } }, /backgroundOnly must be a boolean/],
    ])('rejects invalid namespace destinations without inheriting credentials', async (wxPusherByNamespace, error) => {
        dir = makeTempDir()
        process.env.WXPUSHER_APP_TOKEN = 'AT_LEGACY'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ wxPusherByNamespace }))
        await expect(loadServerSettings(dir)).rejects.toThrow(error)
    })

    it.each(['1,2,3,4,5,6', '12,nope'])('ignores superseded legacy topic IDs: %s', async topicIds => {
        dir = makeTempDir()
        process.env.WXPUSHER_APP_TOKEN = 'AT_LEGACY'
        process.env.WXPUSHER_TOPIC_IDS = topicIds
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ wxPusherByNamespace: {
            default: { appToken: 'AT_EXPLICIT', topicIds: [42] },
        } }))
        expect((await loadServerSettings(dir)).settings.wxPusherDestinations.get('default')?.topicIds).toEqual([42])
    })

    it('rejects an oversized legacy topic list', async () => {
        dir = makeTempDir()
        process.env.WXPUSHER_APP_TOKEN = 'AT_TEST'
        process.env.WXPUSHER_TOPIC_IDS = '1,2,3,4,5,6'
        await expect(loadServerSettings(dir)).rejects.toThrow(/at most 2000 distinct UIDs and 5 distinct topic IDs/)
    })

    it('rejects an oversized explicit UID list after deduplication', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ wxPusherByNamespace: {
            team: { appToken: 'AT_TEST', uids: Array.from({ length: 2001 }, (_, i) => `UID_${i}`) },
        } }))
        await expect(loadServerSettings(dir)).rejects.toThrow(/at most 2000 distinct UIDs and 5 distinct topic IDs/)
    })

    it('loads WxPusher settings from settings.json', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            wxPusherAppToken: 'AT_FILE',
            wxPusherUids: ['UID_FILE'],
            wxPusherTopicIds: [99],
            wxPusherNotification: true,
            wxPusherBackgroundOnly: true,
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.wxPusherAppToken).toBe('AT_FILE')
        expect(result.settings.wxPusherUids).toEqual(['UID_FILE'])
        expect(result.settings.wxPusherTopicIds).toEqual([99])
        expect(result.settings.wxPusherNotification).toBe(true)
        expect(result.settings.wxPusherBackgroundOnly).toBe(true)
        expect(result.sources.wxPusherAppToken).toBe('file')
        expect(result.sources.wxPusherUids).toBe('file')
        expect(result.sources.wxPusherTopicIds).toBe('file')
    })

    it('does not parse or persist flat recipient settings without a usable app token', async () => {
        dir = makeTempDir()
        const file = join(dir, 'settings.json')
        const saved = { wxPusherAppToken: '   ', wxPusherUids: 42 }
        writeFileSync(file, JSON.stringify(saved))
        process.env.WXPUSHER_TOPIC_IDS = '12,nope'
        const { settings } = await loadServerSettings(dir)
        expect(settings.wxPusherAppToken).toBeNull()
        expect(settings.wxPusherDestinations.size).toBe(0)
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject(saved)
    })

    it('rejects invalid WxPusher topic IDs from the environment', async () => {
        dir = makeTempDir()
        process.env.WXPUSHER_APP_TOKEN = ' AT_TEST '
        process.env.WXPUSHER_TOPIC_IDS = '12,nope'

        await expect(loadServerSettings(dir)).rejects.toThrow(
            'WXPUSHER_TOPIC_IDS must be a comma-separated list of positive integers'
        )
    })

    it('rejects invalid WxPusher recipient arrays from settings.json', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            wxPusherAppToken: 'AT_TEST',
            wxPusherUids: ['UID_OK', 123],
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('wxPusherUids must be an array of strings')
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
