import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, delimiter as platformDelimiter } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
    HAPI_PLUGIN_API_VERSION,
    HAPI_PLUGIN_MANIFEST_FILE,
    HAPI_SUPPORTED_PLUGIN_API_VERSIONS,
    PluginManifestLiteSchema,
    RawPluginManifestLiteSchema,
    type PluginManifestLite,
    type PluginRuntimeName
} from './manifest'
import { PluginStateFileSchema, type PluginInstallMetadata, type PluginStateEntry, type PluginStateFile } from './state'
import type { PluginDiagnostic, PluginDiagnosticSeverity, PluginStatus } from './types'

export type PluginSource = 'env' | 'user-home' | 'bundled'

export interface PluginSearchRoot {
    path: string
    source: PluginSource
    priority: number
    includeRootManifest: boolean
}

export interface PluginRuntimeEntryPath {
    runtime: PluginRuntimeName
    entry: string
    resolvedPath: string
    realPath: string
}

export interface DiscoveredPluginRecord {
    rootPath: string
    manifestPath: string
    source: PluginSource
    status: PluginStatus
    manifest?: PluginManifestLite
    diagnostics: PluginDiagnostic[]
    runtimeEntryPaths: PluginRuntimeEntryPath[]
    enabled?: boolean
    config?: Record<string, unknown>
    configUpdatedAt?: number
    configSource?: PluginResolvedConfig['source']
    install?: PluginInstallMetadata
}

export interface DiscoverPluginsOptions {
    hapiHome: string
    envPluginDirs?: string
    bundledPluginDirs?: string[]
    delimiter?: string
}

export interface PluginStateReadResult {
    state: PluginStateFile
    parseError?: string
    failClosed: boolean
}

export interface PluginResolvedConfig {
    config?: Record<string, unknown>
    updatedAt?: number
    source: 'scoped' | 'legacy-default' | 'empty'
}

export interface ApplyPluginStateOptions {
    failClosed?: boolean
    defaultEnabledPluginIds?: Iterable<string>
}

export type PluginDirectoryInstallAction = 'installed' | 'overwritten'
export type PluginPackageFormat = 'tgz' | 'zip'

export interface PluginDirectoryInstallResult {
    action: PluginDirectoryInstallAction
    sourcePath: string
    targetPath: string
    record: DiscoveredPluginRecord
}

export interface PluginPackageInstallResult extends PluginDirectoryInstallResult {
    checksum: string
    packageFormat: PluginPackageFormat
}

export interface PluginPackageManifestMetadata {
    formatVersion: 'hapi-plugin-package/v1'
    manifest: PluginManifestLite
    checksum: string
    files?: Array<{
        path: string
        sha256?: string
    }>
    signature?: {
        algorithm: string
        value: string
    }
}

export interface PluginPackageValidationResult {
    bytes: Buffer
    checksum: string
    packageFormat: PluginPackageFormat
}

export interface PluginPackageInspectionResult extends PluginPackageValidationResult {
    manifest: PluginManifestLite
    packageManifest: PluginPackageManifestMetadata
}

export const HAPI_PLUGIN_PACKAGE_MANIFEST_FILE = 'hapi.plugin.package.json'

const PluginPackageManifestMetadataSchema = z.object({
    formatVersion: z.literal('hapi-plugin-package/v1'),
    manifest: PluginManifestLiteSchema,
    files: z.array(z.object({
        path: z.string().min(1),
        size: z.number().int().nonnegative().optional(),
        sha256: z.string().min(1).optional()
    }).strict()).default([]),
    checksum: z.string().min(1),
    signature: z.object({
        algorithm: z.string().min(1),
        value: z.string().min(1)
    }).strict().optional()
}).strict()

export class PluginInstallError extends Error {
    constructor(
        readonly code: 'plugin-install-invalid-source' | 'plugin-install-target-exists' | 'plugin-install-unsafe-path' | 'plugin-install-invalid-target',
        message: string
    ) {
        super(message)
        this.name = 'PluginInstallError'
    }
}

export class PluginStateLockError extends Error {
    constructor(lockFile: string) {
        super(`Plugin state is locked by ${lockFile}`)
        this.name = 'PluginStateLockError'
    }
}

const execFile = promisify(execFileCallback)

function diagnostic(
    code: string,
    message: string,
    severity: PluginDiagnosticSeverity = 'error',
    path?: string
): PluginDiagnostic {
    return { code, message, severity, ...(path ? { path } : {}) }
}

function describeZodError(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
            return `${path}${issue.message}`
        })
        .join('; ')
}

export function expandHomePath(path: string): string {
    return path.replace(/^~(?=$|[/\\])/, homedir())
}

export function splitPluginDirs(raw: string | undefined, delimiter: string = platformDelimiter): string[] {
    if (!raw) {
        return []
    }
    return raw
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
}

export function getPluginSearchRoots(options: DiscoverPluginsOptions): PluginSearchRoot[] {
    const roots: PluginSearchRoot[] = []
    let priority = 0

    for (const rawPath of splitPluginDirs(options.envPluginDirs, options.delimiter)) {
        roots.push({
            path: resolve(expandHomePath(rawPath)),
            source: 'env',
            priority,
            includeRootManifest: true
        })
        priority += 1
    }

    roots.push({
        path: resolve(expandHomePath(join(options.hapiHome, 'plugins'))),
        source: 'user-home',
        priority,
        includeRootManifest: false
    })
    priority += 1

    for (const bundledPath of options.bundledPluginDirs ?? []) {
        roots.push({
            path: resolve(expandHomePath(bundledPath)),
            source: 'bundled',
            priority,
            includeRootManifest: false
        })
        priority += 1
    }

    return roots
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await realpath(path)
        return true
    } catch {
        return false
    }
}

async function rejectSymlinks(path: string): Promise<void> {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin directory contains a symbolic link: ${path}`)
    }
    if (!stats.isDirectory()) {
        return
    }
    const entries = await readdir(path)
    for (const entry of entries) {
        await rejectSymlinks(join(path, entry))
    }
}

async function candidatePluginRoots(searchRoot: PluginSearchRoot): Promise<string[]> {
    if (!existsSync(searchRoot.path)) {
        return []
    }

    const manifestAtRoot = join(searchRoot.path, HAPI_PLUGIN_MANIFEST_FILE)
    if (searchRoot.includeRootManifest && existsSync(manifestAtRoot)) {
        return [searchRoot.path]
    }

    try {
        const entries = await readdir(searchRoot.path, { withFileTypes: true })
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(searchRoot.path, entry.name))
            .filter((entryPath) => existsSync(join(entryPath, HAPI_PLUGIN_MANIFEST_FILE)))
            .sort((left, right) => left.localeCompare(right))
    } catch {
        return []
    }
}

async function validateRuntimeEntryPath(runtime: PluginRuntimeName, pluginRoot: string, entry: string, manifestPath: string): Promise<{
    entryPath?: PluginRuntimeEntryPath
    diagnostics: PluginDiagnostic[]
}> {
    const runtimeLabel = runtime === 'hub' ? 'Hub' : 'Runner'
    if (isAbsolute(entry)) {
        return { diagnostics: [diagnostic('entry-path-absolute', `${runtimeLabel} runtime entry must be a relative path.`, 'error', manifestPath)] }
    }

    const rootResolved = resolve(pluginRoot)
    const entryResolved = resolve(rootResolved, entry)
    if (!isPathInside(rootResolved, entryResolved)) {
        return { diagnostics: [diagnostic('entry-path-escape', `${runtimeLabel} runtime entry must stay under the plugin root.`, 'error', manifestPath)] }
    }

    try {
        const [rootRealPath, entryRealPath] = await Promise.all([
            realpath(rootResolved),
            realpath(entryResolved)
        ])

        if (!isPathInside(rootRealPath, entryRealPath)) {
            return { diagnostics: [diagnostic('entry-symlink-escape', `${runtimeLabel} runtime entry realpath must stay under the plugin root.`, 'error', manifestPath)] }
        }

        return {
            entryPath: {
                runtime,
                entry,
                resolvedPath: entryResolved,
                realPath: entryRealPath
            },
            diagnostics: []
        }
    } catch (error) {
        return {
            diagnostics: [diagnostic(
                'entry-path-missing',
                `${runtimeLabel} runtime entry could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
                'error',
                manifestPath
            )]
        }
    }
}


export async function validatePluginRoot(pluginRoot: string, source: PluginSource = 'user-home'): Promise<DiscoveredPluginRecord> {
    const rootPath = resolve(expandHomePath(pluginRoot))
    const manifestPath = join(rootPath, HAPI_PLUGIN_MANIFEST_FILE)
    const baseRecord = {
        rootPath,
        manifestPath,
        source,
        runtimeEntryPaths: []
    }

    let rawManifest: unknown
    try {
        rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
        const exists = await pathExists(manifestPath)
        return {
            ...baseRecord,
            status: 'invalid',
            diagnostics: [diagnostic(
                exists ? 'invalid-json' : 'missing-manifest',
                exists
                    ? `Manifest JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
                    : `Missing ${HAPI_PLUGIN_MANIFEST_FILE}.`,
                'error',
                manifestPath
            )]
        }
    }

    const rawParsed = RawPluginManifestLiteSchema.safeParse(rawManifest)
    if (!rawParsed.success) {
        return {
            ...baseRecord,
            status: 'invalid',
            diagnostics: [diagnostic('invalid-manifest', describeZodError(rawParsed.error), 'error', manifestPath)]
        }
    }

    if (!HAPI_SUPPORTED_PLUGIN_API_VERSIONS.includes(rawParsed.data.pluginApiVersion as typeof HAPI_SUPPORTED_PLUGIN_API_VERSIONS[number])) {
        return {
            ...baseRecord,
            status: 'incompatible',
            diagnostics: [diagnostic(
                'plugin-api-version-mismatch',
                `Unsupported pluginApiVersion ${rawParsed.data.pluginApiVersion}; supported versions: ${HAPI_SUPPORTED_PLUGIN_API_VERSIONS.join(', ')}. Current default: ${HAPI_PLUGIN_API_VERSION}.`,
                'error',
                manifestPath
            )]
        }
    }

    const parsed = PluginManifestLiteSchema.safeParse(rawManifest)
    if (!parsed.success) {
        return {
            ...baseRecord,
            status: 'invalid',
            diagnostics: [diagnostic('invalid-manifest', describeZodError(parsed.error), 'error', manifestPath)]
        }
    }

    const supportedOs = parsed.data.compatibility?.os
    if (supportedOs && !supportedOs.includes(process.platform as 'darwin' | 'linux' | 'win32')) {
        return {
            ...baseRecord,
            status: 'incompatible',
            manifest: parsed.data,
            diagnostics: [diagnostic(
                'os-incompatible',
                `Plugin supports ${supportedOs.join(', ')} but this platform is ${process.platform}.`,
                'error',
                manifestPath
            )]
        }
    }

    const runtimeEntryPaths: PluginRuntimeEntryPath[] = []
    const diagnostics: PluginDiagnostic[] = []
    const runtimeEntries: Array<{ runtime: PluginRuntimeName; entry?: string }> = [
        { runtime: 'hub', entry: parsed.data.runtimes?.hub?.entry },
        { runtime: 'runner', entry: parsed.data.runtimes?.runner?.entry }
    ]
    for (const runtimeEntry of runtimeEntries) {
        if (!runtimeEntry.entry) continue
        const entryResult = await validateRuntimeEntryPath(runtimeEntry.runtime, rootPath, runtimeEntry.entry, manifestPath)
        diagnostics.push(...entryResult.diagnostics)
        if (entryResult.entryPath) {
            runtimeEntryPaths.push(entryResult.entryPath)
        }
    }

    if (diagnostics.some((entry) => entry.severity === 'error')) {
        return {
            ...baseRecord,
            status: 'invalid',
            manifest: parsed.data,
            diagnostics,
            runtimeEntryPaths
        }
    }

    return {
        ...baseRecord,
        status: 'validated',
        manifest: parsed.data,
        diagnostics,
        runtimeEntryPaths
    }
}

export async function discoverPlugins(options: DiscoverPluginsOptions): Promise<DiscoveredPluginRecord[]> {
    const records: DiscoveredPluginRecord[] = []
    const searchRoots = getPluginSearchRoots(options)

    for (const searchRoot of searchRoots) {
        const roots = await candidatePluginRoots(searchRoot)
        for (const root of roots) {
            records.push(await validatePluginRoot(root, searchRoot.source))
        }
    }

    const firstById = new Map<string, DiscoveredPluginRecord>()
    for (const record of records) {
        if (!record.manifest) {
            continue
        }
        const first = firstById.get(record.manifest.id)
        if (!first) {
            firstById.set(record.manifest.id, record)
            continue
        }

        record.status = 'blocked'
        record.diagnostics.push(diagnostic(
            'duplicate-plugin-id',
            `Duplicate plugin id ${record.manifest.id}; first manifest at ${first.manifestPath} wins.`,
            'error',
            record.manifestPath
        ))
        first.diagnostics.push(diagnostic(
            'duplicate-plugin-id',
            `Duplicate plugin id ${record.manifest.id} also found at ${record.manifestPath}.`,
            'warning',
            first.manifestPath
        ))
    }

    return records
}


export function applyPluginState(
    records: DiscoveredPluginRecord[],
    state: PluginStateFile,
    optionsOrFailClosed: boolean | ApplyPluginStateOptions = false
): DiscoveredPluginRecord[] {
    const options = typeof optionsOrFailClosed === 'boolean'
        ? { failClosed: optionsOrFailClosed }
        : optionsOrFailClosed
    const failClosed = options.failClosed === true
    const defaultEnabledPluginIds = new Set(options.defaultEnabledPluginIds ?? [])

    return records.map((record) => {
        if (!record.manifest || record.status !== 'validated') {
            return { ...record, enabled: false }
        }

        if (failClosed) {
            return { ...record, status: 'disabled', enabled: false }
        }

        const stateEntry = state.enabled[record.manifest.id]
        const enabled = stateEntry?.enabled ?? defaultEnabledPluginIds.has(record.manifest.id)
        return {
            ...record,
            status: enabled ? 'enabled' : 'disabled',
            enabled,
            ...(stateEntry?.config ? { config: stateEntry.config } : {}),
            ...(stateEntry?.configUpdatedAt ? { configUpdatedAt: stateEntry.configUpdatedAt } : {}),
            ...(stateEntry?.install ? { install: stateEntry.install } : {})
        }
    })
}

export function resolvePluginScopedConfig(entry: PluginStateEntry | undefined, scope: string): PluginResolvedConfig {
    const scoped = entry?.scopedConfig?.[scope]
    if (scoped) {
        return {
            config: scoped.config,
            ...(scoped.updatedAt ? { updatedAt: scoped.updatedAt } : {}),
            source: 'scoped'
        }
    }
    if (entry?.config) {
        return {
            config: entry.config,
            ...(entry.configUpdatedAt ? { updatedAt: entry.configUpdatedAt } : {}),
            source: 'legacy-default'
        }
    }
    return { source: 'empty' }
}

export function setPluginScopedConfig(
    entry: PluginStateEntry | undefined,
    scope: string,
    config: Record<string, unknown>,
    updatedAt = Date.now()
): PluginStateEntry {
    return {
        enabled: entry?.enabled === true,
        ...(entry?.config ? { config: entry.config } : {}),
        ...(entry?.configUpdatedAt ? { configUpdatedAt: entry.configUpdatedAt } : {}),
        scopedConfig: {
            ...(entry?.scopedConfig ?? {}),
            [scope]: {
                config,
                updatedAt
            }
        },
        ...(entry?.install ? { install: entry.install } : {})
    }
}

export function getPluginStateFile(hapiHome: string): string {
    return join(expandHomePath(hapiHome), 'plugins.json')
}

export function getUserPluginsDir(hapiHome: string): string {
    return resolve(expandHomePath(join(hapiHome, 'plugins')))
}

export function getUserPluginInstallDir(hapiHome: string, pluginId: string): string {
    return join(getUserPluginsDir(hapiHome), pluginId)
}

export async function installPluginFromDirectory(options: {
    hapiHome: string
    sourcePath: string
    overwrite?: boolean
}): Promise<PluginDirectoryInstallResult> {
    const sourceResolved = resolve(expandHomePath(options.sourcePath))
    let sourceStats
    try {
        sourceStats = await lstat(sourceResolved)
    } catch (error) {
        throw new PluginInstallError(
            'plugin-install-invalid-source',
            `Plugin source path could not be resolved: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    if (sourceStats.isSymbolicLink()) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin source path must not be a symbolic link: ${sourceResolved}`)
    }
    if (!sourceStats.isDirectory()) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin source path is not a directory: ${sourceResolved}`)
    }

    let sourceRealPath: string
    try {
        sourceRealPath = await realpath(sourceResolved)
    } catch (error) {
        throw new PluginInstallError(
            'plugin-install-invalid-source',
            `Plugin source path could not be resolved: ${error instanceof Error ? error.message : String(error)}`
        )
    }

    await rejectSymlinks(sourceRealPath)
    const sourceRecord = await validatePluginRoot(sourceRealPath, 'user-home')
    if (!sourceRecord.manifest || sourceRecord.status !== 'validated') {
        const details = sourceRecord.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin source is not valid: ${details || sourceResolved}`)
    }

    const targetPath = getUserPluginInstallDir(options.hapiHome, sourceRecord.manifest.id)
    const targetParent = getUserPluginsDir(options.hapiHome)
    if (!isPathInside(targetParent, targetPath)) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin target path escapes the user plugin directory: ${targetPath}`)
    }

    if (isPathInside(sourceRealPath, targetPath) || isPathInside(targetPath, sourceRealPath)) {
        throw new PluginInstallError('plugin-install-unsafe-path', 'Plugin source and target paths must not contain each other.')
    }

    const targetExists = await pathExists(targetPath)
    if (targetExists) {
        const targetRealPath = await realpath(targetPath)
        if (isPathInside(sourceRealPath, targetRealPath) || isPathInside(targetRealPath, sourceRealPath)) {
            throw new PluginInstallError('plugin-install-unsafe-path', 'Plugin source and existing target paths must not contain each other.')
        }
        if (!options.overwrite) {
            throw new PluginInstallError('plugin-install-target-exists', `Plugin ${sourceRecord.manifest.id} is already installed at ${targetPath}.`)
        }
    }

    await mkdir(targetParent, { recursive: true, mode: 0o700 })
    if (targetExists) {
        await rm(targetPath, { recursive: true, force: true })
    }
    await cp(sourceRealPath, targetPath, { recursive: true, errorOnExist: true, force: false, dereference: false })

    const copiedRecord = await validatePluginRoot(targetPath, 'user-home')
    if (!copiedRecord.manifest || copiedRecord.status !== 'validated') {
        await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
        const details = copiedRecord.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')
        throw new PluginInstallError('plugin-install-invalid-target', `Copied plugin failed validation: ${details || targetPath}`)
    }

    return {
        action: targetExists ? 'overwritten' : 'installed',
        sourcePath: sourceRealPath,
        targetPath,
        record: copiedRecord
    }
}

function normalizePackageChecksum(checksum: string): string {
    const trimmed = checksum.trim().toLowerCase()
    return trimmed.startsWith('sha256:') ? trimmed : `sha256:${trimmed}`
}

function sha256Hex(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex')
}

function detectPackageFormat(filename: string, format?: PluginPackageFormat): PluginPackageFormat {
    if (format) return format
    const lowered = filename.toLowerCase()
    if (lowered.endsWith('.zip')) return 'zip'
    if (lowered.endsWith('.tgz') || lowered.endsWith('.tar.gz')) return 'tgz'
    throw new PluginInstallError('plugin-install-invalid-source', 'Plugin package filename must end with .tgz, .tar.gz, or .zip.')
}

function assertArchiveEntrySafe(entry: string): void {
    const normalized = entry.replace(/\\/g, '/')
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin package contains an unsafe path: ${entry}`)
    }
    if (normalized.split('/').some((part) => part === '..')) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin package contains a path traversal entry: ${entry}`)
    }
}

async function listArchiveEntries(packagePath: string, format: PluginPackageFormat): Promise<string[]> {
    const command = format === 'tgz' ? 'tar' : 'unzip'
    const args = format === 'tgz' ? ['-tzf', packagePath] : ['-Z1', packagePath]
    try {
        const { stdout } = await execFile(command, args, { maxBuffer: 1024 * 1024 * 10 })
        return stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)
    } catch (error) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin package could not be listed: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function normalizeArchiveEntry(entry: string): string {
    return entry.replace(/\\/g, '/').replace(/\/+$/, '')
}

function normalizePackageManifestFilePath(path: string): string {
    let normalized = normalizeArchiveEntry(path)
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2)
    }
    return normalized
}

function packageStableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => packageStableStringify(entry)).join(',')}]`
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${packageStableStringify(entry)}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}

async function readJsonFile(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function readInternalPackageManifest(pluginRoot: string): Promise<PluginPackageManifestMetadata | null> {
    const packageManifestPath = join(pluginRoot, HAPI_PLUGIN_PACKAGE_MANIFEST_FILE)
    if (!existsSync(packageManifestPath)) {
        return null
    }
    let raw: unknown
    try {
        raw = await readJsonFile(packageManifestPath)
    } catch (error) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin package manifest JSON is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = PluginPackageManifestMetadataSchema.safeParse(raw)
    if (!parsed.success) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin package manifest is invalid: ${describeZodError(parsed.error)}`)
    }
    return parsed.data
}

async function validatePackageManifestMetadata(options: {
    metadata: PluginPackageManifestMetadata
    pluginRoot: string
    extractDir: string
    archiveEntries: string[]
    packageChecksum: string
    strictPackageChecksum: boolean
}): Promise<void> {
    const rawPluginManifest = await readJsonFile(join(options.pluginRoot, HAPI_PLUGIN_MANIFEST_FILE))
    const pluginManifest = PluginManifestLiteSchema.parse(rawPluginManifest)
    if (packageStableStringify(options.metadata.manifest) !== packageStableStringify(pluginManifest)) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin package manifest metadata does not match ${HAPI_PLUGIN_MANIFEST_FILE}.`)
    }

    if (options.strictPackageChecksum) {
        const manifestChecksum = normalizePackageChecksum(options.metadata.checksum)
        if (manifestChecksum !== options.packageChecksum) {
            throw new PluginInstallError('plugin-install-invalid-source', `Plugin package manifest checksum mismatch: expected ${manifestChecksum}, got ${options.packageChecksum}.`)
        }
    }

    const archiveEntrySet = new Set(options.archiveEntries.map((entry) => normalizePackageManifestFilePath(entry)).filter(Boolean))
    const pluginPrefix = normalizePackageManifestFilePath(relative(options.extractDir, options.pluginRoot))
    for (const file of options.metadata.files ?? []) {
        assertArchiveEntrySafe(file.path)
        const normalized = normalizePackageManifestFilePath(file.path)
        const archivePath = pluginPrefix ? `${pluginPrefix}/${normalized}` : normalized
        if (!archiveEntrySet.has(archivePath)) {
            throw new PluginInstallError('plugin-install-invalid-source', `Plugin package manifest lists missing file: ${file.path}`)
        }
        if (file.sha256) {
            const actualFileChecksum = `sha256:${sha256Hex(await readFile(join(options.pluginRoot, normalized)))}`
            const expectedFileChecksum = normalizePackageChecksum(file.sha256)
            if (actualFileChecksum !== expectedFileChecksum) {
                throw new PluginInstallError('plugin-install-invalid-source', `Plugin package file checksum mismatch for ${file.path}: expected ${expectedFileChecksum}, got ${actualFileChecksum}.`)
            }
        }
    }
}

export async function validatePluginPackagePayload(options: {
    filename: string
    contentBase64: string
    checksum: string
    format?: PluginPackageFormat
    manifest?: PluginPackageManifestMetadata
    inspectArchive?: boolean
}): Promise<PluginPackageValidationResult> {
    const format = detectPackageFormat(options.filename, options.format)
    const bytes = Buffer.from(options.contentBase64, 'base64')
    if (bytes.length === 0) {
        throw new PluginInstallError('plugin-install-invalid-source', 'Plugin package content is empty.')
    }

    const actualChecksum = `sha256:${sha256Hex(bytes)}`
    if (normalizePackageChecksum(options.checksum) !== actualChecksum) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin package checksum mismatch: expected ${normalizePackageChecksum(options.checksum)}, got ${actualChecksum}.`)
    }

    if (options.inspectArchive === true) {
        const tempRoot = await mkdtemp(join(tmpdir(), 'hapi-plugin-package-validate-'))
        try {
            const packagePath = join(tempRoot, format === 'zip' ? 'plugin.zip' : 'plugin.tgz')
            const extractDir = join(tempRoot, 'extract')
            await writeFile(packagePath, bytes, { mode: 0o600 })
            await mkdir(extractDir, { recursive: true, mode: 0o700 })
            const entries = await listArchiveEntries(packagePath, format)
            if (entries.length === 0) {
                throw new PluginInstallError('plugin-install-invalid-source', 'Plugin package is empty.')
            }
            for (const entry of entries) {
                assertArchiveEntrySafe(entry)
            }
            await extractArchive(packagePath, format, extractDir)
            await rejectSymlinks(extractDir)
            const pluginRoot = await findExtractedPluginRoot(extractDir)
            const packageManifest = options.manifest
                ? PluginPackageManifestMetadataSchema.parse(options.manifest)
                : await readInternalPackageManifest(pluginRoot)
            if (!packageManifest) {
                throw new PluginInstallError('plugin-install-invalid-source', `Plugin package must include ${HAPI_PLUGIN_PACKAGE_MANIFEST_FILE} or provide package manifest metadata.`)
            }
            await validatePackageManifestMetadata({
                metadata: packageManifest,
                pluginRoot,
                extractDir,
                archiveEntries: entries,
                packageChecksum: actualChecksum,
                strictPackageChecksum: Boolean(options.manifest)
            })
        } finally {
            await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
        }
    }

    return {
        bytes,
        checksum: actualChecksum,
        packageFormat: format
    }
}

export async function inspectPluginPackagePayload(options: {
    filename: string
    contentBase64: string
    checksum: string
    format?: PluginPackageFormat
    manifest?: PluginPackageManifestMetadata
}): Promise<PluginPackageInspectionResult> {
    const validation = await validatePluginPackagePayload({ ...options, inspectArchive: false })

    const tempRoot = await mkdtemp(join(tmpdir(), 'hapi-plugin-package-inspect-'))
    try {
        const packagePath = join(tempRoot, validation.packageFormat === 'zip' ? 'plugin.zip' : 'plugin.tgz')
        const extractDir = join(tempRoot, 'extract')
        await writeFile(packagePath, validation.bytes, { mode: 0o600 })
        await mkdir(extractDir, { recursive: true, mode: 0o700 })
        const entries = await listArchiveEntries(packagePath, validation.packageFormat)
        if (entries.length === 0) {
            throw new PluginInstallError('plugin-install-invalid-source', 'Plugin package is empty.')
        }
        for (const entry of entries) {
            assertArchiveEntrySafe(entry)
        }
        await extractArchive(packagePath, validation.packageFormat, extractDir)
        await rejectSymlinks(extractDir)
        const pluginRoot = await findExtractedPluginRoot(extractDir)
        const packageManifest = options.manifest
            ? PluginPackageManifestMetadataSchema.parse(options.manifest)
            : await readInternalPackageManifest(pluginRoot)
        if (!packageManifest) {
            throw new PluginInstallError('plugin-install-invalid-source', `Plugin package must include ${HAPI_PLUGIN_PACKAGE_MANIFEST_FILE} or provide package manifest metadata.`)
        }
        await validatePackageManifestMetadata({
            metadata: packageManifest,
            pluginRoot,
            extractDir,
            archiveEntries: entries,
            packageChecksum: validation.checksum,
            strictPackageChecksum: Boolean(options.manifest)
        })
        return {
            ...validation,
            manifest: packageManifest.manifest,
            packageManifest
        }
    } finally {
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
}

async function extractArchive(packagePath: string, format: PluginPackageFormat, targetDir: string): Promise<void> {
    const entries = await listArchiveEntries(packagePath, format)
    if (entries.length === 0) {
        throw new PluginInstallError('plugin-install-invalid-source', 'Plugin package is empty.')
    }
    for (const entry of entries) {
        assertArchiveEntrySafe(entry)
    }

    const command = format === 'tgz' ? 'tar' : 'unzip'
    const args = format === 'tgz'
        ? ['-xzf', packagePath, '-C', targetDir]
        : ['-q', packagePath, '-d', targetDir]
    try {
        await execFile(command, args, { maxBuffer: 1024 * 1024 * 10 })
    } catch (error) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin package could not be extracted: ${error instanceof Error ? error.message : String(error)}`)
    }
}

async function findExtractedPluginRoot(extractDir: string): Promise<string> {
    if (existsSync(join(extractDir, HAPI_PLUGIN_MANIFEST_FILE))) {
        return extractDir
    }
    const entries = await readdir(extractDir, { withFileTypes: true })
    const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(extractDir, entry.name))
        .filter((entryPath) => existsSync(join(entryPath, HAPI_PLUGIN_MANIFEST_FILE)))
    if (candidates.length === 1) {
        return candidates[0]
    }
    if (candidates.length > 1) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin package contains multiple plugin roots: ${candidates.map((entry) => basename(entry)).join(', ')}`)
    }
    throw new PluginInstallError('plugin-install-invalid-source', `Plugin package does not contain ${HAPI_PLUGIN_MANIFEST_FILE} at its root or first child directory.`)
}

export async function installPluginFromPackage(options: {
    hapiHome: string
    filename: string
    contentBase64: string
    checksum: string
    format?: PluginPackageFormat
    manifest?: PluginPackageManifestMetadata
    overwrite?: boolean
}): Promise<PluginPackageInstallResult> {
    const validation = await validatePluginPackagePayload({ ...options, inspectArchive: true })

    const tempRoot = await mkdtemp(join(tmpdir(), 'hapi-plugin-package-'))
    try {
        const packagePath = join(tempRoot, validation.packageFormat === 'zip' ? 'plugin.zip' : 'plugin.tgz')
        const extractDir = join(tempRoot, 'extract')
        await mkdir(extractDir, { recursive: true, mode: 0o700 })
        await writeFile(packagePath, validation.bytes, { mode: 0o600 })
        await extractArchive(packagePath, validation.packageFormat, extractDir)
        await rejectSymlinks(extractDir)
        const pluginRoot = await findExtractedPluginRoot(extractDir)
        const install = await installPluginFromDirectory({
            hapiHome: options.hapiHome,
            sourcePath: pluginRoot,
            overwrite: options.overwrite
        })
        return {
            ...install,
            checksum: validation.checksum,
            packageFormat: validation.packageFormat
        }
    } finally {
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
}

export async function readPluginState(stateFile: string): Promise<PluginStateReadResult> {
    if (!existsSync(stateFile)) {
        return { state: { enabled: {} }, failClosed: false }
    }

    try {
        const rawState = normalizePluginStateInput(JSON.parse(await readFile(stateFile, 'utf8')))
        const parsed = PluginStateFileSchema.safeParse(rawState)
        if (!parsed.success) {
            return {
                state: { enabled: {} },
                parseError: describeZodError(parsed.error),
                failClosed: true
            }
        }
        return { state: parsed.data, failClosed: false }
    } catch (error) {
        return {
            state: { enabled: {} },
            parseError: error instanceof Error ? error.message : String(error),
            failClosed: true
        }
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function booleanRecord(value: unknown): Record<string, boolean> {
    if (!isPlainRecord(value)) {
        return {}
    }
    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    )
}

function normalizePluginStateInput(rawState: unknown): unknown {
    if (!isPlainRecord(rawState) || !('seededCorePluginIds' in rawState)) {
        return rawState
    }
    const { seededCorePluginIds, seededDefaultPluginIds, ...rest } = rawState
    const normalizedSeeded = {
        ...booleanRecord(seededCorePluginIds),
        ...booleanRecord(seededDefaultPluginIds)
    }
    return {
        ...rest,
        ...(Object.keys(normalizedSeeded).length > 0 ? { seededDefaultPluginIds: normalizedSeeded } : {})
    }
}

export async function writePluginState(stateFile: string, state: PluginStateFile): Promise<void> {
    const parsed = PluginStateFileSchema.parse(state)
    const dir = dirname(stateFile)
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const lockFile = `${stateFile}.lock`
    const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`
    let locked = false

    try {
        await writeFile(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 })
        locked = true
        await writeFile(tmpFile, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
        await rename(tmpFile, stateFile)
    } catch (error) {
        await rm(tmpFile, { force: true })
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new PluginStateLockError(lockFile)
        }
        throw error
    } finally {
        if (locked) {
            await unlink(lockFile).catch(() => undefined)
        }
    }
}
