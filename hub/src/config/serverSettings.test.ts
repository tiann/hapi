import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-server-settings-test-'))
}

describe('loadServerSettings', () => {
    let dir: string | null = null
    const originalBackgroundOnly = process.env.SERVERCHAN_BACKGROUND_ONLY
    const originalWxPusherAppToken = process.env.WXPUSHER_APP_TOKEN
    const originalWxPusherUids = process.env.WXPUSHER_UIDS
    const originalWxPusherTopicIds = process.env.WXPUSHER_TOPIC_IDS
    const originalWxPusherNotification = process.env.WXPUSHER_NOTIFICATION
    const originalWxPusherBackgroundOnly = process.env.WXPUSHER_BACKGROUND_ONLY

    beforeEach(() => {
        delete process.env.SERVERCHAN_BACKGROUND_ONLY
        delete process.env.WXPUSHER_APP_TOKEN
        delete process.env.WXPUSHER_UIDS
        delete process.env.WXPUSHER_TOPIC_IDS
        delete process.env.WXPUSHER_NOTIFICATION
        delete process.env.WXPUSHER_BACKGROUND_ONLY
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
        if (originalWxPusherAppToken === undefined) {
            delete process.env.WXPUSHER_APP_TOKEN
        } else {
            process.env.WXPUSHER_APP_TOKEN = originalWxPusherAppToken
        }
        if (originalWxPusherUids === undefined) {
            delete process.env.WXPUSHER_UIDS
        } else {
            process.env.WXPUSHER_UIDS = originalWxPusherUids
        }
        if (originalWxPusherTopicIds === undefined) {
            delete process.env.WXPUSHER_TOPIC_IDS
        } else {
            process.env.WXPUSHER_TOPIC_IDS = originalWxPusherTopicIds
        }
        if (originalWxPusherNotification === undefined) {
            delete process.env.WXPUSHER_NOTIFICATION
        } else {
            process.env.WXPUSHER_NOTIFICATION = originalWxPusherNotification
        }
        if (originalWxPusherBackgroundOnly === undefined) {
            delete process.env.WXPUSHER_BACKGROUND_ONLY
        } else {
            process.env.WXPUSHER_BACKGROUND_ONLY = originalWxPusherBackgroundOnly
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
        process.env.WXPUSHER_NOTIFICATION = 'false'
        process.env.WXPUSHER_BACKGROUND_ONLY = 'true'

        const result = await loadServerSettings(dir)

        expect(result.settings.wxPusherAppToken).toBe('AT_TEST')
        expect(result.settings.wxPusherUids).toEqual(['UID_ONE', 'UID_TWO'])
        expect(result.settings.wxPusherTopicIds).toEqual([12, 34])
        expect(result.settings.wxPusherNotification).toBe(false)
        expect(result.settings.wxPusherBackgroundOnly).toBe(true)
        expect(result.sources.wxPusherAppToken).toBe('env')
        expect(result.sources.wxPusherUids).toBe('env')
        expect(result.sources.wxPusherTopicIds).toBe('env')
        expect(result.sources.wxPusherNotification).toBe('env')
        expect(result.sources.wxPusherBackgroundOnly).toBe('env')
    })

    it('loads WxPusher settings from settings.json', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            wxPusherAppToken: 'AT_FILE',
            wxPusherUids: ['UID_FILE'],
            wxPusherTopicIds: [99],
            wxPusherNotification: false,
            wxPusherBackgroundOnly: true,
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.wxPusherAppToken).toBe('AT_FILE')
        expect(result.settings.wxPusherUids).toEqual(['UID_FILE'])
        expect(result.settings.wxPusherTopicIds).toEqual([99])
        expect(result.settings.wxPusherNotification).toBe(false)
        expect(result.settings.wxPusherBackgroundOnly).toBe(true)
        expect(result.sources.wxPusherAppToken).toBe('file')
        expect(result.sources.wxPusherUids).toBe('file')
        expect(result.sources.wxPusherTopicIds).toBe('file')
    })

    it('rejects invalid WxPusher topic IDs from the environment', async () => {
        dir = makeTempDir()
        process.env.WXPUSHER_TOPIC_IDS = '12,nope'

        await expect(loadServerSettings(dir)).rejects.toThrow(
            'WXPUSHER_TOPIC_IDS must be a comma-separated list of positive integers'
        )
    })

    it('rejects invalid WxPusher recipient arrays from settings.json', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
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
