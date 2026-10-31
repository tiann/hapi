import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { resolveAndroidPushConfig, type AndroidPushSettings } from './androidPushConfig'

const base: AndroidPushSettings = { androidPushMode: null, iosPushRelayUrl: null, fcmServiceAccountPath: null }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function accountFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'android-push-'))
    dirs.push(dir)
    const file = join(dir, 'account.json')
    writeFileSync(file, contents)
    return file
}

describe('Android push routing', () => {
    it('defaults an unconfigured hub to the official relay and honors its URL override', () => {
        expect(resolveAndroidPushConfig(base)).toEqual({ mode: 'relay', relayUrl: 'https://push.hapi.run' })
        expect(resolveAndroidPushConfig({ ...base, iosPushRelayUrl: 'https://custom' })).toEqual({ mode: 'relay', relayUrl: 'https://custom' })
    })
    it('keeps configured private projects on direct FCM; explicit relay overrides credentials', () => {
        const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
        const fcmServiceAccountPath = accountFile(JSON.stringify({ project_id: 'private', client_email: 'a@b', private_key: key }))
        expect(resolveAndroidPushConfig({ ...base, fcmServiceAccountPath }).mode).toBe('fcm')
        expect(resolveAndroidPushConfig({ ...base, fcmServiceAccountPath, androidPushMode: 'relay' }).mode).toBe('relay')
    })
    it('never falls back to relay for malformed or missing configured accounts', () => {
        for (const fcmServiceAccountPath of ['/does/not/exist', accountFile('not json'), accountFile('{}'),
            accountFile(JSON.stringify({ project_id: 'private', client_email: 'a@b', private_key: 'corrupt' }))]) {
            expect(resolveAndroidPushConfig({ ...base, fcmServiceAccountPath }).mode).toBe('off')
        }
    })
    it('honors off and fails closed for unknown modes or fcm without credentials', () => {
        for (const androidPushMode of ['off', 'unknown', 'fcm']) {
            expect(resolveAndroidPushConfig({ ...base, androidPushMode }).mode).toBe('off')
        }
    })
})
