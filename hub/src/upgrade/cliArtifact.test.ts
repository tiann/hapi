import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    ARTIFACT_BUILD_BUDGET_MS,
    artifactFileName,
    artifactInputStatKey,
    bunCompileTarget,
    contentAddressedArtifactFileName,
    findArtifactMetaBySha256,
    fingerprintArtifactInputStats,
    fingerprintArtifactInputs,
    HAPI_RUNNER_ONLY_FEATURE,
    isArtifactCacheFresh,
    normalizeCompiledArtifactPath,
    pruneRetainedArtifacts,
    resetArtifactOfferRetentionForTests,
    resolveArtifactSourceFingerprint,
    __resetArtifactFingerprintCacheForTests,
    __setFingerprintAttemptHookForTests,
    retainArtifactOffer,
    runnerArtifactCompileFeatures,
    TransientArtifactBuildError,
    type ArtifactMeta,
} from './cliArtifact'
import { TUNWG_DOWNLOAD_TIMEOUT_MS } from './tunwgPin'

describe('ARTIFACT_BUILD_BUDGET_MS', () => {
    it('keeps tunwg download + bun compile under the hub upgrade RPC window', () => {
        expect(ARTIFACT_BUILD_BUDGET_MS).toBe(9 * 60_000)
        expect(ARTIFACT_BUILD_BUDGET_MS).toBeLessThan(10 * 60_000)
        expect(TUNWG_DOWNLOAD_TIMEOUT_MS).toBe(ARTIFACT_BUILD_BUDGET_MS)
    })
})

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

describe('content-addressed artifact retention', () => {
    it('gives generation A and B distinct paths', () => {
        const a = contentAddressedArtifactFileName('0.25.1', 'linux', 'x64', 'aaaaaaaaaaaaaaaa' + '0'.repeat(48))
        const b = contentAddressedArtifactFileName('0.25.1', 'linux', 'x64', 'bbbbbbbbbbbbbbbb' + '0'.repeat(48))
        expect(a).toBe('hapi-0.25.1-linux-x64-aaaaaaaaaaaaaaaa')
        expect(b).toBe('hapi-0.25.1-linux-x64-bbbbbbbbbbbbbbbb')
        expect(a).not.toBe(b)
    })

    it('finds a retained digest after a newer generation is written beside it', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'hapi-artifact-retain-'))
        try {
            const root = join(dataDir, 'upgrade-artifacts')
            mkdirSync(root, { recursive: true })
            const shaA = 'a'.repeat(64)
            const shaB = 'b'.repeat(64)
            const pathA = join(root, contentAddressedArtifactFileName('0.25.1', 'linux', 'x64', 'aaaaaaaaaaaaaaaa'))
            const pathB = join(root, contentAddressedArtifactFileName('0.25.1', 'linux', 'x64', 'bbbbbbbbbbbbbbbb'))
            writeFileSync(pathA, 'gen-a-bytes')
            writeFileSync(pathB, 'gen-b-bytes')
            writeFileSync(`${pathA}.json`, JSON.stringify({
                version: '0.25.1',
                platform: 'linux',
                arch: 'x64',
                path: pathA,
                sha256: shaA,
                sizeBytes: 11,
                sourceFingerprint: 'aaaaaaaaaaaaaaaa',
            }))
            writeFileSync(`${pathB}.json`, JSON.stringify({
                version: '0.25.1',
                platform: 'linux',
                arch: 'x64',
                path: pathB,
                sha256: shaB,
                sizeBytes: 11,
                sourceFingerprint: 'bbbbbbbbbbbbbbbb',
            }))

            expect(findArtifactMetaBySha256(shaA, dataDir)?.path).toBe(pathA)
            expect(findArtifactMetaBySha256(shaB, dataDir)?.path).toBe(pathB)
            expect(findArtifactMetaBySha256('c'.repeat(64), dataDir)).toBeNull()
        } finally {
            rmSync(dataDir, { recursive: true, force: true })
        }
    })

    it('prunes older generations while preserving the offered digest', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'hapi-artifact-prune-'))
        resetArtifactOfferRetentionForTests()
        try {
            const root = join(dataDir, 'upgrade-artifacts')
            mkdirSync(root, { recursive: true })
            const paths: string[] = []
            const shas: string[] = []
            for (let i = 0; i < 5; i++) {
                const fp = `${'f'.repeat(15)}${i}`
                const sha = `${i}${'0'.repeat(63)}`
                const path = join(root, contentAddressedArtifactFileName('0.25.1', 'linux', 'x64', fp))
                writeFileSync(path, `bytes-${i}`)
                writeFileSync(`${path}.json`, JSON.stringify({
                    version: '0.25.1',
                    platform: 'linux',
                    arch: 'x64',
                    path,
                    sha256: sha,
                    sizeBytes: 7,
                    sourceFingerprint: fp,
                }))
                const when = new Date(Date.now() - (5 - i) * 60_000)
                utimesSync(path, when, when)
                utimesSync(`${path}.json`, when, when)
                paths.push(path)
                shas.push(sha)
            }

            retainArtifactOffer(shas[0]!)
            const removed = pruneRetainedArtifacts({
                dataDir,
                version: '0.25.1',
                platform: 'linux',
                arch: 'x64',
                preserveSha256: shas[4]!,
                keepGenerations: 2,
            })
            expect(removed.length).toBeGreaterThan(0)
            expect(existsSync(paths[0]!)).toBe(true) // recently offered
            expect(existsSync(paths[4]!)).toBe(true) // just built
            expect(existsSync(paths[1]!)).toBe(false) // beyond window, not offered
            expect(findArtifactMetaBySha256(shas[0]!, dataDir)?.path).toBe(paths[0]!)
        } finally {
            resetArtifactOfferRetentionForTests()
            rmSync(dataDir, { recursive: true, force: true })
        }
    })

    it('keeps a previously offered digest when later builds exceed the keep window', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'hapi-artifact-offer-retain-'))
        resetArtifactOfferRetentionForTests()
        try {
            const root = join(dataDir, 'upgrade-artifacts')
            mkdirSync(root, { recursive: true })
            const offeredSha = `a${'0'.repeat(63)}`
            const offeredPath = join(root, contentAddressedArtifactFileName('0.25.1', 'linux', 'x64', 'aaaaaaaaaaaaaaaa'))
            writeFileSync(offeredPath, 'offer-a')
            writeFileSync(`${offeredPath}.json`, JSON.stringify({
                version: '0.25.1',
                platform: 'linux',
                arch: 'x64',
                path: offeredPath,
                sha256: offeredSha,
                sizeBytes: 7,
                sourceFingerprint: 'aaaaaaaaaaaaaaaa',
            }))
            utimesSync(offeredPath, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000))
            utimesSync(`${offeredPath}.json`, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000))
            retainArtifactOffer(offeredSha)

            for (let i = 0; i < 4; i++) {
                const fp = `${'b'.repeat(15)}${i}`
                const sha = `${i + 1}${'0'.repeat(63)}`
                const path = join(root, contentAddressedArtifactFileName('0.25.1', 'linux', 'x64', fp))
                writeFileSync(path, `bytes-${i}`)
                writeFileSync(`${path}.json`, JSON.stringify({
                    version: '0.25.1',
                    platform: 'linux',
                    arch: 'x64',
                    path,
                    sha256: sha,
                    sizeBytes: 7,
                    sourceFingerprint: fp,
                }))
            }

            pruneRetainedArtifacts({
                dataDir,
                version: '0.25.1',
                platform: 'linux',
                arch: 'x64',
                preserveSha256: `4${'0'.repeat(63)}`,
                keepGenerations: 2,
            })
            expect(existsSync(offeredPath)).toBe(true)
            expect(findArtifactMetaBySha256(offeredSha, dataDir)?.sha256).toBe(offeredSha)
        } finally {
            resetArtifactOfferRetentionForTests()
            rmSync(dataDir, { recursive: true, force: true })
        }
    })
})

describe('bunCompileTarget', () => {
    it('maps fleet platforms including Windows (cross-compile from Linux hub)', () => {
        expect(bunCompileTarget('linux', 'x64')).toBe('bun-linux-x64-baseline')
        expect(bunCompileTarget('linux', 'arm64')).toBe('bun-linux-arm64')
        expect(bunCompileTarget('win32', 'x64')).toBe('bun-windows-x64')
        expect(bunCompileTarget('darwin', 'arm64')).toBe('bun-darwin-arm64')
    })

    it('rejects unsupported platform/arch instead of inventing a Bun target', () => {
        expect(() => bunCompileTarget('freebsd', 'x64')).toThrow('Unsupported compile target')
        expect(() => bunCompileTarget('win32', 'ia32')).toThrow('Unsupported compile target')
        expect(() => bunCompileTarget('win32', 'arm64')).toThrow('Unsupported compile target')
    })
})

describe('normalizeCompiledArtifactPath', () => {
    it('renames Bun-auto-suffixed .exe back to the extensionless artifact path', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-artifact-exe-'))
        try {
            const outPath = join(dir, 'hapi-0.23.1-win32-x64')
            writeFileSync(`${outPath}.exe`, 'PE-bytes')
            expect(normalizeCompiledArtifactPath(outPath, 'win32')).toBe(outPath)
            expect(existsSync(outPath)).toBe(true)
            expect(existsSync(`${outPath}.exe`)).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('prefers a fresh .exe over a stale extensionless outPath on same-version rebuild', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-artifact-stale-'))
        try {
            const outPath = join(dir, 'hapi-0.25.1-win32-x64')
            writeFileSync(outPath, 'OLD-PE-bytes')
            writeFileSync(`${outPath}.exe`, 'NEW-PE-bytes')
            const produced = normalizeCompiledArtifactPath(outPath, 'win32')
            expect(produced).toBe(outPath)
            expect(readFileSync(produced, 'utf8')).toBe('NEW-PE-bytes')
            expect(existsSync(`${outPath}.exe`)).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('leaves non-Windows paths alone', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-artifact-nix-'))
        try {
            const outPath = join(dir, 'hapi-0.23.1-linux-x64')
            writeFileSync(outPath, 'ELF-bytes')
            expect(normalizeCompiledArtifactPath(outPath, 'linux')).toBe(outPath)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('runnerArtifactCompileFeatures', () => {
    it('includes HAPI_RUNNER_ONLY so compile DCE skips embedded web assets without mutating the tree', () => {
        expect(runnerArtifactCompileFeatures('linux', 'x64')).toEqual([
            'HAPI_TARGET_LINUX_X64',
            HAPI_RUNNER_ONLY_FEATURE,
        ])
        expect(runnerArtifactCompileFeatures('win32', 'x64')).toContain(HAPI_RUNNER_ONLY_FEATURE)
    })
})

describe('fingerprintArtifactInputs / isArtifactCacheFresh', () => {
    it('changes when cli source changes at the same package version', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            writeFileSync(join(root, 'cli', 'bunfig.toml'), 'preload = []\n')

            const before = fingerprintArtifactInputs(root)
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 2\n')
            const after = fingerprintArtifactInputs(root)
            expect(before).not.toBe(after)
            expect(before).toHaveLength(64)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('changes when cli bunfig.toml changes at the same package version', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-bunfig-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            writeFileSync(join(root, 'cli', 'bunfig.toml'), 'preload = []\n')

            const before = fingerprintArtifactInputs(root)
            writeFileSync(join(root, 'cli', 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
            const after = fingerprintArtifactInputs(root)
            expect(before).not.toBe(after)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('ignores colocated *.test.ts changes that do not affect the compiled runner', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-test-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.test.ts'), 'export const t = 1\n')

            const before = fingerprintArtifactInputs(root)
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.test.ts'), 'export const t = 2\n')
            const after = fingerprintArtifactInputs(root)
            expect(after).toBe(before)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('changes when hub source changes at the same package version', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-hub-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export const hub = 1\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')

            const before = fingerprintArtifactInputs(root)
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export const hub = 2\n')
            expect(fingerprintArtifactInputs(root)).not.toBe(before)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('changes when an embedded tool asset is replaced', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-tool-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'cli', 'tools', 'archives'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            const archive = join(root, 'cli', 'tools', 'archives', 'ripgrep-x64-linux.tar.gz')
            writeFileSync(archive, 'old-bytes')

            const before = fingerprintArtifactInputs(root)
            writeFileSync(archive, 'new-bytes-longer')
            expect(fingerprintArtifactInputs(root)).not.toBe(before)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('is unchanged by an mtime-only touch of identical tool bytes', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-mtime-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'cli', 'tools', 'archives'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            const archive = join(root, 'cli', 'tools', 'archives', 'ripgrep-x64-linux.tar.gz')
            writeFileSync(archive, 'same-bytes')

            const before = fingerprintArtifactInputs(root)
            utimesSync(archive, new Date(2000, 0, 1), new Date(2000, 0, 1))
            expect(fingerprintArtifactInputs(root)).toBe(before)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('ignores hub embeddedAssets.generated.ts (runner compile DCE via HAPI_RUNNER_ONLY)', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-stub-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src', 'web'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            const manifest = join(root, 'hub', 'src', 'web', 'embeddedAssets.generated.ts')
            writeFileSync(manifest, 'export const embeddedAssets = [{ path: "a.js" }];\n')

            const before = fingerprintArtifactInputs(root)
            writeFileSync(manifest, 'export const embeddedAssets = [{ path: "b.js" }];\n')
            expect(fingerprintArtifactInputs(root)).toBe(before)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('ignores leftover fleet-upgrade .bak files in hub/src/web', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-bak-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src', 'web'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            writeFileSync(
                join(root, 'hub', 'src', 'web', 'embeddedAssets.generated.ts'),
                'export const embeddedAssets = [{ path: "a.js" }];\n',
            )

            const beforeContent = fingerprintArtifactInputs(root)
            const beforeStats = fingerprintArtifactInputStats(root)
            writeFileSync(
                join(root, 'hub', 'src', 'web', 'embeddedAssets.generated.ts.fleet-upgrade.1.2.abc.bak'),
                'export const embeddedAssets = [{ path: "stale.js" }];\n',
            )
            expect(fingerprintArtifactInputs(root)).toBe(beforeContent)
            expect(fingerprintArtifactInputStats(root)).toBe(beforeStats)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('invalidates the stats gate when same-size content is rewritten', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-stats-ns-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            const bootstrap = join(root, 'cli', 'src', 'bootstrap.ts')
            writeFileSync(bootstrap, 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')

            const beforeStats = fingerprintArtifactInputStats(root)
            const beforeContent = fingerprintArtifactInputs(root)
            // Bun/ext4 can keep mtime sticky across back-to-back same-tick writes;
            // wait so the rewrite gets a distinct timestamp.
            await Bun.sleep(5)
            writeFileSync(bootstrap, 'export const x = 2\n')
            expect(fingerprintArtifactInputStats(root)).not.toBe(beforeStats)
            expect(fingerprintArtifactInputs(root)).not.toBe(beforeContent)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('distinguishes same-size writes that share truncated mtimeMs but differ in ns', () => {
        const size = 19n
        const mtimeMsFloorNs = 1_785_431_298_036_000_000n
        const a = artifactInputStatKey({
            size,
            mtimeNs: mtimeMsFloorNs + 1n,
            ctimeNs: mtimeMsFloorNs + 1n,
        })
        const b = artifactInputStatKey({
            size,
            mtimeNs: mtimeMsFloorNs + 999_000n,
            ctimeNs: mtimeMsFloorNs + 1n,
        })
        // Both fall in the same truncated millisecond window.
        expect((mtimeMsFloorNs + 1n) / 1_000_000n)
            .toBe((mtimeMsFloorNs + 999_000n) / 1_000_000n)
        expect(a).not.toBe(b)
    })

    it('ignores downloaded tunwg platform caches under shared/tools', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-tunwg-fp-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'tools', 'tunwg'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'tools', 'tunwg', 'tunwg-linux-amd64'), 'linux-bytes')

            const before = fingerprintArtifactInputs(root)
            writeFileSync(join(root, 'shared', 'tools', 'tunwg', 'tunwg-windows-amd64.exe'), 'win-bytes')
            expect(fingerprintArtifactInputs(root)).toBe(before)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('surfaces mid-replace fingerprint races as TransientArtifactBuildError', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-artifact-churn-'))
        try {
            mkdirSync(join(root, 'cli', 'src'), { recursive: true })
            mkdirSync(join(root, 'hub', 'src'), { recursive: true })
            mkdirSync(join(root, 'shared', 'src'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.25.1' }))
            writeFileSync(join(root, 'cli', 'src', 'bootstrap.ts'), 'export const x = 1\n')
            writeFileSync(join(root, 'hub', 'src', 'startHub.ts'), 'export {}\n')
            writeFileSync(join(root, 'shared', 'src', 'index.ts'), 'export {}\n')

            __resetArtifactFingerprintCacheForTests()
            __setFingerprintAttemptHookForTests(() => {
                // Simulate soup rematerialize deleting an input mid-walk.
                throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
            })
            expect(() => resolveArtifactSourceFingerprint(root)).toThrow(TransientArtifactBuildError)
        } finally {
            __setFingerprintAttemptHookForTests(null)
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('treats legacy metas without sourceFingerprint as stale', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-artifact-legacy-'))
        try {
            const path = join(dir, 'hapi-0.25.1-linux-x64')
            const bytes = Buffer.from('bytes')
            writeFileSync(path, bytes)
            const sha256 = createHash('sha256').update(bytes).digest('hex')
            const legacy = {
                version: '0.25.1',
                platform: 'linux',
                arch: 'x64',
                path,
                sha256,
                sizeBytes: bytes.byteLength,
            } as ArtifactMeta
            expect(isArtifactCacheFresh(legacy, 'deadbeef')).toBe(false)
            expect(isArtifactCacheFresh({ ...legacy, sourceFingerprint: 'deadbeef' }, 'deadbeef')).toBe(true)
            expect(isArtifactCacheFresh({ ...legacy, sourceFingerprint: 'deadbeef' }, 'cafebabe')).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('rejects corrupted binaries that still have a matching sidecar fingerprint', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-artifact-corrupt-'))
        try {
            const path = join(dir, 'hapi-0.25.1-linux-x64')
            const good = Buffer.from('good-bytes')
            writeFileSync(path, good)
            const sha256 = createHash('sha256').update(good).digest('hex')
            const meta: ArtifactMeta = {
                version: '0.25.1',
                platform: 'linux',
                arch: 'x64',
                path,
                sha256,
                sizeBytes: good.byteLength,
                sourceFingerprint: 'deadbeef',
            }
            expect(isArtifactCacheFresh(meta, 'deadbeef')).toBe(true)
            writeFileSync(path, 'truncated')
            expect(isArtifactCacheFresh(meta, 'deadbeef')).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
