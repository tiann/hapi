import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findMonorepoRoot, defaultHubPackageRoot } from './resolveUpgradeOffer'

export type ArtifactMeta = {
    version: string
    platform: string
    arch: string
    path: string
    sha256: string
    sizeBytes: number
}

function artifactsRoot(dataDir?: string): string {
    return join(dataDir ?? join(homedir(), '.hapi'), 'upgrade-artifacts')
}

export function artifactFileName(version: string, platform: string, arch: string): string {
    return `hapi-${version}-${platform}-${arch}`
}

export function readArtifactMeta(
    version: string,
    platform: string,
    arch: string,
    dataDir?: string,
): ArtifactMeta | null {
    const dir = artifactsRoot(dataDir)
    const path = join(dir, artifactFileName(version, platform, arch))
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

function writeMeta(meta: ArtifactMeta): void {
    writeFileSync(`${meta.path}.json`, JSON.stringify(meta, null, 2))
}

/**
 * Ensure a compiled CLI artifact exists for platform/arch.
 * Builds with `bun build --compile` from the monorepo when missing.
 */
export async function ensureCliArtifact(options: {
    version: string
    platform: string
    arch: string
    dataDir?: string
    hubPackageRoot?: string
    bunCommand?: string
}): Promise<ArtifactMeta> {
    const existing = readArtifactMeta(options.version, options.platform, options.arch, options.dataDir)
    if (existing && existsSync(existing.path)) {
        return existing
    }

    if (options.platform !== process.platform || options.arch !== process.arch) {
        throw new Error(
            `Cross-compile not supported yet (hub is ${process.platform}/${process.arch}, requested ${options.platform}/${options.arch})`,
        )
    }

    const hubRoot = options.hubPackageRoot ?? defaultHubPackageRoot()
    const monorepo = findMonorepoRoot(hubRoot)
    if (!monorepo) {
        throw new Error('No monorepo root found; cannot build hub-artifact')
    }

    const dir = artifactsRoot(options.dataDir)
    mkdirSync(dir, { recursive: true })
    const outPath = join(dir, artifactFileName(options.version, options.platform, options.arch))
    const entry = join(monorepo, 'cli', 'src', 'index.ts')
    if (!existsSync(entry)) {
        throw new Error(`CLI entry missing: ${entry}`)
    }

    const bun = options.bunCommand ?? 'bun'
    const proc = Bun.spawn([
        bun,
        'build',
        entry,
        '--compile',
        '--outfile',
        outPath,
    ], {
        cwd: monorepo,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
    })
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    if (code !== 0 || !existsSync(outPath)) {
        throw new Error(`bun compile failed: ${stderr || stdout}`)
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
    }
    writeMeta(meta)
    return meta
}
