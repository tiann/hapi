import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'

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

    it('defaults autoUpgradeRunners to false (opt-in)', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        const previous = process.env.HAPI_AUTO_UPGRADE_RUNNERS
        delete process.env.HAPI_AUTO_UPGRADE_RUNNERS
        try {
            const result = await loadServerSettings(dir)
            expect(result.settings.autoUpgradeRunners).toBe(false)
            expect(result.sources.autoUpgradeRunners).toBe('default')
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_AUTO_UPGRADE_RUNNERS
            } else {
                process.env.HAPI_AUTO_UPGRADE_RUNNERS = previous
            }
        }
    })

    it('enables autoUpgradeRunners from env', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        const previous = process.env.HAPI_AUTO_UPGRADE_RUNNERS
        process.env.HAPI_AUTO_UPGRADE_RUNNERS = '1'
        try {
            const result = await loadServerSettings(dir)
            expect(result.settings.autoUpgradeRunners).toBe(true)
            expect(result.sources.autoUpgradeRunners).toBe('env')
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_AUTO_UPGRADE_RUNNERS
            } else {
                process.env.HAPI_AUTO_UPGRADE_RUNNERS = previous
            }
        }
    })
})
