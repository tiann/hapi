/**
 * Pinned tunwg binaries for hub-artifact compiles.
 *
 * Fleet-upgrade embeds these bytes into every upgraded runner — downloads must
 * use an immutable release tag and verified SHA-256 digests.
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Immutable release — bump deliberately with matching digests. */
export const TUNWG_RELEASE_TAG = 'v26.01.13+359bfa2'

export type TunwgPin = {
    /** Asset name on the GitHub release. */
    asset: string
    /** Filename under shared/tools/tunwg/. */
    filename: string
    sha256: string
}

export const TUNWG_PINS: Record<string, TunwgPin> = {
    'x64-linux': {
        asset: 'tunwg',
        filename: 'tunwg-x64-linux',
        sha256: 'a61c96c0b11e28cfc1904ad04779670e90133bae4e9bd17b979dad7de8319238',
    },
    'arm64-linux': {
        asset: 'tunwg-arm64',
        filename: 'tunwg-arm64-linux',
        sha256: '19be6977f84acb5a4ceac96deb829f967a188b7975fa67f2d174acf745d70891',
    },
    'x64-darwin': {
        asset: 'tunwg-darwin',
        filename: 'tunwg-x64-darwin',
        sha256: 'e226d325b4fadf43ee7138168b84da239e35c8ed82d4a87f0745f0769ae6b222',
    },
    'arm64-darwin': {
        asset: 'tunwg-darwin-arm64',
        filename: 'tunwg-arm64-darwin',
        sha256: '70c90b59e1aded850cf3b77d5eb6145302a17a91e7267e2d12a5a675fa1784cd',
    },
    'x64-win32': {
        asset: 'tunwg.exe',
        filename: 'tunwg-x64-win32.exe',
        sha256: 'dd52d035139e27402eadff761dbd1dda70c161551ae2eafcbc3ca0afa77b6f21',
    },
}

export function releaseDownloadUrl(asset: string): string {
    return `https://github.com/tiann/tunwg/releases/download/${encodeURIComponent(TUNWG_RELEASE_TAG)}/${asset}`
}

export function sha256Buffer(buffer: Buffer | Uint8Array): string {
    return createHash('sha256').update(buffer).digest('hex')
}

export function assertTunwgDigest(path: string, expectedSha256: string): void {
    const actual = sha256Buffer(readFileSync(path))
    if (actual !== expectedSha256) {
        throw new Error(`tunwg digest mismatch for ${path}: got ${actual}, expected ${expectedSha256}`)
    }
}

/** Default download budget when callers do not share an end-to-end artifact deadline. */
export const TUNWG_DOWNLOAD_TIMEOUT_MS = 9 * 60_000

async function downloadPinned(
    url: string,
    destPath: string,
    expectedSha256: string,
    timeoutMs: number = TUNWG_DOWNLOAD_TIMEOUT_MS,
): Promise<void> {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const digest = sha256Buffer(buffer)
    if (digest !== expectedSha256) {
        throw new Error(`tunwg digest mismatch for ${url}: got ${digest}, expected ${expectedSha256}`)
    }

    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, buffer)
}

export async function ensurePinnedTunwgBinary(options: {
    toolsDir: string
    platformKey: keyof typeof TUNWG_PINS
    /** Cap network work so callers holding artifactBuildLock can recover. */
    timeoutMs?: number
}): Promise<string> {
    const pin = TUNWG_PINS[options.platformKey]
    if (!pin) {
        throw new Error(`Unsupported tunwg platform: ${String(options.platformKey)}`)
    }
    const destPath = join(options.toolsDir, pin.filename)
    if (existsSync(destPath)) {
        try {
            assertTunwgDigest(destPath, pin.sha256)
            return destPath
        } catch {
            // Gitignored cache can hold older release bytes; replace with the pin.
            unlinkSync(destPath)
        }
    }
    await downloadPinned(
        releaseDownloadUrl(pin.asset),
        destPath,
        pin.sha256,
        options.timeoutMs ?? TUNWG_DOWNLOAD_TIMEOUT_MS,
    )
    if (!options.platformKey.includes('win32')) {
        chmodSync(destPath, 0o755)
    }
    return destPath
}

function platformKeyFor(platform: string, arch: string): keyof typeof TUNWG_PINS {
    if (platform === 'linux' && arch === 'x64') return 'x64-linux'
    if (platform === 'linux' && arch === 'arm64') return 'arm64-linux'
    if (platform === 'darwin' && arch === 'x64') return 'x64-darwin'
    if (platform === 'darwin' && arch === 'arm64') return 'arm64-darwin'
    if (platform === 'win32' && arch === 'x64') return 'x64-win32'
    throw new Error(`Unsupported tunwg platform/arch: ${platform}/${arch}`)
}

export async function ensurePinnedTunwgForCompile(
    monorepoRoot: string,
    platform: string,
    arch: string,
    timeoutMs?: number,
): Promise<string> {
    const toolsDir = join(monorepoRoot, 'shared', 'tools', 'tunwg')
    return ensurePinnedTunwgBinary({
        toolsDir,
        platformKey: platformKeyFor(platform, arch),
        timeoutMs,
    })
}
