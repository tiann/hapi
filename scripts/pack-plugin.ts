#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { HAPI_PLUGIN_PACKAGE_MANIFEST_FILE, inspectPluginPackagePayload, validatePluginRoot, type PluginPackageManifestMetadata } from '@hapi/protocol/plugins/foundation'

const execFile = promisify(execFileCallback)
const repoRoot = join(import.meta.dir, '..')

type SourceFile = { path: string; size: number; sha256: string; bytes: Buffer }

function usage(): never {
    console.error('Usage: bun scripts/pack-plugin.ts <plugin-dir> --out <file.tgz> [--json]')
    process.exit(2)
}

function toPosix(path: string): string {
    return path.split(sep).join('/')
}

function assertSafeRelativePath(path: string): void {
    const normalized = toPosix(path)
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
        throw new Error(`Unsafe package path: ${path}`)
    }
    if (normalized.split('/').some((part) => part === '..')) {
        throw new Error(`Package path must not contain traversal segments: ${path}`)
    }
}

function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function sha256(buffer: Buffer): string {
    return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function sourceTreeChecksum(files: SourceFile[]): string {
    const hash = createHash('sha256')
    for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
        assertSafeRelativePath(file.path)
        hash.update(file.path)
        hash.update('\0')
        hash.update(file.bytes)
        hash.update('\0')
    }
    return `sha256:${hash.digest('hex')}`
}

async function walkSourceFiles(root: string, outputPath: string): Promise<SourceFile[]> {
    const resolvedRoot = resolve(root)
    const resolvedOutput = resolve(outputPath)
    const files: SourceFile[] = []

    async function walk(current: string): Promise<void> {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const fullPath = join(current, entry.name)
            const stats = await lstat(fullPath)
            if (stats.isSymbolicLink()) {
                throw new Error(`Plugin package must not contain symlinks: ${fullPath}`)
            }
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules') {
                    throw new Error(`Plugin package must not contain ${entry.name}: ${fullPath}`)
                }
                await walk(fullPath)
                continue
            }
            if (!entry.isFile()) continue
            if (resolve(fullPath) === resolvedOutput) continue
            const rel = toPosix(relative(resolvedRoot, fullPath))
            assertSafeRelativePath(rel)
            if (rel === HAPI_PLUGIN_PACKAGE_MANIFEST_FILE) continue
            const bytes = await readFile(fullPath)
            files.push({ path: rel, size: bytes.length, sha256: sha256(bytes), bytes })
        }
    }

    await walk(resolvedRoot)
    return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function main(): Promise<void> {
    const args = process.argv.slice(2)
    const pluginDir = args.find((arg) => !arg.startsWith('-'))
    const outIndex = args.indexOf('--out')
    const outputPath = outIndex >= 0 ? args[outIndex + 1] : undefined
    const json = args.includes('--json')
    if (!pluginDir || !outputPath) usage()

    const pluginRoot = resolve(pluginDir)
    const output = resolve(outputPath)
    if (existsSync(output)) {
        await rm(output, { force: true })
    }
    await mkdir(dirname(output), { recursive: true })

    const record = await validatePluginRoot(pluginRoot)
    const errors = record.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (!record.manifest || errors.length > 0) {
        for (const diagnostic of record.diagnostics) {
            console.error(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`)
        }
        throw new Error('Plugin validation failed; refusing to pack.')
    }

    const files = await walkSourceFiles(pluginRoot, output)
    const checksum = sourceTreeChecksum(files)
    const packageManifest: PluginPackageManifestMetadata = {
        formatVersion: 'hapi-plugin-package/v1',
        manifest: record.manifest,
        files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
        checksum
    }

    const tempRoot = await mkdtemp(join(tmpdir(), 'hapi-plugin-pack-'))
    try {
        const stagedRoot = join(tempRoot, 'plugin')
        await mkdir(stagedRoot, { recursive: true, mode: 0o700 })
        for (const file of files) {
            const targetPath = resolve(stagedRoot, file.path)
            if (!isInside(stagedRoot, targetPath)) {
                throw new Error(`Package file escapes staged root: ${file.path}`)
            }
            await mkdir(dirname(targetPath), { recursive: true })
            await writeFile(targetPath, file.bytes)
        }
        await writeFile(join(stagedRoot, HAPI_PLUGIN_PACKAGE_MANIFEST_FILE), `${JSON.stringify(packageManifest, null, 4)}\n`)
        await execFile('tar', ['-czf', output, '-C', stagedRoot, '.'], { maxBuffer: 1024 * 1024 * 10 })
    } finally {
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }

    const packageBytes = await readFile(output)
    const packageChecksum = sha256(packageBytes)
    await inspectPluginPackagePayload({
        filename: basename(output),
        contentBase64: packageBytes.toString('base64'),
        checksum: packageChecksum,
        format: 'tgz'
    })

    const result = {
        pluginId: record.manifest.id,
        version: record.manifest.version,
        output,
        checksum: packageChecksum,
        sourceTreeChecksum: checksum,
        files: files.length
    }
    if (json) {
        console.log(JSON.stringify(result, null, 2))
        return
    }
    console.log(`[pack-plugin] wrote ${toPosix(relative(repoRoot, output))}`)
    console.log(`[pack-plugin] package checksum: ${packageChecksum}`)
    console.log(`[pack-plugin] source tree checksum: ${checksum}`)
    console.log(`[pack-plugin] files: ${files.length}`)
}

await main().catch((error) => {
    console.error(`[pack-plugin] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
