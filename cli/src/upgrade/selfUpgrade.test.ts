import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    __resetRunnerSelfUpgradeGateForTests,
    __setRunnerSelfUpgradeInFlightForTests,
    applyRunnerSelfUpgrade,
    artifactInstallFileName,
    assertExecutableMatchesTargetVersion,
    createArtifactDownloadSizeGuard,
    artifactDownloadRequestHeaders,
    assertArtifactDownloadAllowsBody,
    createDeadlineRunner,
    isRunnerSelfUpgradeInFlight,
    mergeParentRunnerStateForReclaim,
    pruneSupersededArtifacts,
    pruneSupersededArtifactsAfterDurableMarker,
    publishCurrentCliEntrypoint,
    remainingDeadlineMs,
    resolvePostNpmInstallExecutable,
    shouldApplyUpgradeOffer,
    shouldAttemptInstalledCliMtimeHandoff,
    terminateTimedOutUpgradeCandidate,
    UPGRADE_STEP_TIMEOUT_MS,
    versionProbeCommand,
    waitForChildSpawn,
} from './selfUpgrade'
import type { HubUpgradeOffer } from '@hapi/protocol/upgradeChannel'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseOffer = (overrides: Partial<HubUpgradeOffer> = {}): HubUpgradeOffer => ({
    channel: 'npm',
    targetVersion: '0.24.0',
    targetCapabilities: ['cursor-chat-store-status'],
    npmPackage: '@twsxtd/hapi',
    ...overrides,
})

class WritableTestSink extends Writable {
    constructor(private readonly chunks: Buffer[]) {
        super()
    }

    override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.chunks.push(Buffer.from(chunk))
        callback()
    }
}

describe('resolvePostNpmInstallExecutable', () => {
    it('returns the first PATH hit that exists on disk', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-npm-upgrade-'))
        const shim = join(dir, 'hapi')
        writeFileSync(shim, '#!/bin/sh\n')
        expect(resolvePostNpmInstallExecutable((name) => (name === 'hapi' ? shim : null))).toBe(shim)
    })

    it('returns null when nothing on PATH exists', () => {
        expect(resolvePostNpmInstallExecutable(() => '/tmp/definitely-missing-hapi-binary')).toBeNull()
        expect(resolvePostNpmInstallExecutable(() => null)).toBeNull()
    })

    it('prefers hapi.cmd over a bare POSIX hapi shim on Windows', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-win-npm-'))
        try {
            const bare = join(dir, 'hapi')
            const cmd = join(dir, 'hapi.cmd')
            writeFileSync(bare, '#!/bin/sh\n')
            writeFileSync(cmd, '@echo off\n')
            const found = resolvePostNpmInstallExecutable((name) => {
                if (name === 'hapi') return bare
                if (name === 'hapi.cmd') return cmd
                return null
            }, 'win32')
            expect(found).toBe(cmd)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('createArtifactDownloadSizeGuard', () => {
    it('aborts the stream once downloaded bytes exceed the advertised size', async () => {
        const { guard, getDownloadedBytes } = createArtifactDownloadSizeGuard(8)
        const chunks: Buffer[] = []
        const sink = new WritableTestSink(chunks)
        await expect(pipeline(
            Readable.from([Buffer.alloc(5, 1), Buffer.alloc(5, 2)]),
            guard,
            sink,
        )).rejects.toThrow(/exceeds advertised size/)
        expect(getDownloadedBytes()).toBeGreaterThan(8)
    })

    it('passes through when the stream stays within the limit', async () => {
        const { guard, getDownloadedBytes } = createArtifactDownloadSizeGuard(16)
        const chunks: Buffer[] = []
        await pipeline(
            Readable.from([Buffer.alloc(4, 1), Buffer.alloc(4, 2)]),
            guard,
            new WritableTestSink(chunks),
        )
        expect(getDownloadedBytes()).toBe(8)
        expect(Buffer.concat(chunks).length).toBe(8)
    })
})

describe('artifactDownloadRequestHeaders', () => {
    it('attaches hub Authorization when the artifact URL is same-origin with the hub', () => {
        const headers = artifactDownloadRequestHeaders({
            artifactUrl: new URL('http://hub.example:3006/api/upgrade/cli-artifact'),
            downloadBaseUrl: 'http://hub.example:3006',
            authToken: 'secret-token',
        })
        expect(headers.Authorization).toBe('Bearer secret-token')
    })

    it('omits hub credentials for absolute third-party artifact origins', () => {
        const headers = artifactDownloadRequestHeaders({
            artifactUrl: new URL('https://cdn.example/hapi-linux'),
            downloadBaseUrl: 'http://hub.example:3006',
            authToken: 'secret-token',
        })
        expect(headers).toEqual({})
    })
})

describe('assertArtifactDownloadAllowsBody', () => {
    it('rejects redirect responses so hub headers cannot follow off-origin', () => {
        expect(() => assertArtifactDownloadAllowsBody({
            status: 302,
            ok: false,
            body: null,
        })).toThrow(/redirects are not allowed/)
    })

    it('accepts a successful body-bearing response', () => {
        expect(() => assertArtifactDownloadAllowsBody({
            status: 200,
            ok: true,
            body: {},
        })).not.toThrow()
    })

    it('rejects HTML fallthrough so SPA index is not treated as an artifact', () => {
        expect(() => assertArtifactDownloadAllowsBody({
            status: 200,
            ok: true,
            body: {},
            headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
        })).toThrow(/HTML instead of a binary/)
    })
})

describe('shouldApplyUpgradeOffer', () => {
    it('skips when channel is off', () => {
        expect(shouldApplyUpgradeOffer(baseOffer({ channel: 'off' }), '0.20.0')).toEqual({
            apply: false,
            reason: 'unsupported',
        })
    })

    it('skips when local version and capabilities already match target', () => {
        expect(shouldApplyUpgradeOffer(
            baseOffer({
                targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
            }),
            '0.24.0',
            CURRENT_MACHINE_CAPABILITIES,
        )).toEqual({
            apply: false,
            reason: 'already-current',
        })
    })

    it('applies when version matches but target capabilities are missing', () => {
        expect(shouldApplyUpgradeOffer(
            baseOffer({
                targetVersion: '0.24.0',
                targetCapabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
            }),
            '0.24.0',
            ['cursor-chat-store-status'],
        )).toEqual({
            apply: true,
            reason: 'upgrade',
        })
    })

    it('applies at same semver when pre-generation runner lacks cli-artifact-generation', () => {
        // Chicken-egg: hub offers the marker cap; old binaries' CURRENT set omits it,
        // so hasTargetCapabilities fails and they download instead of "Already at X".
        expect(shouldApplyUpgradeOffer(
            baseOffer({
                channel: 'hub-artifact',
                targetVersion: '0.25.1',
                targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
                targetGeneration: 'gen-hub',
                artifact: {
                    url: '/api/upgrade/cli-artifact',
                    sha256: 'abc',
                    platform: 'linux',
                    arch: 'x64',
                    sizeBytes: 10,
                },
            }),
            '0.25.1',
            [
                'cursor-chat-store-status',
                'stop-runner',
                'runner-self-upgrade',
            ],
        )).toEqual({
            apply: true,
            reason: 'upgrade',
        })
    })

    it('applies when behind on npm channel', () => {
        expect(shouldApplyUpgradeOffer(baseOffer(), '0.20.0')).toEqual({
            apply: true,
            reason: 'upgrade',
        })
    })

    it('applies hub-artifact when behind', () => {
        expect(shouldApplyUpgradeOffer(baseOffer({
            channel: 'hub-artifact',
            artifact: {
                url: '/api/upgrade/cli-artifact',
                sha256: 'abc',
                platform: 'linux',
                arch: 'x64',
                sizeBytes: 10,
            },
        }), '0.18.4')).toEqual({
            apply: true,
            reason: 'upgrade',
        })
    })

    it('applies hub-artifact when version/capabilities match but generation drifts', () => {
        expect(shouldApplyUpgradeOffer(
            baseOffer({
                channel: 'hub-artifact',
                targetVersion: '0.24.0',
                targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
                targetGeneration: 'gen-b',
                artifact: {
                    url: '/api/upgrade/cli-artifact',
                    sha256: 'abc',
                    platform: 'linux',
                    arch: 'x64',
                    sizeBytes: 10,
                },
            }),
            '0.24.0',
            CURRENT_MACHINE_CAPABILITIES,
            'gen-a',
        )).toEqual({
            apply: true,
            reason: 'upgrade',
        })
    })

    it('skips hub-artifact when generation already matches', () => {
        expect(shouldApplyUpgradeOffer(
            baseOffer({
                channel: 'hub-artifact',
                targetVersion: '0.24.0',
                targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
                targetGeneration: 'gen-a',
                artifact: {
                    url: '/api/upgrade/cli-artifact',
                    sha256: 'abc',
                    platform: 'linux',
                    arch: 'x64',
                    sizeBytes: 10,
                },
            }),
            '0.24.0',
            CURRENT_MACHINE_CAPABILITIES,
            'gen-a',
        )).toEqual({
            apply: false,
            reason: 'already-current',
        })
    })

    it('refuses to downgrade when local version is ahead of the hub offer', () => {
        expect(shouldApplyUpgradeOffer(baseOffer({ targetVersion: '0.23.0' }), '0.25.0')).toEqual({
            apply: false,
            reason: 'unsupported',
        })
    })

    it('rejects hub-artifact without sha when apply would need verify', () => {
        expect(shouldApplyUpgradeOffer(baseOffer({
            channel: 'hub-artifact',
            artifact: {
                url: '/api/upgrade/cli-artifact',
                sha256: '',
                platform: 'linux',
                arch: 'x64',
                sizeBytes: 0,
            },
        }), '0.18.4')).toEqual({
            apply: false,
            reason: 'unsupported',
        })
    })
})

describe('assertExecutableMatchesTargetVersion', () => {
    it('accepts --version output that exactly matches the target', async () => {
        await expect(assertExecutableMatchesTargetVersion(
            '/fake/hapi',
            '0.24.0',
            async () => ({ ok: true, output: 'hapi version: 0.24.0\n' }),
        )).resolves.toBeUndefined()
    })

    it('rejects prefix/substring false positives (beta / trailing digit)', async () => {
        await expect(assertExecutableMatchesTargetVersion(
            '/fake/hapi',
            '0.24.0',
            async () => ({ ok: true, output: 'hapi version: 0.24.0-beta\n' }),
        )).rejects.toThrow(/does not match target 0\.24\.0/)
        await expect(assertExecutableMatchesTargetVersion(
            '/fake/hapi',
            '0.24.0',
            async () => ({ ok: true, output: 'hapi version: 0.24.00\n' }),
        )).rejects.toThrow(/does not match target 0\.24\.0/)
    })

    it('rejects an older PATH hit after install', async () => {
        await expect(assertExecutableMatchesTargetVersion(
            '/old/hapi',
            '0.24.0',
            async () => ({ ok: true, output: 'hapi version: 0.20.0\n' }),
        )).rejects.toThrow(/does not match target 0\.24\.0/)
    })

    it('rejects a failed version probe', async () => {
        await expect(assertExecutableMatchesTargetVersion(
            '/broken/hapi',
            '0.24.0',
            async () => ({ ok: false, output: 'ENOENT' }),
        )).rejects.toThrow(/does not match target/)
    })

    it('routes Windows .cmd shims through cmd.exe for the version probe', async () => {
        const calls: Array<{ command: string; args: string[] }> = []
        await assertExecutableMatchesTargetVersion(
            'C:\\Users\\me\\AppData\\Roaming\\npm\\hapi.cmd',
            '0.24.0',
            async (command, args) => {
                calls.push({ command, args })
                return { ok: true, output: 'hapi version: 0.24.0\n' }
            },
            'win32',
        )
        expect(calls).toHaveLength(1)
        expect(calls[0]!.command.toLowerCase()).toMatch(/cmd(\.exe)?$/)
        expect(calls[0]!.args).toEqual([
            '/d',
            '/s',
            '/c',
            '"C:\\Users\\me\\AppData\\Roaming\\npm\\hapi.cmd" --version',
        ])
    })

    it('probes non-shim executables directly', () => {
        expect(versionProbeCommand('/usr/local/bin/hapi', 'linux')).toEqual({
            command: '/usr/local/bin/hapi',
            args: ['--version'],
        })
        expect(versionProbeCommand('C:\\hapi\\hapi.exe', 'win32')).toEqual({
            command: 'C:\\hapi\\hapi.exe',
            args: ['--version'],
        })
        expect(versionProbeCommand('C:\\npm\\hapi.cmd', 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
            command: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/s', '/c', '"C:\\npm\\hapi.cmd" --version'],
        })
    })
})

describe('UPGRADE_STEP_TIMEOUT_MS', () => {
    it('stays under the hub upgrade RPC timeout (~10m)', () => {
        expect(UPGRADE_STEP_TIMEOUT_MS).toBe(9 * 60_000)
        expect(UPGRADE_STEP_TIMEOUT_MS).toBeLessThan(10 * 60_000)
    })
})

describe('remainingDeadlineMs / createDeadlineRunner', () => {
    it('never returns below 1ms once the deadline has passed', () => {
        expect(remainingDeadlineMs(1_000, 5_000)).toBe(1)
        expect(remainingDeadlineMs(5_000, 5_000)).toBe(1)
        expect(remainingDeadlineMs(10_000, 4_000)).toBe(6_000)
    })

    it('shrinks sequential timeouts so bun+npm cannot stack two full step budgets', async () => {
        const timeouts: number[] = []
        let now = 1_000
        const run = async (_command: string, _args: string[], timeoutMs: number) => {
            timeouts.push(timeoutMs)
            now += 4 * 60_000
            return { ok: false, output: 'stalled' }
        }
        const within = createDeadlineRunner(now + UPGRADE_STEP_TIMEOUT_MS, run, () => now)
        await within('bun', ['add', '-g', 'pkg'])
        await within('npm', ['install', '-g', 'pkg'])
        expect(timeouts[0]).toBe(UPGRADE_STEP_TIMEOUT_MS)
        expect(timeouts[1]).toBe(UPGRADE_STEP_TIMEOUT_MS - 4 * 60_000)
        // Allocated timeouts can sum above the budget; wall-clock cannot — npm
        // only gets whatever remains after bun burned time against the deadline.
        expect(timeouts[1]!).toBeLessThan(timeouts[0]!)
        expect(timeouts[1]!).toBeLessThan(10 * 60_000 - 4 * 60_000)
    })
})

describe('applyRunnerSelfUpgrade concurrency gate', () => {
    afterEach(() => {
        __resetRunnerSelfUpgradeGateForTests()
    })

    it('fails closed when another upgrade is already in progress', async () => {
        __setRunnerSelfUpgradeInFlightForTests(true)
        expect(isRunnerSelfUpgradeInFlight()).toBe(true)
        const result = await applyRunnerSelfUpgrade({
            offer: baseOffer(),
            downloadBaseUrl: 'http://localhost',
            authToken: 't',
            localVersion: '0.20.0',
        })
        expect(result).toEqual({
            status: 'failed',
            message: 'Runner upgrade already in progress',
            channel: 'npm',
        })
        expect(isRunnerSelfUpgradeInFlight()).toBe(true)
    })
})

describe('shouldAttemptInstalledCliMtimeHandoff', () => {
    const base = {
        disableVersionHandoff: false,
        selfUpgradeInFlight: false,
        installedCliMtimeMs: 200,
        startedWithCliMtimeMs: 100,
        now: 1_000,
        nextHandoffAttemptAt: 0,
    }

    it('allows mtime handoff when installed CLI drifted and the gate is idle', () => {
        expect(shouldAttemptInstalledCliMtimeHandoff(base)).toBe(true)
    })

    it('blocks mtime handoff while an RPC self-upgrade is still in flight', () => {
        expect(shouldAttemptInstalledCliMtimeHandoff({
            ...base,
            selfUpgradeInFlight: true,
        })).toBe(false)
    })

    it('blocks when version handoff is disabled or backoff has not elapsed', () => {
        expect(shouldAttemptInstalledCliMtimeHandoff({
            ...base,
            disableVersionHandoff: true,
        })).toBe(false)
        expect(shouldAttemptInstalledCliMtimeHandoff({
            ...base,
            nextHandoffAttemptAt: 5_000,
        })).toBe(false)
    })
})

describe('waitForChildSpawn', () => {
    it('resolves when the child emits spawn', async () => {
        const child = new EventEmitter()
        const pending = waitForChildSpawn(child)
        child.emit('spawn')
        await expect(pending).resolves.toBeUndefined()
    })

    it('rejects when the child emits error asynchronously (before lock release)', async () => {
        const child = new EventEmitter()
        const pending = waitForChildSpawn(child)
        queueMicrotask(() => {
            child.emit('error', new Error('ENOENT'))
        })
        await expect(pending).rejects.toThrow(/ENOENT/)
    })
})

describe('artifactInstallFileName', () => {
    it('embeds a sha prefix so same-version rebuilds use distinct paths', () => {
        const oldSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        const newSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        expect(artifactInstallFileName('0.25.1', oldSha, 'win32')).toBe('hapi-0.25.1-aaaaaaaaaaaaaaaa.exe')
        expect(artifactInstallFileName('0.25.1', newSha, 'win32')).toBe('hapi-0.25.1-bbbbbbbbbbbbbbbb.exe')
        expect(artifactInstallFileName('0.25.1', oldSha, 'linux')).toBe('hapi-0.25.1-aaaaaaaaaaaaaaaa')
        expect(artifactInstallFileName('0.25.1', oldSha, 'win32'))
            .not.toBe(artifactInstallFileName('0.25.1', newSha, 'win32'))
    })
})

describe('pruneSupersededArtifacts', () => {
    it('removes other versioned artifacts while keeping current link names', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-bin-prune-'))
        try {
            const keep = join(dir, 'hapi-0.25.1-bbbbbbbbbbbbbbbb')
            const oldA = join(dir, 'hapi-0.25.1-aaaaaaaaaaaaaaaa')
            const oldB = join(dir, 'hapi-0.24.0-cccccccccccccccc')
            const current = join(dir, 'hapi')
            const marker = join(dir, '.hapi-upgrade-target')
            writeFileSync(keep, 'keep')
            writeFileSync(oldA, 'old')
            writeFileSync(oldB, 'old')
            writeFileSync(current, 'link')
            writeFileSync(marker, '{}')

            pruneSupersededArtifacts(keep, dir)

            expect(existsSync(keep)).toBe(true)
            expect(existsSync(current)).toBe(true)
            expect(existsSync(marker)).toBe(true)
            expect(existsSync(oldA)).toBe(false)
            expect(existsSync(oldB)).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('skips prune when durable marker write failed so the prior target survives', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-bin-prune-gate-'))
        try {
            const keep = join(dir, 'hapi-0.25.1-bbbbbbbbbbbbbbbb')
            const prior = join(dir, 'hapi-0.25.1-aaaaaaaaaaaaaaaa')
            writeFileSync(keep, 'new')
            writeFileSync(prior, 'old-marker-target')

            pruneSupersededArtifactsAfterDurableMarker({
                markerError: new Error('ENOSPC'),
                channel: 'hub-artifact',
                keepPath: keep,
                binDir: dir,
            })
            expect(existsSync(prior)).toBe(true)
            expect(existsSync(keep)).toBe(true)

            pruneSupersededArtifactsAfterDurableMarker({
                markerError: null,
                channel: 'hub-artifact',
                keepPath: keep,
                binDir: dir,
            })
            expect(existsSync(prior)).toBe(false)
            expect(existsSync(keep)).toBe(true)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('mergeParentRunnerStateForReclaim', () => {
    it('keeps parent httpPort/mtime/hubReadyAt when the child polluted runner.state.json', () => {
        const parent = {
            pid: 100,
            httpPort: 4111,
            startTime: 'parent-start',
            startedWithCliVersion: '0.25.1',
            startedWithCliMtimeMs: 1_000,
            startedWithArgv: ['runner', 'start-sync', '--workspace-root', '/parent'],
            hubReadyAt: 55,
        }
        const childWrote = {
            ...parent,
            pid: 200,
            httpPort: 4999,
            startedWithCliMtimeMs: 9_999,
            hubReadyAt: 1,
            startedWithArgv: ['runner', 'start-sync'],
        }
        const restored = mergeParentRunnerStateForReclaim(parent, {
            pid: 100,
            lastHeartbeat: 'reclaimed',
        })
        expect(restored.httpPort).toBe(4111)
        expect(restored.startedWithCliMtimeMs).toBe(1_000)
        expect(restored.hubReadyAt).toBe(55)
        expect(restored.startedWithArgv).toEqual(['runner', 'start-sync', '--workspace-root', '/parent'])
        expect(restored.pid).toBe(100)
        expect(restored.lastHeartbeat).toBe('reclaimed')
        // Explicitly not the child's polluted values
        expect(restored.httpPort).not.toBe(childWrote.httpPort)
        expect(restored.startedWithCliMtimeMs).not.toBe(childWrote.startedWithCliMtimeMs)
    })
})

describe('publishCurrentCliEntrypoint', () => {
    it('restores the previous entrypoint when Unix link creation fails', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-entrypoint-'))
        try {
            const linkPath = join(dir, 'hapi')
            const finalPath = join(dir, 'hapi-0.99.0')
            writeFileSync(linkPath, 'old-entrypoint')
            writeFileSync(finalPath, 'new-binary')

            await expect(publishCurrentCliEntrypoint({
                finalPath,
                linkPath,
                platform: 'linux',
                run: async () => ({ ok: false, output: 'ln: failed' }),
            })).rejects.toThrow(/Failed to update current CLI link|ln: failed/)

            expect(existsSync(linkPath)).toBe(true)
            expect(readFileSync(linkPath, 'utf8')).toBe('old-entrypoint')
            expect(existsSync(`${linkPath}.prev`)).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('replaces the entrypoint when link creation succeeds', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-entrypoint-ok-'))
        try {
            const linkPath = join(dir, 'hapi')
            const finalPath = join(dir, 'hapi-0.99.0')
            writeFileSync(linkPath, 'old-entrypoint')
            writeFileSync(finalPath, 'new-binary')

            await publishCurrentCliEntrypoint({
                finalPath,
                linkPath,
                platform: 'linux',
                run: async (_command, args) => {
                    // Mimic ln -sfn target linkPath
                    const target = args[1]!
                    const path = args[2]!
                    writeFileSync(path, `symlink->${target}`)
                    return { ok: true, output: '' }
                },
            })

            expect(readFileSync(linkPath, 'utf8')).toBe(`symlink->${finalPath}`)
            expect(existsSync(`${linkPath}.prev`)).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('terminateTimedOutUpgradeCandidate', () => {
    it('force-kills the candidate so a timed-out handoff cannot take over later', async () => {
        const child = { pid: 4242 } as import('node:child_process').ChildProcess
        const kill = vi.fn(async () => true)
        await expect(terminateTimedOutUpgradeCandidate(child, kill)).resolves.toBe(true)
        expect(kill).toHaveBeenCalledWith(child, true)
    })

    it('returns false when the kill helper reports the tree is still alive', async () => {
        const child = { pid: 4242 } as import('node:child_process').ChildProcess
        const kill = vi.fn(async () => false)
        await expect(terminateTimedOutUpgradeCandidate(child, kill)).resolves.toBe(false)
    })

    it('returns false when the kill helper rejects', async () => {
        const child = { pid: 4242 } as import('node:child_process').ChildProcess
        const kill = vi.fn(async () => {
            throw new Error('ESRCH')
        })
        await expect(terminateTimedOutUpgradeCandidate(child, kill)).resolves.toBe(false)
    })
})
