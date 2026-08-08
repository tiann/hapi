import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type {
    HubUpgradeOffer,
    RunnerSelfUpgradeResponse,
} from '@hapi/protocol/upgradeChannel'
import { compareHapiVersions } from '@hapi/protocol/upgradeChannel'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import packageJson from '../../package.json'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import { waitForRunnerHandoff } from '@/runner/controlClient'
import {
    reacquireRunnerLockAfterFailedHandoff,
    releaseRunnerLockForHandoff,
} from '@/runner/handoffLock'
import { readRunnerState, writeRunnerState, type RunnerLocallyPersistedState } from '@/persistence'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { writeUpgradeTarget, readUpgradeTarget, durableTargetGeneration } from '@/upgrade/upgradeTarget'
import { killProcessByChildProcess } from '@/utils/process'

export type ApplyDecision =
    | { apply: true; reason: 'upgrade' }
    | { apply: false; reason: 'already-current' | 'unsupported' }

function hasTargetCapabilities(
    offer: HubUpgradeOffer,
    localCapabilities: readonly string[],
): boolean {
    const local = new Set(localCapabilities)
    return offer.targetCapabilities.every((cap) => local.has(cap))
}

export function shouldApplyUpgradeOffer(
    offer: HubUpgradeOffer,
    localVersion: string,
    localCapabilities: readonly string[] = CURRENT_MACHINE_CAPABILITIES,
    localGeneration?: string | null,
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
    const generationDrift = offer.channel === 'hub-artifact'
        && typeof offer.targetGeneration === 'string'
        && offer.targetGeneration.length > 0
        && offer.targetGeneration !== (localGeneration ?? '')
    const versionRelation = compareHapiVersions(localVersion, offer.targetVersion)
    // Never downgrade a newer runner to an older hub offer.
    if (versionRelation !== null && versionRelation > 0) {
        return { apply: false, reason: 'unsupported' }
    }
    const versionMatches = versionRelation === 0
        || (versionRelation === null && localVersion === offer.targetVersion)
    // Fleet upgrade is capability-driven: same semver with missing target
    // capabilities (or a new hub-artifact generation) must still apply.
    if (
        versionMatches
        && hasTargetCapabilities(offer, localCapabilities)
        && !generationDrift
    ) {
        return { apply: false, reason: 'already-current' }
    }
    return { apply: true, reason: 'upgrade' }
}

function upgradeBinDir(): string {
    return join(configuration.happyHomeDir || join(homedir(), '.hapi'), 'bin')
}

/**
 * Content-addressed install name so same-version soup rebuilds land beside
 * (not on top of) a still-running binary. Critical on Windows where replacing
 * a mapped .exe fails; also keeps Unix handoffs from racing the live path.
 */
export function artifactInstallFileName(
    targetVersion: string,
    sha256: string,
    platform: NodeJS.Platform = process.platform,
): string {
    const id = sha256.slice(0, 16)
    const base = `hapi-${targetVersion}-${id}`
    return platform === 'win32' ? `${base}.exe` : base
}

/** Content-addressed install names only — never `hapi` / `hapi.exe` / marker. */
const VERSIONED_ARTIFACT_NAME_RE = /^hapi-.+-[0-9a-f]{16}(?:\.exe)?$/i

/**
 * Drop superseded hub-artifact binaries under ~/.hapi/bin after a durable
 * upgrade. Same-version soup rebuilds would otherwise grow disk without bound.
 * Best-effort: a mapped Windows PE may refuse unlink until the next cycle.
 */
export function pruneSupersededArtifacts(
    keepPath: string,
    binDir: string = upgradeBinDir(),
): void {
    let names: string[]
    try {
        names = readdirSync(binDir)
    } catch {
        return
    }
    for (const name of names) {
        if (!VERSIONED_ARTIFACT_NAME_RE.test(name)) {
            continue
        }
        const candidate = join(binDir, name)
        if (candidate === keepPath) {
            continue
        }
        try {
            unlinkSync(candidate)
        } catch {
            // Mapped Windows binary or race; retry on the next upgrade.
        }
    }
}

/**
 * Prune only after the durable marker for `keepPath` has been written.
 * If marker persistence failed, the previous marker may still point at an
 * older versioned binary — deleting it would strand the next supervisor restart.
 */
export function pruneSupersededArtifactsAfterDurableMarker(opts: {
    markerError: Error | null
    channel: string
    keepPath: string | undefined
    binDir?: string
}): void {
    if (opts.markerError || opts.channel !== 'hub-artifact' || !opts.keepPath) {
        return
    }
    pruneSupersededArtifacts(opts.keepPath, opts.binDir)
}

/**
 * Wall-clock budget for the whole npm-channel install path (bun → npm fallback
 * → resolve → version probe) and for each hub-artifact download. Must stay under
 * the hub's ~10m RunnerSelfUpgrade RPC so `runnerSelfUpgradeInFlight` can clear.
 */
export const UPGRADE_STEP_TIMEOUT_MS = 9 * 60_000

/** Remaining ms until a shared deadline; never returns 0 (Bun.spawn rejects it). */
export function remainingDeadlineMs(deadlineMs: number, nowMs = Date.now()): number {
    return Math.max(1, deadlineMs - nowMs)
}

/**
 * Bind sequential subprocesses to one wall-clock deadline so bun+npm cannot
 * stack two full step timeouts past the hub RPC.
 */
export function createDeadlineRunner(
    deadlineMs: number,
    run: (command: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; output: string }>,
    now: () => number = Date.now,
): (command: string, args: string[]) => Promise<{ ok: boolean; output: string }> {
    return (command, args) => run(command, args, remainingDeadlineMs(deadlineMs, now()))
}

async function runCommand(
    command: string,
    args: string[],
    timeoutMs: number = UPGRADE_STEP_TIMEOUT_MS,
): Promise<{ ok: boolean; output: string }> {
    try {
        const proc = Bun.spawn([command, ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: process.env,
            // Bun kills the child when the timeout elapses (default SIGTERM).
            timeout: timeoutMs,
        })
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        const output = `${stdout}\n${stderr}`.trim()
        if (exitCode !== 0 && proc.signalCode) {
            return {
                ok: false,
                output: output || `command timed out or killed (${proc.signalCode}) after ${timeoutMs}ms`,
            }
        }
        return { ok: exitCode === 0, output }
    } catch (error) {
        // Missing binary (e.g. no `bun` on PATH) throws before exit codes — treat as
        // failure so npm-channel installs can fall through to `npm install -g`.
        return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
}

async function installFromNpm(offer: HubUpgradeOffer): Promise<string> {
    const pkg = `${offer.npmPackage}@${offer.targetVersion}`
    // One budget for bun + npm fallback + resolve + probe — not per-step 9m.
    const runWithinBudget = createDeadlineRunner(Date.now() + UPGRADE_STEP_TIMEOUT_MS, runCommand)
    // Prefer bun global when available (matches many HAPI installs); fall back to npm.
    let manager: 'bun' | 'npm' = 'bun'
    const bunTry = await runWithinBudget('bun', ['add', '-g', pkg])
    if (bunTry.ok) {
        logger.debug('[SELF-UPGRADE] bun add -g succeeded', { pkg })
    } else {
        logger.debug('[SELF-UPGRADE] bun add -g failed, trying npm', { output: bunTry.output })
        const npmTry = await runWithinBudget('npm', ['install', '-g', pkg])
        if (!npmTry.ok) {
            throw new Error(`npm/bun install failed: ${npmTry.output || bunTry.output}`)
        }
        manager = 'npm'
    }
    const installed = await resolveInstalledGlobalHapi(manager, runWithinBudget)
    if (!installed) {
        throw new Error(
            'npm/bun install succeeded but no hapi binary found on PATH; cannot relaunch the new generation',
        )
    }
    await assertExecutableMatchesTargetVersion(installed, offer.targetVersion, runWithinBudget)
    return installed
}

/**
 * Prefer the package manager's global bin (the install we just performed) over
 * an older `hapi` earlier on PATH, then fall back to PATH resolution.
 */
async function resolveInstalledGlobalHapi(
    manager: 'bun' | 'npm',
    run: (command: string, args: string[]) => Promise<{ ok: boolean; output: string }> = runCommand,
): Promise<string | null> {
    const candidates = process.platform === 'win32'
        // Prefer a real PE, then Windows shims. Never the bare POSIX `hapi`
        // companion npm drops beside `hapi.cmd` — CreateProcess cannot run it.
        ? ['hapi.exe', 'hapi.cmd', 'hapi.bat']
        : ['hapi']
    if (manager === 'bun') {
        const bin = await run('bun', ['pm', 'bin', '-g'])
        const dir = bin.ok ? bin.output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim() : undefined
        if (dir) {
            for (const name of candidates) {
                const path = join(dir, name)
                if (existsSync(path)) {
                    return path
                }
            }
        }
    } else {
        // `npm bin -g` was removed in npm 9; resolve via prefix instead.
        // Unix: {prefix}/bin; Windows: binaries land directly in {prefix}.
        const prefix = await run('npm', ['prefix', '-g'])
        const prefixDir = prefix.ok
            ? prefix.output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim()
            : undefined
        if (prefixDir) {
            const dir = process.platform === 'win32' ? prefixDir : join(prefixDir, 'bin')
            for (const name of candidates) {
                const path = join(dir, name)
                if (existsSync(path)) {
                    return path
                }
            }
        }
    }
    return resolvePostNpmInstallExecutable()
}

/**
 * Build the command used to probe an installed hapi binary's --version.
 * Windows npm shims are `.cmd`/`.bat`; CreateProcess cannot run them directly,
 * so route through cmd.exe (same need as relaunch via cross-spawn, fixed argv).
 */
export function versionProbeCommand(
    installed: string,
    platform: NodeJS.Platform = process.platform,
    comSpec: string = process.env.ComSpec ?? 'cmd.exe',
): { command: string; args: string[] } {
    const isWindowsShim = platform === 'win32' && /\.(cmd|bat)$/i.test(installed)
    if (isWindowsShim) {
        return {
            command: comSpec,
            args: ['/d', '/s', '/c', `"${installed}" --version`],
        }
    }
    return { command: installed, args: ['--version'] }
}

/**
 * Fail closed when PATH still resolves an older generation after install.
 */
export async function assertExecutableMatchesTargetVersion(
    installed: string,
    targetVersion: string,
    run: (command: string, args: string[]) => Promise<{ ok: boolean; output: string }> = runCommand,
    platform: NodeJS.Platform = process.platform,
): Promise<void> {
    const { command, args } = versionProbeCommand(installed, platform)
    const probe = await run(command, args)
    const actual = probe.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('hapi version: '))
        ?.slice('hapi version: '.length)
    if (!probe.ok || actual !== targetVersion) {
        throw new Error(
            `Resolved hapi executable does not match target ${targetVersion}`
            + (probe.output ? ` (got: ${probe.output.slice(0, 200)})` : ''),
        )
    }
}

/**
 * After a global npm/bun install, prefer the PATH shim (or platform binary) over
 * `process.execPath`. Compiled runners otherwise relaunch themselves via
 * spawnHappyCLI and stay on the old generation.
 */
export function resolvePostNpmInstallExecutable(
    which: (command: string) => string | null = (command) => Bun.which(command),
    platform: NodeJS.Platform = process.platform,
): string | null {
    // Prefer a real PE on Windows over npm shims. Never the bare POSIX `hapi`
    // companion npm drops beside `hapi.cmd` — CreateProcess cannot run it.
    const candidates = platform === 'win32'
        ? ['hapi.exe', 'hapi.cmd', 'hapi.bat']
        : ['hapi']
    for (const name of candidates) {
        const found = which(name)?.trim()
        if (found && existsSync(found)) {
            return found
        }
    }
    return null
}

async function sha256File(path: string): Promise<string> {
    const hasher = createHash('sha256')
    const file = Bun.file(path)
    hasher.update(Buffer.from(await file.arrayBuffer()))
    return hasher.digest('hex')
}

/**
 * Stream transform that aborts once downloaded bytes exceed the offer's
 * advertised `sizeBytes`. Prevents a malicious/malformed response from filling
 * disk before the post-download SHA-256 check.
 */
export function createArtifactDownloadSizeGuard(sizeBytes: number | undefined): {
    guard: Transform
    getDownloadedBytes: () => number
} {
    let downloadedBytes = 0
    const limit = typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0
        ? sizeBytes
        : null
    const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            downloadedBytes += chunk.length
            if (limit !== null && downloadedBytes > limit) {
                callback(new Error(`artifact exceeds advertised size (${downloadedBytes} > ${limit})`))
                return
            }
            callback(null, chunk)
        },
    })
    return {
        guard,
        getDownloadedBytes: () => downloadedBytes,
    }
}

/**
 * Hub auth + extra headers are only for same-origin hub artifact URLs.
 * Absolute CDN/third-party artifact origins must not receive the runner token.
 */
export function artifactDownloadRequestHeaders(options: {
    artifactUrl: URL
    downloadBaseUrl: string
    authToken: string
}): Record<string, string> {
    let hubOrigin: string
    try {
        hubOrigin = new URL(options.downloadBaseUrl).origin
    } catch {
        return {}
    }
    if (options.artifactUrl.origin !== hubOrigin) {
        return {}
    }
    return buildHubRequestHeaders({
        Authorization: `Bearer ${options.authToken}`,
    })
}

/** Fail closed: never follow redirects that could carry hub headers off-origin. */
export function assertArtifactDownloadAllowsBody(response: {
    status: number
    ok: boolean
    body: unknown
    headers?: { get(name: string): string | null }
}): void {
    if (response.status >= 300 && response.status < 400) {
        throw new Error('artifact redirects are not allowed')
    }
    if (!response.ok || !response.body) {
        throw new Error(`artifact download failed: HTTP ${response.status}`)
    }
    // SPA / reverse-proxy fallthrough returns 200 text/html (e.g. web dist
    // index.html) when /cli/upgrade/cli-artifact is not mounted. Reject before
    // streaming so operators see a clear error instead of a size mismatch.
    const contentType = response.headers?.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('text/html')) {
        throw new Error(
            'artifact download returned HTML instead of a binary '
            + '(hub upgrade route missing or proxied to the web app)',
        )
    }
}

/**
 * Point ~/.hapi/bin/hapi(.exe) at the newly installed versioned binary.
 * Parks the previous entrypoint at `.prev` and restores it if link/copy fails
 * so supervisors do not lose the launch path mid-upgrade.
 */
export async function publishCurrentCliEntrypoint(options: {
    finalPath: string
    linkPath: string
    platform?: NodeJS.Platform
    run?: (command: string, args: string[]) => Promise<{ ok: boolean; output: string }>
}): Promise<void> {
    const isWin = (options.platform ?? process.platform) === 'win32'
    const previousPath = `${options.linkPath}.prev`
    const run = options.run ?? runCommand
    try {
        if (existsSync(options.linkPath)) {
            renameSync(options.linkPath, previousPath)
        }
    } catch {
        // best-effort park of the previous entrypoint
    }
    try {
        if (isWin) {
            copyFileSync(options.finalPath, options.linkPath)
        } else {
            const linked = await run('ln', ['-sfn', options.finalPath, options.linkPath])
            if (!linked.ok) {
                throw new Error(linked.output || 'Failed to update current CLI link')
            }
        }
        try {
            if (existsSync(previousPath)) {
                unlinkSync(previousPath)
            }
        } catch {
            // best-effort cleanup of previous current binary
        }
    } catch (error) {
        if (!existsSync(options.linkPath) && existsSync(previousPath)) {
            renameSync(previousPath, options.linkPath)
        }
        throw error
    }
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
        redirect: 'manual',
        signal: AbortSignal.timeout(UPGRADE_STEP_TIMEOUT_MS),
        headers: artifactDownloadRequestHeaders({
            artifactUrl: url,
            downloadBaseUrl,
            authToken,
        }),
    })
    assertArtifactDownloadAllowsBody(response)

    const dir = upgradeBinDir()
    mkdirSync(dir, { recursive: true })
    // Windows CreateProcess needs a .exe suffix; keep the versioned binary and
    // the "current" link name with .exe so relaunch + scheduled tasks work.
    // Include a sha256 prefix so same-version rebuilds do not rename over the
    // still-running executable (Windows cannot replace a mapped PE).
    const isWin = process.platform === 'win32'
    const versionedName = artifactInstallFileName(offer.targetVersion, artifact.sha256, process.platform)
    const currentName = isWin ? 'hapi.exe' : 'hapi'
    const tmpPath = join(dir, `${versionedName}.download`)
    const finalPath = join(dir, versionedName)
    const linkPath = join(dir, currentName)

    const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
    const { guard: sizeGuard, getDownloadedBytes } = createArtifactDownloadSizeGuard(artifact.sizeBytes)
    try {
        await pipeline(nodeStream, sizeGuard, createWriteStream(tmpPath))
        const downloadedBytes = getDownloadedBytes()
        if (
            typeof artifact.sizeBytes === 'number'
            && artifact.sizeBytes > 0
            && downloadedBytes !== artifact.sizeBytes
        ) {
            throw new Error(
                `artifact size mismatch: got ${downloadedBytes}, expected ${artifact.sizeBytes}`,
            )
        }
    } catch (error) {
        try {
            if (existsSync(tmpPath)) {
                unlinkSync(tmpPath)
            }
        } catch {
            // best-effort cleanup of partial download
        }
        throw error
    }

    const digest = await sha256File(tmpPath)
    if (digest !== artifact.sha256) {
        throw new Error(`artifact sha256 mismatch (got ${digest}, expected ${artifact.sha256})`)
    }

    if (!isWin) {
        chmodSync(tmpPath, 0o755)
    }
    if (existsSync(finalPath) && await sha256File(finalPath) === artifact.sha256) {
        unlinkSync(tmpPath)
    } else {
        renameSync(tmpPath, finalPath)
    }
    await publishCurrentCliEntrypoint({
        finalPath,
        linkPath,
        platform: process.platform,
    })

    return finalPath
}

async function scheduleRunnerRelaunch(cliExecutable: string): Promise<ChildProcess> {
    const state = await readRunnerState()
    const args = Array.isArray(state?.startedWithArgv) && state.startedWithArgv[0] === 'runner'
        ? state.startedWithArgv
        : ['runner', 'start-sync']
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Authorized handoff: child must not stopRunner() against this PID.
        HAPI_RUNNER_HANDOFF_FROM_PID: String(process.pid),
        // Always pin the child to the freshly installed binary. Never fall back
        // to spawnHappyCLI / process.execPath — compiled runners would relaunch
        // the old generation and report a false "started".
        HAPI_CLI_EXECUTABLE: cliExecutable,
    }
    // Windows npm shims are `.cmd`/`.bat` and need CreateProcess via cmd.exe with
    // escaped argv. Prefer hapi.exe via resolvePostNpmInstallExecutable when
    // present so we usually avoid this path. Never shell:true — spawn args
    // (workspace roots, etc.) must not hit cmd metacharacter parsing.
    const isWindowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliExecutable)
    const child = (isWindowsShim ? crossSpawn : spawn)(cliExecutable, args, {
        detached: true,
        stdio: 'ignore',
        env,
        windowsHide: process.platform === 'win32',
    }) as ChildProcess
    // Wait for OS spawn success/failure before releasing the runner lock.
    // spawn() itself rarely throws; launch errors arrive on the 'error' event.
    await waitForChildSpawn(child)
    child.unref()
    // Do not process.exit here. ApiMachineClient delays requestShutdown by
    // ~500ms so runner lock/state cleanup can run; a hard exit races that and
    // skips cleanup. Caller invokes requestShutdown after handoff confirms.
    return child
}

/**
 * Force-kill a replacement that timed out before hubReadyAt so it cannot
 * acquire the runner lock later and perform a delayed takeover.
 * Returns true only when the kill helper reports the tree is gone.
 */
export async function terminateTimedOutUpgradeCandidate(
    candidate: ChildProcess,
    kill: (child: ChildProcess, force?: boolean) => Promise<boolean> = killProcessByChildProcess,
): Promise<boolean> {
    return await kill(candidate, true).catch(() => false)
}

/** Minimal event surface shared by ChildProcess and test doubles. */
type SpawnEventTarget = {
    once(event: 'spawn', listener: () => void): unknown
    once(event: 'error', listener: (error: Error) => void): unknown
    off(event: 'spawn', listener: () => void): unknown
    off(event: 'error', listener: (error: Error) => void): unknown
}

/** Exported for tests: resolve when child process has spawned, reject on error. */
export function waitForChildSpawn(child: SpawnEventTarget): Promise<void> {
    return new Promise((resolve, reject) => {
        const onSpawn = (): void => {
            child.off('error', onError)
            resolve()
        }
        const onError = (error: Error): void => {
            child.off('spawn', onSpawn)
            reject(error)
        }
        child.once('spawn', onSpawn)
        child.once('error', onError)
    })
}

let runnerSelfUpgradeInFlight = false

/** True while an RPC self-upgrade owns the install/handoff transition. */
export function isRunnerSelfUpgradeInFlight(): boolean {
    return runnerSelfUpgradeInFlight
}

/**
 * Whether the runner heartbeat should attempt an installed-CLI mtime handoff.
 * Skips while an RPC self-upgrade is still installing/handing off so npm
 * channel mtime churn cannot spawn a second competing replacement.
 */
export function shouldAttemptInstalledCliMtimeHandoff(options: {
    disableVersionHandoff: boolean
    selfUpgradeInFlight: boolean
    installedCliMtimeMs: number | null | undefined
    startedWithCliMtimeMs: number | null | undefined
    now: number
    nextHandoffAttemptAt: number
}): boolean {
    if (options.disableVersionHandoff || options.selfUpgradeInFlight) {
        return false
    }
    const installed = options.installedCliMtimeMs
    const started = options.startedWithCliMtimeMs
    return typeof installed === 'number'
        && typeof started === 'number'
        && Number.isFinite(installed)
        && Number.isFinite(started)
        && installed !== started
        && options.now >= options.nextHandoffAttemptAt
}

/**
 * Apply a hub upgrade offer on this runner host.
 * `downloadBaseUrl` is the hub public/base URL for relative artifact paths.
 * `authToken` is the CLI API token for authenticated artifact download.
 *
 * Concurrent RPCs fail closed — overlapping installs/relaunches race on the
 * runner lock and durable upgrade-target marker.
 */
export async function applyRunnerSelfUpgrade(options: {
    offer: HubUpgradeOffer
    downloadBaseUrl: string
    authToken: string
    localVersion?: string
    localGeneration?: string | null
    requestShutdown?: () => void
}): Promise<RunnerSelfUpgradeResponse> {
    if (runnerSelfUpgradeInFlight) {
        return {
            status: 'failed',
            message: 'Runner upgrade already in progress',
            channel: options.offer.channel,
        }
    }
    runnerSelfUpgradeInFlight = true
    try {
        const outcome = await applyRunnerSelfUpgradeUnlocked(options)
        // Keep the gate set when this process is about to exit after handoff —
        // clearing here would let the mtime heartbeat spawn a competing
        // replacement before process.exit runs.
        if (!outcome.exitScheduled) {
            runnerSelfUpgradeInFlight = false
        }
        return outcome.response
    } catch (error) {
        runnerSelfUpgradeInFlight = false
        throw error
    }
}

/** Test helper: reset the module-level upgrade gate between cases. */
export function __resetRunnerSelfUpgradeGateForTests(): void {
    runnerSelfUpgradeInFlight = false
}

/** Test helper: simulate an in-flight upgrade for concurrency tests. */
export function __setRunnerSelfUpgradeInFlightForTests(value: boolean): void {
    runnerSelfUpgradeInFlight = value
}

/**
 * After a failed handoff the child may have overwritten runner.state.json.
 * Restore the parent's full snapshot (port, hubReadyAt, mtime, argv, …) so
 * local control and version guards do not follow the dead child's values.
 */
export function mergeParentRunnerStateForReclaim(
    parentState: RunnerLocallyPersistedState,
    opts: { pid: number; lastHeartbeat: string },
): RunnerLocallyPersistedState {
    return {
        ...parentState,
        pid: opts.pid,
        lastHeartbeat: opts.lastHeartbeat,
    }
}

export function restoreParentRunnerStateAfterFailedHandoff(
    parentState: RunnerLocallyPersistedState | null | undefined,
    opts: { pid?: number; lastHeartbeat?: string } = {},
): void {
    if (!parentState) {
        return
    }
    writeRunnerState(mergeParentRunnerStateForReclaim(parentState, {
        pid: opts.pid ?? process.pid,
        lastHeartbeat: opts.lastHeartbeat ?? new Date().toISOString(),
    }))
}

type UpgradeOutcome = {
    response: RunnerSelfUpgradeResponse
    /** True when this process already scheduled exit / shutdown after handoff. */
    exitScheduled: boolean
}

function stayAlive(response: RunnerSelfUpgradeResponse): UpgradeOutcome {
    return { response, exitScheduled: false }
}

function scheduleExit(response: RunnerSelfUpgradeResponse): UpgradeOutcome {
    return { response, exitScheduled: true }
}

async function applyRunnerSelfUpgradeUnlocked(options: {
    offer: HubUpgradeOffer
    downloadBaseUrl: string
    authToken: string
    localVersion?: string
    localGeneration?: string | null
    requestShutdown?: () => void
}): Promise<UpgradeOutcome> {
    const localVersion = options.localVersion ?? packageJson.version
    const localGeneration = options.localGeneration
        ?? durableTargetGeneration(readUpgradeTarget())
    const decision = shouldApplyUpgradeOffer(
        options.offer,
        localVersion,
        CURRENT_MACHINE_CAPABILITIES,
        localGeneration,
    )
    if (!decision.apply) {
        return stayAlive({
            status: decision.reason === 'already-current' ? 'already-current' : 'unsupported',
            message: decision.reason === 'already-current'
                ? `Already at ${localVersion}`
                : `Upgrade channel ${options.offer.channel} not applicable`,
            channel: options.offer.channel,
        })
    }

    try {
        let installedExecutable: string | undefined
        if (options.offer.channel === 'npm') {
            installedExecutable = await installFromNpm(options.offer)
        } else if (options.offer.channel === 'hub-artifact') {
            installedExecutable = await installFromArtifact(
                options.offer,
                options.downloadBaseUrl,
                options.authToken,
            )
        } else {
            return stayAlive({
                status: 'unsupported',
                message: `Unknown channel ${options.offer.channel}`,
                channel: options.offer.channel,
            })
        }

        // Capture before spawn: the child may overwrite runner.state.json, and a
        // failed handoff must restore THIS process's identity — not the child's.
        const parentState = await readRunnerState()

        // Spawn replacement, release the runner lock so the child can register,
        // then wait for handoff before shutting down. Mirrors run.ts mtime handoff
        // so a failed child does not leave the machine offline after a "started" RPC.
        const candidate = await scheduleRunnerRelaunch(installedExecutable)
        await releaseRunnerLockForHandoff()
        const handoffOk = await waitForRunnerHandoff(process.pid, { timeoutMs: 30_000 })
        if (!handoffOk) {
            // Child may still be retrying the runner lock (~885s budget). Kill it
            // before reclaiming so a later lock gap cannot produce a delayed takeover.
            const stopped = await terminateTimedOutUpgradeCandidate(candidate)
            if (!stopped) {
                // Surviving candidate + reclaim would recreate the race. Exit so
                // a supervisor can restart a known-good generation instead.
                logger.debug('[SELF-UPGRADE] Could not stop timed-out replacement; exiting')
                if (options.requestShutdown) {
                    options.requestShutdown()
                } else {
                    setTimeout(() => {
                        process.exit(1)
                    }, 250)
                }
                return scheduleExit({
                    status: 'failed',
                    message: 'Replacement could not be stopped; current runner is exiting',
                    channel: options.offer.channel,
                })
            }
            // Mirror run.ts mtime handoff: never stay alive without the lock.
            // Child may have written runner.state.json then died — reclaim PID.
            // Do NOT rewrite the durable marker — a failed target must not become
            // the next supervisor restart's entrypoint.
            const reacquired = await reacquireRunnerLockAfterFailedHandoff()
            if (!reacquired) {
                logger.debug('[SELF-UPGRADE] Could not re-acquire runner lock after failed handoff; exiting cleanly')
                if (options.requestShutdown) {
                    options.requestShutdown()
                } else {
                    setTimeout(() => {
                        process.exit(0)
                    }, 250)
                }
                return scheduleExit({
                    status: 'failed',
                    message: 'Replacement did not register and runner lock could not be reacquired; exiting',
                    channel: options.offer.channel,
                })
            }
            try {
                restoreParentRunnerStateAfterFailedHandoff(parentState)
            } catch (error) {
                logger.debug('[SELF-UPGRADE] Failed to reclaim runner.state.json after failed handoff', error)
            }
            logger.debug('[SELF-UPGRADE] Replacement did not register; current runner reclaimed lock and stays up')
            return stayAlive({
                status: 'failed',
                message: 'Replacement runner did not register; current runner left running',
                channel: options.offer.channel,
            })
        }

        // Handoff confirmed — only then make the target durable for supervisor restarts.
        // Always retire this process even if the marker write fails: the child owns
        // the lock. Leaving the old runner alive would mean two live machine sockets.
        let markerError: Error | null = null
        try {
            writeUpgradeTarget({
                path: installedExecutable,
                targetVersion: options.offer.targetVersion,
                targetCapabilities: [...options.offer.targetCapabilities],
                targetGeneration: options.offer.targetGeneration
                    || (options.offer.channel === 'hub-artifact' ? options.offer.artifact?.sha256 : undefined),
            })
        } catch (error) {
            markerError = error instanceof Error ? error : new Error(String(error))
            logger.debug('[SELF-UPGRADE] Durable target write failed after confirmed handoff', markerError)
        }

        // Only prune after the new marker is durable — otherwise a failed write
        // would delete the previous content-addressed binary the old marker still
        // points at, and the next supervisor restart could not recover.
        pruneSupersededArtifactsAfterDurableMarker({
            markerError,
            channel: options.offer.channel,
            keepPath: installedExecutable,
        })

        // Handoff confirmed. Exit WITHOUT requestShutdown/cleanupRunnerState —
        // those would delete the child's runner.state.json and lock. Matches the
        // mtime handoff path in run.ts (process.exit after waitForRunnerHandoff).
        setTimeout(() => {
            process.exit(0)
        }, 250)

        if (markerError) {
            return scheduleExit({
                status: 'failed',
                message: `Replacement is running, but the durable target could not be saved: ${markerError.message}`,
                channel: options.offer.channel,
            })
        }

        return scheduleExit({
            status: 'started',
            message: `Upgrade to ${options.offer.targetVersion} via ${options.offer.channel} started`,
            channel: options.offer.channel,
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.debug('[SELF-UPGRADE] failed', message)
        return stayAlive({
            status: 'failed',
            message,
            channel: options.offer.channel,
        })
    }
}
