import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'
import { writeSettings } from './settings'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-server-settings-test-'))
}

describe('loadServerSettings', () => {
    let dir: string | null = null

    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
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

    it('writes hub settings with private file permissions', async () => {
        dir = makeTempDir()
        const settingsFile = join(dir, 'settings.json')

        await writeSettings(settingsFile, { cliApiToken: 'secret' })

        if (process.platform !== 'win32') {
            expect(statSync(dir).mode & 0o777).toBe(0o700)
            expect(statSync(settingsFile).mode & 0o777).toBe(0o600)
        }
    })
})
