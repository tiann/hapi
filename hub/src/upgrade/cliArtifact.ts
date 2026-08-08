import { createHash } from 'node:crypto'
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { findMonorepoRoot, defaultHubPackageRoot } from './resolveUpgradeOffer'

/**
 * Mid-rebuild / half-soup compile miss. Auto fleet maps this to
 * `upgrade_deferred` and skips the failure toast; permanent prepare
 * failures stay `upgrade_failed` so operators still see them.
 */
export class TransientArtifactBuildError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'TransientArtifactBuildError'
    }
}

export function isTransientArtifactBuildFailure(error: unknown): boolean {
    return error instanceof TransientArtifactBuildError
}

export type ArtifactMeta = {
    version: string
    platform: string
    arch: string
    path: string
    sha256: string
    sizeBytes: number
    /** Hash of monorepo inputs that feed the compiled runner binary. */
    sourceFingerprint: string
}

function artifactsRoot(dataDir?: string): string {
    return join(dataDir ?? join(homedir(), '.hapi'), 'upgrade-artifacts')
}

/** Path-safe token: no `/`, `..`, whitespace, or other separators. */
const ARTIFACT_TOKEN_RE = /^[A-Za-z0-9._+-]+$/

/** Compile-time flag: skip embedded web assets in hub-artifact runner binaries. */
export const HAPI_RUNNER_ONLY_FEATURE = 'HAPI_RUNNER_ONLY'

export function artifactToken(name: string, value: string): string {
    if (!ARTIFACT_TOKEN_RE.test(value)) {
        throw new Error(`Invalid artifact ${name}`)
    }
    return value
}

export function artifactFileName(version: string, platform: string, arch: string): string {
    return `hapi-${artifactToken('version', version)}-${artifactToken('platform', platform)}-${artifactToken('arch', arch)}`
}

/** Content-addressed basename so generation A and B coexist on disk. */
export function contentAddressedArtifactFileName(
    version: string,
    platform: string,
    arch: string,
    sourceFingerprint: string,
): string {
    const prefix = artifactToken('fingerprint', sourceFingerprint.slice(0, 16).toLowerCase())
    return `${artifactFileName(version, platform, arch)}-${prefix}`
}

function readMetaAtPath(path: string): ArtifactMeta | null {
    const metaPath = `${path}.json`
    if (!existsSync(path) || !existsSync(metaPath)) {
        return null
    }
    try {
        return JSON.parse(readFileSync(metaPath, 'utf8')) as ArtifactMeta
    } catch {
        return null
    }
}

export function readArtifactMeta(
    version: string,
    platform: string,
    arch: string,
    dataDir?: string,
    sourceFingerprint?: string,
): ArtifactMeta | null {
    const dir = artifactsRoot(dataDir)
    if (sourceFingerprint) {
        const addressed = join(dir, contentAddressedArtifactFileName(version, platform, arch, sourceFingerprint))
        const meta = readMetaAtPath(addressed)
        if (meta) {
            return meta
        }
    }
    // Legacy mutable path (pre content-addressed builds).
    return readMetaAtPath(join(dir, artifactFileName(version, platform, arch)))
}

/** Look up a retained artifact by digest without rebuilding. */
export function findArtifactMetaBySha256(sha256: string, dataDir?: string): ArtifactMeta | null {
    const digest = sha256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(digest)) {
        return null
    }
    const dir = artifactsRoot(dataDir)
    if (!existsSync(dir)) {
        return null
    }
    let entries
    try {
        entries = readdirSync(dir)
    } catch {
        return null
    }
    for (const name of entries) {
        if (!name.endsWith('.json')) {
            continue
        }
        try {
            const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ArtifactMeta
            if (
                typeof meta.sha256 === 'string'
                && meta.sha256.toLowerCase() === digest
                && typeof meta.path === 'string'
                && existsSync(meta.path)
            ) {
                return meta
            }
        } catch {
            // skip corrupt sidecar
        }
    }
    return null
}

function writeMeta(meta: ArtifactMeta): void {
    writeFileSync(`${meta.path}.json`, JSON.stringify(meta, null, 2))
}

function listFilesRecursive(root: string): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
                continue
            }
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
                walk(full)
            } else if (entry.isFile()) {
                out.push(full)
            }
        }
    }
    if (existsSync(root)) {
        walk(root)
    }
    return out
}

/**
 * Fingerprint the sources that feed hub-artifact compiles.
 * Version alone is not enough: soup hubs often keep one package version across
 * many commits; a cache keyed only by version would keep serving a stale binary.
 *
 * Scope matches what `bun build --compile cli/src/bootstrap.ts` actually pulls:
 * CLI + shared + hub (command registry / startHub) + embedded tool assets.
 *
 * Content-addressed (not size+mtime): clean checkouts and pinned-tool re-downloads
 * change mtime with identical bytes and must not flap `targetGeneration`.
 * Skip `hub/src/web/embeddedAssets.generated.ts` — runner compiles pass
 * `--feature=HAPI_RUNNER_ONLY` so the generated web-asset import is DCE'd;
 * web-only regenerations must not force a fleet upgrade.
 * Skip downloaded `shared/tools/tunwg/tunwg-*` caches — pin changes live in
 * `hub/src/upgrade/tunwgPin.ts`; hashing platform caches flaps generation across
 * a mixed-platform fleet.
 */
export function fingerprintArtifactInputs(monorepoRoot: string): string {
    const hash = createHash('sha256')
    for (const file of listArtifactInputFiles(monorepoRoot)) {
        const rel = relative(monorepoRoot, file).split('\\').join('/')
        hash.update(rel)
        hash.update('\0')
        hash.update(readFileSync(file))
        hash.update('\0')
    }
    return hash.digest('hex')
}

/**
 * Cheap signature (path + size + mtime/ctime ns) for deciding whether the content
 * fingerprint needs recomputation. Used so the 30s offer/heartbeat path does
 * not re-read ~95MB of tool archives on every TTL miss when nothing changed.
 */
export function artifactInputStatKey(st: {
    size: bigint
    mtimeNs: bigint
    ctimeNs: bigint
}): string {
    // bigint + ns timestamps: ms-truncated mtime collapses distinct writes in
    // the same wall-clock millisecond and would leave the content cache stale.
    return `stat:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
}

export function fingerprintArtifactInputStats(monorepoRoot: string): string {
    const hash = createHash('sha256')
    for (const file of listArtifactInputFiles(monorepoRoot)) {
        const rel = relative(monorepoRoot, file).split('\\').join('/')
        const st = statSync(file, { bigint: true })
        hash.update(rel)
        hash.update('\0')
        hash.update(artifactInputStatKey(st))
        hash.update('\0')
    }
    return hash.digest('hex')
}

let cachedContentFingerprint: { signature: string; value: string } | null = null
let fingerprintAttemptHookForTests: (() => void) | null = null

/** Test helper — mutate sources between stats/content passes. */
export function __setFingerprintAttemptHookForTests(hook: (() => void) | null): void {
    fingerprintAttemptHookForTests = hook
}

/** Content fingerprint with a stats-signature gate for hot offer resolution. */
export function resolveArtifactSourceFingerprint(monorepoRoot: string): string {
    // Soup rematerialize can delete/replace inputs between enumerate and read.
    // Retry a consistent before/after stats snapshot; fail as deferred, not crash.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const before = fingerprintArtifactInputStats(monorepoRoot)
            if (cachedContentFingerprint && cachedContentFingerprint.signature === before) {
                return cachedContentFingerprint.value
            }
            fingerprintAttemptHookForTests?.()
            const value = fingerprintArtifactInputs(monorepoRoot)
            const after = fingerprintArtifactInputStats(monorepoRoot)
            if (before !== after) {
                continue
            }
            cachedContentFingerprint = { signature: after, value }
            return value
        } catch {
            // Source tree mid-replace (ENOENT etc.) — retry.
        }
    }
    throw new TransientArtifactBuildError('Artifact source changed during fingerprinting')
}

/** Test helper — drop the in-process content-fingerprint cache. */
export function __resetArtifactFingerprintCacheForTests(): void {
    cachedContentFingerprint = null
}

function listArtifactInputFiles(monorepoRoot: string): string[] {
    const treeRoots = [
        join(monorepoRoot, 'cli', 'src'),
        join(monorepoRoot, 'hub', 'src'),
        join(monorepoRoot, 'shared', 'src'),
        join(monorepoRoot, 'cli', 'tools'),
        join(monorepoRoot, 'shared', 'tools'),
    ]
    const singles = [
        join(monorepoRoot, 'cli', 'package.json'),
        join(monorepoRoot, 'hub', 'package.json'),
        join(monorepoRoot, 'shared', 'package.json'),
        join(monorepoRoot, 'package.json'),
        join(monorepoRoot, 'bun.lock'),
        // Compile resolution (`@/*`) depends on these; config-only changes must
        // invalidate the hub-artifact generation fingerprint.
        join(monorepoRoot, 'cli', 'bunfig.toml'),
        join(monorepoRoot, 'cli', 'tsconfig.json'),
        join(monorepoRoot, 'tsconfig.base.json'),
    ]
    const files = [
        ...treeRoots.flatMap(listFilesRecursive),
        ...singles.filter((path) => existsSync(path)),
    ]
    return [...new Set(files)].sort().filter((file) => {
        const rel = relative(monorepoRoot, file).split('\\').join('/')
        if (
            rel === 'hub/src/web/embeddedAssets.generated.ts'
            || /^hub\/src\/web\/embeddedAssets\.generated\.ts\.fleet-upgrade\..+\.bak$/.test(rel)
        ) {
            return false
        }
        // Colocated tests are not reachable from bootstrap compile inputs.
        if (/(?:^|\/)(?:__tests__\/|.*\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(rel)) {
            return false
        }
        // Platform-specific downloaded tunwg binaries — pin is in hub source.
        if (rel.startsWith('shared/tools/tunwg/tunwg-')) {
            return false
        }
        return true
    })
}

export function isArtifactCacheFresh(
    meta: ArtifactMeta | null,
    sourceFingerprint: string,
): boolean {
    if (!meta || !existsSync(meta.path)) {
        return false
    }
    // Pre-fingerprint metas (and empty fingerprints) are never reusable —
    // same package version can hide newer source.
    if (
        typeof meta.sourceFingerprint !== 'string'
        || meta.sourceFingerprint.length === 0
        || meta.sourceFingerprint !== sourceFingerprint
    ) {
        return false
    }
    // Sidecar alone is not enough: a truncated/corrupted binary with an intact
    // .json would otherwise be re-served forever while runners reject the SHA.
    try {
        const bytes = readFileSync(meta.path)
        if (bytes.byteLength !== meta.sizeBytes) {
            return false
        }
        if (typeof meta.sha256 !== 'string' || meta.sha256.length === 0) {
            return false
        }
        const digest = createHash('sha256').update(bytes).digest('hex')
        return digest.toLowerCase() === meta.sha256.toLowerCase()
    } catch {
        return false
    }
}

function featureFlagFor(platform: string, arch: string): string {
    const platformToken = platform === 'win32' ? 'WIN32' : platform.toUpperCase()
    return `HAPI_TARGET_${platformToken}_${arch.toUpperCase()}`
}

/** Feature flags passed to `bun build --compile` for fleet runner artifacts. */
export function runnerArtifactCompileFeatures(platform: string, arch: string): string[] {
    return [featureFlagFor(platform, arch), HAPI_RUNNER_ONLY_FEATURE]
}

/**
 * Map Node's process.platform/arch to a Bun `--compile --target=` string.
 * Bun cross-compiles these from any host (Linux→Windows is the common
 * fleet-upgrade case: hub on oos-linux, runners on Teemo/OOS-VR2).
 */
export function bunCompileTarget(platform: string, arch: string): string {
    if (platform === 'linux' && arch === 'x64') {
        return 'bun-linux-x64-baseline'
    }
    if (platform === 'linux' && arch === 'arm64') {
        return 'bun-linux-arm64'
    }
    if (platform === 'win32' && arch === 'x64') {
        // HAPI only publishes/ships @twsxtd/hapi-win32-x64. Bun can compile
        // bun-windows-arm64, but fleet-upgrade must match the supported binary matrix.
        return 'bun-windows-x64'
    }
    if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
        return `bun-darwin-${arch}`
    }
    throw new Error(`Unsupported compile target: ${platform}/${arch}`)
}

/**
 * Bun auto-appends `.exe` for Windows targets when the outfile has no
 * extension. Prefer an explicit `.exe` outfile, then normalize back to the
 * extensionless artifact path we serve (download bytes don't care about
 * the hub-side filename; Windows runners rename on install).
 *
 * Same-version rebuilds: always prefer a freshly compiled `.exe` over a
 * stale extensionless `outPath` left from a previous build — otherwise the
 * hub hashes OLD bytes under the NEW sourceFingerprint and silently ships
 * the previous generation to Windows runners.
 */
export function normalizeCompiledArtifactPath(outPath: string, platform: string): string {
    if (platform !== 'win32') {
        return outPath
    }
    const withExe = `${outPath}.exe`
    if (existsSync(withExe)) {
        try {
            if (existsSync(outPath)) {
                unlinkSync(outPath)
            }
        } catch {
            // best-effort; rename may still replace on Unix-like FS layers
        }
        renameSync(withExe, outPath)
        return outPath
    }
    return outPath
}

function tunwgBinaryPath(monorepoRoot: string, platform: string, arch: string): string {
    const name = platform === 'win32'
        ? `tunwg-${arch}-win32.exe`
        : `tunwg-${arch}-${platform === 'darwin' ? 'darwin' : 'linux'}`
    // win32 uses x64 only in practice
    const file = platform === 'win32' ? 'tunwg-x64-win32.exe' : name
    return join(monorepoRoot, 'shared', 'tools', 'tunwg', file)
}

async function ensureTunwgBinary(
    monorepoRoot: string,
    platform: string,
    arch: string,
    timeoutMs?: number,
): Promise<void> {
    const { ensurePinnedTunwgForCompile } = await import('./tunwgPin')
    await ensurePinnedTunwgForCompile(monorepoRoot, platform, arch, timeoutMs)
    const path = tunwgBinaryPath(monorepoRoot, platform, arch)
    if (!existsSync(path)) {
        throw new Error(`Pinned tunwg binary missing after download: ${path}`)
    }
}

function requiredToolArchives(cliRoot: string, platform: string, arch: string): string[] {
    let platformDir: string
    if (platform === 'darwin') {
        platformDir = arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin'
    } else if (platform === 'linux') {
        platformDir = arch === 'arm64' ? 'arm64-linux' : 'x64-linux'
    } else if (platform === 'win32') {
        platformDir = 'x64-win32'
    } else {
        throw new Error(`Unsupported platform: ${platform}`)
    }
    return [
        join(cliRoot, 'tools', 'archives', `difftastic-${platformDir}.tar.gz`),
        join(cliRoot, 'tools', 'archives', `ripgrep-${platformDir}.tar.gz`),
    ]
}

/**
 * Serialize artifact compiles — concurrent heartbeats must not race bun
 * compile outputs for the same platform/arch outfile.
 */
let artifactBuildLock: Promise<void> = Promise.resolve()

/**
 * End-to-end wall-clock budget while holding `artifactBuildLock` (tunwg download
 * + bun compile). Must release the lock before later Upgrade RPCs queue forever.
 */
export const ARTIFACT_BUILD_BUDGET_MS = 9 * 60_000

function remainingArtifactBudgetMs(deadlineMs: number, nowMs = Date.now()): number {
    return Math.max(1, deadlineMs - nowMs)
}

async function withArtifactBuildLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = artifactBuildLock
    let release!: () => void
    artifactBuildLock = new Promise<void>((resolve) => {
        release = resolve
    })
    await previous
    try {
        return await run()
    } finally {
        release()
    }
}

/**
 * Ensure a compiled CLI artifact exists for platform/arch.
 * Uses the same bootstrap entry as `cli/scripts/build-executable.ts` (without
 * embedded web assets) so remotes get a runnable runner binary.
 */
export async function ensureCliArtifact(options: {
    version: string
    platform: string
    arch: string
    dataDir?: string
    hubPackageRoot?: string
    bunCommand?: string
}): Promise<ArtifactMeta> {
    const hubRoot = options.hubPackageRoot ?? defaultHubPackageRoot()
    const monorepo = findMonorepoRoot(hubRoot)
    if (!monorepo) {
        throw new Error('No monorepo root found; cannot build hub-artifact')
    }

    return await withArtifactBuildLock(async () => {
        const deadlineMs = Date.now() + ARTIFACT_BUILD_BUDGET_MS
        // Resolve (and validate) the Bun target up front — throws for
        // unsupported platform/arch. Same-host used to be required; Bun now
        // cross-compiles win32/darwin/linux from any host.
        const target = bunCompileTarget(options.platform, options.arch)

        const bun = options.bunCommand
            ?? (process.execPath.includes('bun') ? process.execPath : 'bun')
        // Download/verify pinned tunwg BEFORE fingerprinting so a clean tree
        // does not cache a pre-download fingerprint and force a second compile.
        await ensureTunwgBinary(
            monorepo,
            options.platform,
            options.arch,
            remainingArtifactBudgetMs(deadlineMs),
        )

        const sourceFingerprint = resolveArtifactSourceFingerprint(monorepo)
        const cached = readArtifactMeta(
            options.version,
            options.platform,
            options.arch,
            options.dataDir,
            sourceFingerprint,
        )
        if (isArtifactCacheFresh(cached, sourceFingerprint)) {
            return cached!
        }

        const cliRoot = join(monorepo, 'cli')
        const entry = join(cliRoot, 'src', 'bootstrap.ts')
        if (!existsSync(entry)) {
            throw new Error(`CLI bootstrap missing: ${entry}`)
        }

        for (const archive of requiredToolArchives(cliRoot, options.platform, options.arch)) {
            if (!existsSync(archive)) {
                throw new Error(`Missing tool archive for compile: ${archive}`)
            }
        }

        const dir = artifactsRoot(options.dataDir)
        mkdirSync(dir, { recursive: true })
        // Fingerprint-suffixed path: keep prior generations so digest-pinned
        // offer URLs remain downloadable after a soup remat rebuilds "current".
        const outPath = join(
            dir,
            contentAddressedArtifactFileName(
                options.version,
                options.platform,
                options.arch,
                sourceFingerprint,
            ),
        )        // Explicit .exe so Bun doesn't surprise us with an auto-suffix we then miss.
        const compileOut = options.platform === 'win32' ? `${outPath}.exe` : outPath
        // Drop stale win32 outputs before compile so a same-version rebuild cannot
        // leave normalize choosing yesterday's extensionless bytes over a fresh .exe.
        if (options.platform === 'win32') {
            for (const stale of [outPath, compileOut]) {
                try {
                    if (existsSync(stale)) {
                        unlinkSync(stale)
                    }
                } catch {
                    // best-effort; normalize still prefers .exe when both exist
                }
            }
        }
        const features = runnerArtifactCompileFeatures(options.platform, options.arch)
        const featureArgs = features.flatMap((flag) => [`--feature=${flag}`])

        // Do not rewrite hub/src/web/embeddedAssets.generated.ts — that races
        // bun --watch hubs and concurrent single-exe builds. HAPI_RUNNER_ONLY
        // dead-code-eliminates the web-asset import instead.
        const proc = Bun.spawn([
            bun,
            'build',
            '--compile',
            '--no-compile-autoload-dotenv',
            ...featureArgs,
            `--target=${target}`,
            `--outfile=${compileOut}`,
            entry,
        ], {
            cwd: cliRoot,
            stdout: 'pipe',
            stderr: 'pipe',
            env: process.env,
            timeout: remainingArtifactBudgetMs(deadlineMs),
        })
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        const produced = normalizeCompiledArtifactPath(outPath, options.platform)
        if (code !== 0 || !existsSync(produced)) {
            const detail = stderr || stdout
            if (proc.signalCode) {
                throw new Error(
                    `bun compile timed out or killed (${proc.signalCode}) after artifact budget: ${detail}`,
                )
            }
            // Only treat unresolved imports as transient when the source tree
            // changed during compile (active remat). Stable missing modules
            // must stay upgrade_failed so auto fleet still toasts.
            if (/Could not resolve:/i.test(detail)) {
                const fingerprintAfter = resolveArtifactSourceFingerprint(monorepo)
                if (fingerprintAfter !== sourceFingerprint) {
                    throw new TransientArtifactBuildError(
                        `bun compile failed (source changed during build): ${detail}`,
                    )
                }
            }
            throw new Error(`bun compile failed: ${detail}`)
        }

        // Successful exit can still be a mixed build if soup rematerialized mid-compile.
        const fingerprintAfterSuccess = resolveArtifactSourceFingerprint(monorepo)
        if (fingerprintAfterSuccess !== sourceFingerprint) {
            try {
                unlinkSync(produced)
            } catch {
                // best-effort cleanup of mixed/stale bytes
            }
            throw new TransientArtifactBuildError('Artifact source changed during compile')
        }

        const buf = readFileSync(outPath)
        const sha256 = createHash('sha256').update(buf).digest('hex')
        const meta: ArtifactMeta = {
            version: options.version,
            platform: options.platform,
            arch: options.arch,
            path: outPath,
            sha256,
            sizeBytes: statSync(outPath).size,
            sourceFingerprint,
        }
        writeMeta(meta)
        retainArtifactOffer(meta.sha256)
        pruneRetainedArtifacts({
            dataDir: options.dataDir,
            version: options.version,
            platform: options.platform,
            arch: options.arch,
            preserveSha256: meta.sha256,
        })
        return meta
    })
}

/** How many prior generations to keep per version/platform/arch (plus preserveSha256). */
export const RETAINED_ARTIFACT_GENERATIONS = 3

/** Keep digests downloadable for the fleet upgrade cooldown / download budget window. */
export const ARTIFACT_OFFER_RETENTION_MS = 15 * 60_000

const offeredUntilBySha = new Map<string, number>()

/** Mark a digest as recently offered so prune will not delete it mid-download. */
export function retainArtifactOffer(sha256: string, now: number = Date.now()): void {
    const digest = sha256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(digest)) {
        return
    }
    offeredUntilBySha.set(digest, now + ARTIFACT_OFFER_RETENTION_MS)
}

/** Test helper: clear in-memory offer retention. */
export function resetArtifactOfferRetentionForTests(): void {
    offeredUntilBySha.clear()
}

function isArtifactOfferRetained(sha256: string, now: number = Date.now()): boolean {
    const until = offeredUntilBySha.get(sha256.trim().toLowerCase())
    return typeof until === 'number' && until > now
}

/**
 * Drop older content-addressed builds for the same version/platform/arch so
 * soup hubs do not accumulate unbounded Bun binaries. Always keeps
 * `preserveSha256` (the just-built digest) and any digests still inside the
 * recent-offer retention window.
 */
export function pruneRetainedArtifacts(options: {
    dataDir?: string
    version: string
    platform: string
    arch: string
    preserveSha256: string
    keepGenerations?: number
    now?: number
}): string[] {
    const keep = options.keepGenerations ?? RETAINED_ARTIFACT_GENERATIONS
    const now = options.now ?? Date.now()
    const dir = artifactsRoot(options.dataDir)
    if (!existsSync(dir)) {
        return []
    }
    const preserve = options.preserveSha256.trim().toLowerCase()
    const prefix = `${artifactFileName(options.version, options.platform, options.arch)}-`
    const legacyName = artifactFileName(options.version, options.platform, options.arch)
    let entries: string[]
    try {
        entries = readdirSync(dir)
    } catch {
        return []
    }

    type Candidate = { metaPath: string; meta: ArtifactMeta; mtimeMs: number }
    const candidates: Candidate[] = []
    for (const name of entries) {
        if (!name.endsWith('.json')) {
            continue
        }
        const base = name.slice(0, -'.json'.length)
        if (base !== legacyName && !base.startsWith(prefix)) {
            continue
        }
        const metaPath = join(dir, name)
        try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ArtifactMeta
            if (meta.version !== options.version || meta.platform !== options.platform || meta.arch !== options.arch) {
                continue
            }
            const mtimeMs = statSync(metaPath).mtimeMs
            candidates.push({ metaPath, meta, mtimeMs })
        } catch {
            // skip corrupt
        }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const removed: string[] = []
    let keptForWindow = 0
    for (const candidate of candidates) {
        const sha = typeof candidate.meta.sha256 === 'string'
            ? candidate.meta.sha256.toLowerCase()
            : ''
        const offered = isArtifactOfferRetained(sha, now)
        if (sha === preserve || offered) {
            // Always keep just-built + recently offered digests; they do not
            // consume the generation budget so in-flight downloads stay valid.
            continue
        }
        if (keptForWindow < keep) {
            keptForWindow += 1
            continue
        }
        try {
            if (typeof candidate.meta.path === 'string' && existsSync(candidate.meta.path)) {
                unlinkSync(candidate.meta.path)
            }
            const exeSibling = `${candidate.meta.path}.exe`
            if (typeof candidate.meta.path === 'string' && existsSync(exeSibling)) {
                unlinkSync(exeSibling)
            }
            unlinkSync(candidate.metaPath)
            removed.push(candidate.meta.path)
        } catch {
            // best-effort GC
        }
    }
    return removed
}
