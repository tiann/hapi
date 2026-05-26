import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
    PluginMarketplaceCatalogSchema,
    type PluginMarketplaceCatalog,
    type PluginMarketplaceEntry,
    type PluginMarketplaceInstallRequest,
    type PluginMarketplaceRelease
} from '@hapi/protocol/plugins/marketplace'
import type { PluginInstallPlanRequest } from '@hapi/protocol/plugins/admin'
import { HAPI_PLUGIN_MANIFEST_FILE } from '@hapi/protocol/plugins'
import { HAPI_PLUGIN_PACKAGE_MANIFEST_FILE, inspectPluginPackagePayload } from '@hapi/protocol/plugins/foundation'
import {
    EMBEDDED_PLUGIN_MARKETPLACE_URL,
    embeddedPluginMarketplaceCatalog,
    embeddedPluginMarketplaceSources
} from '@hapi/protocol/plugins/marketplaceSources.generated'
import {
    comparePluginVersions,
    latestCompatibleMarketplaceRelease,
    type PluginMarketplaceHostContext
} from '@hapi/protocol/plugins/runtime/versioning'
import { DEFAULT_MAX_PLUGIN_PACKAGE_BYTES } from './admin/packagePayloadLimits'

export const DEFAULT_PLUGIN_MARKETPLACE_URL = EMBEDDED_PLUGIN_MARKETPLACE_URL

export type MarketplaceFetch = (url: string) => Promise<{
    ok: boolean
    status: number
    statusText: string
    headers?: {
        get(name: string): string | null
    }
    body?: {
        getReader(): {
            read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
            releaseLock?(): void
        }
    } | null
    text(): Promise<string>
}>

export interface PluginMarketplaceServiceOptions {
    sourceUrl?: string
    sourceRoot?: string
    fetch?: MarketplaceFetch
    now?: () => number
    cacheTtlMs?: number
    allowLocalSources?: boolean
    allowInsecureHttp?: boolean
    maxPackageBytes?: number
}

export interface MarketplaceCatalogSnapshot {
    sourceUrl: string
    fetchedAt: number
    catalog: PluginMarketplaceCatalog
}

export interface MarketplacePackageRequestResult {
    marketplace: {
        sourceUrl: string
        pluginId: string
        repo: string
        version: string
        distribution: 'package' | 'hapi-source'
        assetUrl?: string
        sourcePath?: string
        checksum: string
    }
    request: PluginInstallPlanRequest
}

type SourceFile = { path: string; contentBase64: string }
const execFile = promisify(execFileCallback)

function normalizeChecksum(checksum: string): string {
    const trimmed = checksum.trim().toLowerCase()
    return trimmed.startsWith('sha256:') ? trimmed : `sha256:${trimmed}`
}

function sha256(buffer: Buffer): string {
    return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}

export const compareMarketplaceVersions = comparePluginVersions

function isFileUrl(url: string): boolean {
    return url.startsWith('file://')
}

function isHttpUrl(url: string): boolean {
    return url.startsWith('https://') || url.startsWith('http://')
}

function isHttpsUrl(url: string): boolean {
    return url.startsWith('https://')
}

function isEmbeddedUrl(url: string): boolean {
    return url.startsWith('embedded://')
}

function isEnoent(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function withCacheBust(url: string, now: number): string {
    if (!isHttpUrl(url)) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}_hapiCacheBust=${now}`
}

function assertRelativeSafePath(path: string): void {
    const normalized = path.replace(/\\/g, '/')
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
        throw new Error(`Unsafe marketplace source path: ${path}`)
    }
    if (normalized.split('/').some((part) => part === '..')) {
        throw new Error(`Marketplace source path must not contain traversal segments: ${path}`)
    }
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function marketplaceSourceTreeChecksum(files: SourceFile[]): string {
    const hash = createHash('sha256')
    for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
        assertRelativeSafePath(file.path)
        hash.update(file.path)
        hash.update('\0')
        hash.update(Buffer.from(file.contentBase64, 'base64'))
        hash.update('\0')
    }
    return `sha256:${hash.digest('hex')}`
}

async function readSourceDirectoryFiles(root: string): Promise<SourceFile[]> {
    const resolvedRoot = resolve(root)
    const files: SourceFile[] = []

    async function walk(current: string): Promise<void> {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const fullPath = join(current, entry.name)
            const stats = await lstat(fullPath)
            if (stats.isSymbolicLink()) {
                throw new Error(`Marketplace source must not contain symlinks: ${fullPath}`)
            }
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') {
                    throw new Error(`Marketplace source must not contain ${entry.name}: ${fullPath}`)
                }
                await walk(fullPath)
                continue
            }
            if (!entry.isFile()) {
                continue
            }
            const relativePath = relative(resolvedRoot, fullPath).split('\\').join('/')
            assertRelativeSafePath(relativePath)
            if (relativePath === HAPI_PLUGIN_PACKAGE_MANIFEST_FILE) {
                continue
            }
            files.push({
                path: relativePath,
                contentBase64: (await readFile(fullPath)).toString('base64')
            })
        }
    }

    await walk(resolvedRoot)
    return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function createSourcePackageBytes(files: SourceFile[], release: PluginMarketplaceRelease): Promise<Buffer> {
    const tempRoot = await mkdtemp(join(tmpdir(), 'hapi-marketplace-source-'))
    try {
        const pluginRoot = join(tempRoot, 'plugin')
        await mkdir(pluginRoot, { recursive: true, mode: 0o700 })
        for (const file of files) {
            assertRelativeSafePath(file.path)
            const targetPath = resolve(pluginRoot, file.path)
            if (!isPathInside(pluginRoot, targetPath)) {
                throw new Error(`Marketplace source file escapes plugin root: ${file.path}`)
            }
            await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
            await writeFile(targetPath, Buffer.from(file.contentBase64, 'base64'), { mode: 0o600 })
        }
        await writeFile(join(pluginRoot, HAPI_PLUGIN_PACKAGE_MANIFEST_FILE), JSON.stringify({
            formatVersion: 'hapi-plugin-package/v1',
            manifest: release.manifest,
            files: [],
            checksum: release.source?.treeChecksum ?? marketplaceSourceTreeChecksum(files)
        }, null, 2), { mode: 0o600 })

        const packagePath = join(tempRoot, 'plugin.tgz')
        await execFile('tar', ['-czf', packagePath, '-C', pluginRoot, '.'], { maxBuffer: 1024 * 1024 * 10 })
        return await readFile(packagePath)
    } finally {
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
}

function assertPackageBytesAllowed(size: number, maxBytes: number): void {
    if (size > maxBytes) {
        throw new Error('Plugin package is too large.')
    }
}

async function readLimitedPackage(response: Awaited<ReturnType<MarketplaceFetch>>, maxBytes: number): Promise<Buffer> {
    const rawContentLength = response.headers?.get('content-length')
    if (rawContentLength) {
        const contentLength = Number(rawContentLength)
        if (Number.isFinite(contentLength) && contentLength >= 0) {
            assertPackageBytesAllowed(contentLength, maxBytes)
        }
    }

    const reader = response.body?.getReader()
    if (!reader) {
        throw new Error('Marketplace package download did not provide a readable stream.')
    }

    const chunks: Uint8Array[] = []
    let total = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            assertPackageBytesAllowed(total, maxBytes)
            chunks.push(value)
        }
    } finally {
        reader.releaseLock?.()
    }
    return Buffer.concat(chunks, total)
}

export class PluginMarketplaceService {
    private snapshot: MarketplaceCatalogSnapshot | null = null
    private readonly sourceUrl: string
    private readonly sourceRoot?: string
    private readonly fetchImpl: MarketplaceFetch
    private readonly now: () => number
    private readonly cacheTtlMs: number
    private readonly allowLocalSources: boolean
    private readonly allowInsecureHttp: boolean
    private readonly maxPackageBytes: number

    constructor(options: PluginMarketplaceServiceOptions = {}) {
        this.sourceUrl = options.sourceUrl?.trim() || process.env.HAPI_PLUGIN_MARKETPLACE_URL?.trim() || DEFAULT_PLUGIN_MARKETPLACE_URL
        this.sourceRoot = options.sourceRoot?.trim() || process.env.HAPI_PLUGIN_MARKETPLACE_SOURCE_ROOT?.trim() || undefined
        this.fetchImpl = options.fetch ?? (async (url) => await fetch(url))
        this.now = options.now ?? (() => Date.now())
        this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000
        this.allowLocalSources = options.allowLocalSources ?? process.env.HAPI_PLUGIN_MARKETPLACE_ALLOW_LOCAL === '1'
        this.allowInsecureHttp = options.allowInsecureHttp ?? process.env.HAPI_PLUGIN_MARKETPLACE_ALLOW_HTTP === '1'
        this.maxPackageBytes = options.maxPackageBytes ?? DEFAULT_MAX_PLUGIN_PACKAGE_BYTES
    }

    async getCatalog(options: { force?: boolean } = {}): Promise<MarketplaceCatalogSnapshot> {
        const now = this.now()
        if (!options.force && this.snapshot && now - this.snapshot.fetchedAt < this.cacheTtlMs) {
            return this.snapshot
        }
        const parsed = isEmbeddedUrl(this.sourceUrl)
            ? PluginMarketplaceCatalogSchema.parse(embeddedPluginMarketplaceCatalog)
            : PluginMarketplaceCatalogSchema.parse(JSON.parse(await this.readText(options.force ? withCacheBust(this.sourceUrl, now) : this.sourceUrl)) as unknown)
        this.snapshot = {
            sourceUrl: this.sourceUrl,
            fetchedAt: now,
            catalog: parsed
        }
        return this.snapshot
    }

    async getEntry(pluginId: string, options: { force?: boolean } = {}): Promise<{ snapshot: MarketplaceCatalogSnapshot; entry: PluginMarketplaceEntry }> {
        const snapshot = await this.getCatalog(options)
        const entry = snapshot.catalog.plugins.find((plugin) => plugin.id === pluginId)
        if (!entry) {
            throw new Error(`Marketplace plugin ${pluginId} was not found.`)
        }
        return { snapshot, entry }
    }

    selectRelease(entry: PluginMarketplaceEntry, version?: string, hostContext?: PluginMarketplaceHostContext): PluginMarketplaceRelease {
        const candidates = entry.releases
            .filter((release) => !release.yanked)
            .sort((left, right) => compareMarketplaceVersions(right.version, left.version))
        if (version) {
            const exact = candidates.find((release) => release.version === version)
            if (!exact) {
                throw new Error(`Marketplace plugin ${entry.id} version ${version} was not found or has been yanked.`)
            }
            return exact
        }
        const latest = latestCompatibleMarketplaceRelease(entry, hostContext)
        if (!latest) {
            throw new Error(`Marketplace plugin ${entry.id} has no installable releases compatible with the current plugin hosts.`)
        }
        return latest
    }

    async buildInstallPlanRequest(pluginId: string, request: PluginMarketplaceInstallRequest = {}, hostContext?: PluginMarketplaceHostContext): Promise<MarketplacePackageRequestResult> {
        const { snapshot, entry } = await this.getEntry(pluginId)
        const release = this.selectRelease(entry, request.version, hostContext)
        const distribution = release.source ? 'hapi-source' : 'package'
        const bytes = distribution === 'hapi-source'
            ? await this.packageSourceRelease(snapshot, entry, release)
            : await this.downloadPackage(release)
        const checksum = sha256(bytes)
        if (release.package && normalizeChecksum(release.package.checksum) !== checksum) {
            throw new Error(`Marketplace package checksum mismatch for ${entry.id} ${release.version}: expected ${normalizeChecksum(release.package.checksum)}, got ${checksum}.`)
        }
        const packageRequest = {
            filename: release.package?.filename ?? `${entry.id}-${release.version}.hapi-source.tgz`,
            contentBase64: bytes.toString('base64'),
            checksum,
            format: release.package?.format ?? 'tgz',
            ...(request.enable !== undefined ? { enable: request.enable } : {}),
            ...(request.reload !== undefined ? { reload: request.reload } : {}),
            ...(request.overwrite !== undefined ? { overwrite: request.overwrite } : {}),
            ...(request.runnerSelection ? { runnerSelection: request.runnerSelection } : {}),
            installSource: {
                type: 'marketplace' as const,
                sourceUrl: snapshot.sourceUrl,
                pluginId: entry.id,
                repo: entry.repo,
                version: release.version,
                distribution,
                ...(release.package?.url ? { assetUrl: release.package.url } : {}),
                ...(release.source?.path ? { sourcePath: release.source.path } : {})
            }
        } satisfies PluginInstallPlanRequest

        const inspection = await inspectPluginPackagePayload(packageRequest)
        if (stableStringify(inspection.manifest) !== stableStringify(release.manifest)) {
            throw new Error(`Marketplace catalog manifest does not match package manifest for ${entry.id} ${release.version}.`)
        }

        return {
            marketplace: {
                sourceUrl: snapshot.sourceUrl,
                pluginId: entry.id,
                repo: entry.repo,
                version: release.version,
                distribution,
                ...(release.package?.url ? { assetUrl: release.package.url } : {}),
                ...(release.source?.path ? { sourcePath: release.source.path } : {}),
                checksum
            },
            request: packageRequest
        }
    }

    private async readText(sourceUrl: string): Promise<string> {
        if (isFileUrl(sourceUrl)) {
            this.assertLocalSourceAllowed('Marketplace file catalogs')
            return await readFile(fileURLToPath(sourceUrl), 'utf8')
        }
        if (!isHttpUrl(sourceUrl)) {
            this.assertLocalSourceAllowed('Marketplace local catalogs')
            return await readFile(sourceUrl, 'utf8')
        }
        this.assertRemoteUrlAllowed(sourceUrl, 'Marketplace catalog')
        const response = await this.fetchImpl(sourceUrl)
        if (!response.ok) {
            throw new Error(`Marketplace catalog fetch failed: HTTP ${response.status} ${response.statusText}`)
        }
        return await response.text()
    }

    private async downloadPackage(release: PluginMarketplaceRelease): Promise<Buffer> {
        if (!release.package) {
            throw new Error(`Marketplace release ${release.manifest.id} ${release.version} does not provide a package distribution.`)
        }
        if (release.package.size !== undefined) {
            assertPackageBytesAllowed(release.package.size, this.maxPackageBytes)
        }
        if (isFileUrl(release.package.url)) {
            this.assertLocalSourceAllowed('Marketplace file packages')
            return await readFile(fileURLToPath(release.package.url))
        }
        if (!isHttpUrl(release.package.url)) {
            this.assertLocalSourceAllowed('Marketplace local packages')
            return await readFile(release.package.url)
        }
        this.assertRemoteUrlAllowed(release.package.url, 'Marketplace package')
        const response = await this.fetchImpl(release.package.url)
        if (!response.ok) {
            throw new Error(`Marketplace package download failed: HTTP ${response.status} ${response.statusText}`)
        }
        return await readLimitedPackage(response, this.maxPackageBytes)
    }

    private async packageSourceRelease(
        snapshot: MarketplaceCatalogSnapshot,
        entry: PluginMarketplaceEntry,
        release: PluginMarketplaceRelease
    ): Promise<Buffer> {
        if (!release.source) {
            throw new Error(`Marketplace release ${entry.id} ${release.version} does not provide a source distribution.`)
        }
        const files = await this.loadSourceFiles(snapshot, entry, release)
        const manifestFile = files.find((file) => file.path === HAPI_PLUGIN_MANIFEST_FILE)
        if (!manifestFile) {
            throw new Error(`Marketplace source ${release.source.path} does not contain ${HAPI_PLUGIN_MANIFEST_FILE}.`)
        }
        const sourceManifest = JSON.parse(Buffer.from(manifestFile.contentBase64, 'base64').toString('utf8')) as unknown
        if (stableStringify(sourceManifest) !== stableStringify(release.manifest)) {
            throw new Error(`Marketplace catalog manifest does not match source manifest for ${entry.id} ${release.version}.`)
        }
        if (release.source.treeChecksum) {
            const actualTreeChecksum = marketplaceSourceTreeChecksum(files)
            if (normalizeChecksum(release.source.treeChecksum) !== actualTreeChecksum) {
                throw new Error(`Marketplace source checksum mismatch for ${entry.id} ${release.version}: expected ${normalizeChecksum(release.source.treeChecksum)}, got ${actualTreeChecksum}.`)
            }
        }
        return await createSourcePackageBytes(files, release)
    }

    private async loadSourceFiles(
        snapshot: MarketplaceCatalogSnapshot,
        entry: PluginMarketplaceEntry,
        release: PluginMarketplaceRelease
    ): Promise<SourceFile[]> {
        const source = release.source
        if (!source) {
            throw new Error(`Marketplace release ${entry.id} ${release.version} does not provide source metadata.`)
        }
        assertRelativeSafePath(source.path)
        if (!source.path.replace(/\\/g, '/').startsWith('plugins/')) {
            throw new Error(`Marketplace source path must stay under plugins/: ${source.path}`)
        }
        if (isEmbeddedUrl(snapshot.sourceUrl)) {
            return this.loadEmbeddedSourceFiles(entry, release)
        }

        const root = await this.resolveSourceRoot(snapshot)
        const sourcePath = resolve(root, source.path)
        if (!isPathInside(root, sourcePath)) {
            throw new Error(`Marketplace source path escapes source root: ${source.path}`)
        }
        try {
            return await readSourceDirectoryFiles(sourcePath)
        } catch (error) {
            if (source.embedded && isEnoent(error)) {
                return this.loadEmbeddedSourceFiles(entry, release)
            }
            throw error
        }
    }

    private loadEmbeddedSourceFiles(entry: PluginMarketplaceEntry, release: PluginMarketplaceRelease): SourceFile[] {
        const source = release.source
        if (!source) {
            throw new Error(`Marketplace release ${entry.id} ${release.version} does not provide source metadata.`)
        }
        const embedded = embeddedPluginMarketplaceSources[entry.id as keyof typeof embeddedPluginMarketplaceSources]
        if (!embedded) {
            throw new Error(`Embedded marketplace source for ${entry.id} was not found.`)
        }
        if (embedded.path !== source.path) {
            throw new Error(`Embedded marketplace source path mismatch for ${entry.id}: expected ${source.path}, got ${embedded.path}.`)
        }
        return [...embedded.files]
    }

    private async resolveSourceRoot(snapshot: MarketplaceCatalogSnapshot): Promise<string> {
        if (this.sourceRoot) {
            return resolve(this.sourceRoot)
        }
        if (isFileUrl(snapshot.sourceUrl)) {
            const catalogPath = fileURLToPath(snapshot.sourceUrl)
            return basename(dirname(catalogPath)) === 'marketplace'
                ? dirname(dirname(catalogPath))
                : dirname(catalogPath)
        }
        if (!isHttpUrl(snapshot.sourceUrl) && !isEmbeddedUrl(snapshot.sourceUrl)) {
            const catalogPath = resolve(snapshot.sourceUrl)
            return basename(dirname(catalogPath)) === 'marketplace'
                ? dirname(dirname(catalogPath))
                : dirname(catalogPath)
        }
        throw new Error('Marketplace source catalogs from remote URLs require HAPI_PLUGIN_MARKETPLACE_SOURCE_ROOT or embedded source metadata.')
    }

    private assertLocalSourceAllowed(label: string): void {
        if (!this.allowLocalSources) {
            throw new Error(`${label} are disabled by default. Set HAPI_PLUGIN_MARKETPLACE_ALLOW_LOCAL=1 for trusted local development catalogs.`)
        }
    }

    private assertRemoteUrlAllowed(url: string, label: string): void {
        if (!isHttpsUrl(url) && !this.allowInsecureHttp) {
            throw new Error(`${label} URL must use HTTPS. Set HAPI_PLUGIN_MARKETPLACE_ALLOW_HTTP=1 only for trusted local development.`)
        }
    }
}
