import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type {
    HubUpgradeOffer,
    RunnerSelfUpgradeResponse,
} from '@hapi/protocol/upgradeChannel'
import packageJson from '../../package.json'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'

export type ApplyDecision =
    | { apply: true; reason: 'upgrade' }
    | { apply: false; reason: 'already-current' | 'unsupported' }

export function shouldApplyUpgradeOffer(
    offer: HubUpgradeOffer,
    localVersion: string,
): ApplyDecision {
    if (offer.channel === 'off') {
        return { apply: false, reason: 'unsupported' }
    }
    if (offer.channel === 'hub-artifact') {
        if (!offer.artifact?.url || !offer.artifact.sha256) {
            return { apply: false, reason: 'unsupported' }
        }
    }
    if (offer.channel === 'npm' && !offer.npmPackage) {
        return { apply: false, reason: 'unsupported' }
    }
    if (localVersion === offer.targetVersion) {
        return { apply: false, reason: 'already-current' }
    }
    return { apply: true, reason: 'upgrade' }
}

function upgradeBinDir(): string {
    return join(configuration.happyHomeDir || join(homedir(), '.hapi'), 'bin')
}

async function runCommand(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    const proc = Bun.spawn([command, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    const output = `${stdout}\n${stderr}`.trim()
    return { ok: exitCode === 0, output }
}

async function installFromNpm(offer: HubUpgradeOffer): Promise<void> {
    const pkg = `${offer.npmPackage}@${offer.targetVersion}`
    // Prefer bun global when available (matches many HAPI installs); fall back to npm.
    const bunTry = await runCommand('bun', ['add', '-g', pkg])
    if (bunTry.ok) {
        logger.debug('[SELF-UPGRADE] bun add -g succeeded', { pkg })
        return
    }
    logger.debug('[SELF-UPGRADE] bun add -g failed, trying npm', { output: bunTry.output })
    const npmTry = await runCommand('npm', ['install', '-g', pkg])
    if (!npmTry.ok) {
        throw new Error(`npm/bun install failed: ${npmTry.output || bunTry.output}`)
    }
}

async function sha256File(path: string): Promise<string> {
    const hasher = createHash('sha256')
    const file = Bun.file(path)
    hasher.update(Buffer.from(await file.arrayBuffer()))
    return hasher.digest('hex')
}

async function installFromArtifact(
    offer: HubUpgradeOffer,
    downloadBaseUrl: string,
    authToken: string,
): Promise<string> {
    const artifact = offer.artifact
    if (!artifact?.url || !artifact.sha256) {
        throw new Error('hub-artifact offer missing url/sha256')
    }

    const url = artifact.url.startsWith('http')
        ? new URL(artifact.url)
        : new URL(artifact.url, downloadBaseUrl.endsWith('/') ? downloadBaseUrl : `${downloadBaseUrl}/`)
    url.searchParams.set('platform', artifact.platform || process.platform)
    url.searchParams.set('arch', artifact.arch || process.arch)
    url.searchParams.set('version', offer.targetVersion)

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${authToken}`,
        },
    })
    if (!response.ok || !response.body) {
        throw new Error(`artifact download failed: HTTP ${response.status}`)
    }

    const dir = upgradeBinDir()
    mkdirSync(dir, { recursive: true })
    const tmpPath = join(dir, `hapi-${offer.targetVersion}.download`)
    const finalPath = join(dir, `hapi-${offer.targetVersion}`)
    const linkPath = join(dir, 'hapi')

    const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
    await pipeline(nodeStream, createWriteStream(tmpPath))

    const digest = await sha256File(tmpPath)
    if (digest !== artifact.sha256) {
        throw new Error(`artifact sha256 mismatch (got ${digest}, expected ${artifact.sha256})`)
    }

    chmodSync(tmpPath, 0o755)
    renameSync(tmpPath, finalPath)
    try {
        if (existsSync(linkPath)) {
            renameSync(linkPath, `${linkPath}.prev`)
        }
    } catch {
        // best-effort
    }
    try {
        // relative symlink hapi -> hapi-VERSION
        await Bun.write(join(dir, '.hapi-upgrade-target'), finalPath)
        // Use copy via spawn ln -sfn for atomic replace
        await runCommand('ln', ['-sfn', finalPath, linkPath])
    } catch (error) {
        logger.debug('[SELF-UPGRADE] symlink failed; binary still at versioned path', error)
    }

    return finalPath
}

function scheduleRunnerRelaunch(cliExecutable?: string): void {
    const env = { ...process.env }
    if (cliExecutable) {
        env.HAPI_CLI_EXECUTABLE = cliExecutable
    }
    // Replay runner start-sync so systemd/supervisor or detached child takes over.
    spawnHappyCLI(['runner', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env,
    }).unref()
    setTimeout(() => {
        process.exit(0)
    }, 250)
}

/**
 * Apply a hub upgrade offer on this runner host.
 * `downloadBaseUrl` is the hub public/base URL for relative artifact paths.
 * `authToken` is the CLI API token for authenticated artifact download.
 */
export async function applyRunnerSelfUpgrade(options: {
    offer: HubUpgradeOffer
    downloadBaseUrl: string
    authToken: string
    localVersion?: string
    requestShutdown?: () => void
}): Promise<RunnerSelfUpgradeResponse> {
    const localVersion = options.localVersion ?? packageJson.version
    const decision = shouldApplyUpgradeOffer(options.offer, localVersion)
    if (!decision.apply) {
        return {
            status: decision.reason === 'already-current' ? 'already-current' : 'unsupported',
            message: decision.reason === 'already-current'
                ? `Already at ${localVersion}`
                : `Upgrade channel ${options.offer.channel} not applicable`,
            channel: options.offer.channel,
        }
    }

    try {
        let installedExecutable: string | undefined
        if (options.offer.channel === 'npm') {
            await installFromNpm(options.offer)
        } else if (options.offer.channel === 'hub-artifact') {
            installedExecutable = await installFromArtifact(
                options.offer,
                options.downloadBaseUrl,
                options.authToken,
            )
        } else {
            return {
                status: 'unsupported',
                message: `Unknown channel ${options.offer.channel}`,
                channel: options.offer.channel,
            }
        }

        // Prefer relaunch with new binary; also request graceful runner stop.
        scheduleRunnerRelaunch(installedExecutable)
        options.requestShutdown?.()

        return {
            status: 'started',
            message: `Upgrade to ${options.offer.targetVersion} via ${options.offer.channel} started`,
            channel: options.offer.channel,
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.debug('[SELF-UPGRADE] failed', message)
        return {
            status: 'failed',
            message,
            channel: options.offer.channel,
        }
    }
}
