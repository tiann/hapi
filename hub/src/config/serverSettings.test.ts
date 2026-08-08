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
})
