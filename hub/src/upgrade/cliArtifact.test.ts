import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactFileName, withStubEmbeddedAssets } from './cliArtifact'

describe('artifactFileName', () => {
    it('accepts normal version/platform/arch tokens', () => {
        expect(artifactFileName('0.23.0', 'linux', 'x64')).toBe('hapi-0.23.0-linux-x64')
        expect(artifactFileName('1.0.0-beta.1', 'darwin', 'arm64')).toBe('hapi-1.0.0-beta.1-darwin-arm64')
    })

    it('rejects path traversal and separators in any token', () => {
        expect(() => artifactFileName('../evil', 'linux', 'x64')).toThrow('Invalid artifact version')
        expect(() => artifactFileName('0.23.0', 'linux/../tmp', 'x64')).toThrow('Invalid artifact platform')
        expect(() => artifactFileName('0.23.0', 'linux', 'x64/../../tmp')).toThrow('Invalid artifact arch')
        expect(() => artifactFileName('0.23.0', 'linux', 'x64 with spaces')).toThrow('Invalid artifact arch')
    })
})

describe('withStubEmbeddedAssets', () => {
    it('restores the previous embeddedAssets.generated.ts after the callback', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-stub-assets-'))
        try {
            const webDir = join(root, 'hub', 'src', 'web')
            mkdirSync(webDir, { recursive: true })
            const manifest = join(webDir, 'embeddedAssets.generated.ts')
            const original = 'export const embeddedAssets = [{ path: "stale.js" }];\n'
            writeFileSync(manifest, original)

            let sawStub = false
            await withStubEmbeddedAssets(root, async () => {
                const during = readFileSync(manifest, 'utf8')
                expect(during).toContain('intentionally contains no embedded assets')
                expect(during).not.toContain('stale.js')
                sawStub = true
            })

            expect(sawStub).toBe(true)
            expect(readFileSync(manifest, 'utf8')).toBe(original)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('restores even when the callback throws', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-stub-assets-err-'))
        try {
            const webDir = join(root, 'hub', 'src', 'web')
            mkdirSync(webDir, { recursive: true })
            const manifest = join(webDir, 'embeddedAssets.generated.ts')
            const original = 'export const embeddedAssets = [{ path: "keep-me.js" }];\n'
            writeFileSync(manifest, original)

            await expect(withStubEmbeddedAssets(root, async () => {
                throw new Error('compile boom')
            })).rejects.toThrow('compile boom')

            expect(readFileSync(manifest, 'utf8')).toBe(original)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })
})
