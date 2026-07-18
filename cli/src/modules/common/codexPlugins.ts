import { readdir, readFile, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'

export interface CodexPluginInstallation {
    pluginName: string
    marketplace: string
    installPath: string
}

function getHomeDirectory(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir()
}

export function getCodexHomeDirectory(): string {
    return process.env.CODEX_HOME ?? join(getHomeDirectory(), '.codex')
}

function parseEnabledCodexPluginKeys(configToml: string): string[] {
    const enabled = new Set<string>()
    let currentPluginKey: string | null = null

    for (const rawLine of configToml.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) {
            continue
        }

        const sectionMatch = /^\[plugins\."(.+)"\]$/.exec(line) ?? /^\[plugins\.'(.+)'\]$/.exec(line)
        if (sectionMatch) {
            currentPluginKey = sectionMatch[1] ?? null
            continue
        }

        if (line.startsWith('[')) {
            currentPluginKey = null
            continue
        }

        if (currentPluginKey && /^enabled\s*=\s*true(?:\s*(?:#.*)?)?$/.test(line)) {
            enabled.add(currentPluginKey)
        }
    }

    return [...enabled]
}

function parsePluginKey(pluginKey: string): { pluginName: string; marketplace: string } | null {
    const lastAtIndex = pluginKey.lastIndexOf('@')
    if (lastAtIndex <= 0 || lastAtIndex >= pluginKey.length - 1) {
        return null
    }

    return {
        pluginName: pluginKey.slice(0, lastAtIndex),
        marketplace: pluginKey.slice(lastAtIndex + 1),
    }
}

function isPathInside(basePath: string, targetPath: string): boolean {
    const base = resolve(basePath)
    const target = resolve(targetPath)
    const rel = relative(base, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function resolvePathInside(basePath: string, ...pathParts: string[]): string | null {
    const resolved = resolve(basePath, ...pathParts)
    return isPathInside(basePath, resolved) ? resolved : null
}

async function resolveRealPathInside(basePath: string, targetPath: string): Promise<string | null> {
    if (!isPathInside(basePath, targetPath)) {
        return null
    }

    const [baseRealPath, targetRealPath] = await Promise.all([
        realpath(basePath).catch(() => null),
        realpath(targetPath).catch(() => null),
    ])
    if (!baseRealPath || !targetRealPath || !isPathInside(baseRealPath, targetRealPath)) {
        return null
    }
    return targetRealPath
}

export async function resolveRealDirectoryInside(basePath: string, targetPath: string): Promise<string | null> {
    const realPath = await resolveRealPathInside(basePath, targetPath)
    if (!realPath) {
        return null
    }
    const stats = await stat(realPath).catch(() => null)
    return stats?.isDirectory() ? realPath : null
}

export async function resolveRealFileInside(basePath: string, ...pathParts: string[]): Promise<string | null> {
    const targetPath = resolvePathInside(basePath, ...pathParts)
    if (!targetPath) {
        return null
    }
    const realPath = await resolveRealPathInside(basePath, targetPath)
    if (!realPath) {
        return null
    }
    const stats = await stat(realPath).catch(() => null)
    return stats?.isFile() ? realPath : null
}

function compareInstallVersionNamesDesc(a: string, b: string): number {
    return b.localeCompare(a, 'en', { numeric: true, sensitivity: 'base' })
}

async function resolveLatestPluginInstallPath(pluginRoot: string): Promise<string | null> {
    const root = resolve(pluginRoot)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const latestEntry = entries.find((entry) => entry.name === 'latest' && (entry.isDirectory() || entry.isSymbolicLink()))
    if (latestEntry) {
        const latestPath = resolvePathInside(root, latestEntry.name)
        const latestDirectory = latestPath ? await resolveRealDirectoryInside(root, latestPath) : null
        if (latestDirectory) {
            return latestDirectory
        }
    }

    const candidates = (await Promise.all(
        entries
            .filter((entry) => entry.name !== 'latest' && !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
            .map(async (entry) => {
                const installPath = resolvePathInside(root, entry.name)
                const directory = installPath ? await resolveRealDirectoryInside(root, installPath) : null
                if (!directory) {
                    return null
                }
                return { name: entry.name, installPath: directory }
            })
    )).filter((candidate): candidate is { name: string; installPath: string } => candidate !== null)

    return candidates.sort((a, b) => compareInstallVersionNamesDesc(a.name, b.name))[0]?.installPath ?? null
}

export async function listEnabledCodexPluginInstallations(codexHomeDir: string = getCodexHomeDirectory()): Promise<CodexPluginInstallation[]> {
    const configToml = await readFile(join(codexHomeDir, 'config.toml'), 'utf-8').catch(() => null)
    if (!configToml) {
        return []
    }

    const cacheRoot = resolve(codexHomeDir, 'plugins', 'cache')
    const pluginKeys = parseEnabledCodexPluginKeys(configToml)
    const installations = await Promise.all(pluginKeys.map(async (pluginKey) => {
        const parsed = parsePluginKey(pluginKey)
        if (!parsed) {
            return null
        }

        const pluginRoot = resolvePathInside(cacheRoot, parsed.marketplace, parsed.pluginName)
        const realPluginRoot = pluginRoot ? await resolveRealDirectoryInside(cacheRoot, pluginRoot) : null
        if (!realPluginRoot) {
            return null
        }

        const installPath = await resolveLatestPluginInstallPath(realPluginRoot)
        if (!installPath) {
            return null
        }

        return {
            pluginName: parsed.pluginName,
            marketplace: parsed.marketplace,
            installPath,
        } satisfies CodexPluginInstallation
    }))

    return installations.filter((installation): installation is CodexPluginInstallation => installation !== null)
}
