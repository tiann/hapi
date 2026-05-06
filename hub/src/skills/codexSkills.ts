import { access, open, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Dirent } from 'node:fs'

export type CodexSkillScope = 'repo' | 'user' | 'plugin' | 'admin'

export interface CodexSkillSummary {
    name: string
    description: string
    path: string
    scope: CodexSkillScope
    pluginName?: string
    pluginPath?: string
}

export interface CodexSkillScanOptions {
    homeDir?: string
    codexHome?: string
    adminSkillsRoot?: string
}

const SKILL_HEADER_BYTES = 16 * 1024
const PLUGIN_MANIFEST_RELATIVE_PATH = join('.codex-plugin', 'plugin.json')

function getHomeDirectory(options: CodexSkillScanOptions): string {
    return options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir()
}

function getCodexHome(options: CodexSkillScanOptions): string {
    return options.codexHome ?? process.env.CODEX_HOME ?? join(getHomeDirectory(options), '.codex')
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function findGitRoot(workingDirectory: string): Promise<string | null> {
    let current = resolve(workingDirectory)

    while (true) {
        if (await pathExists(join(current, '.git'))) {
            return current
        }

        const parent = dirname(current)
        if (parent === current) {
            return null
        }
        current = parent
    }
}

async function getRepoSkillsRoots(workingDirectory?: string): Promise<string[]> {
    if (!workingDirectory) {
        return []
    }

    const cwd = resolve(workingDirectory)
    const gitRoot = await findGitRoot(cwd)
    const directories: string[] = []
    let current = cwd

    while (true) {
        directories.push(current)
        if (!gitRoot || current === gitRoot) {
            break
        }

        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }

    return directories.flatMap((directory) => [
        join(directory, '.agents', 'skills'),
        join(directory, '.codex', 'skills'),
    ])
}

function getUserSkillsRoots(options: CodexSkillScanOptions): string[] {
    const roots = [join(getHomeDirectory(options), '.agents', 'skills')]
    const codexHome = options.codexHome ?? process.env.CODEX_HOME
    if (codexHome) {
        roots.push(join(codexHome, 'skills'))
    }
    return roots
}

function getPluginCacheRoot(options: CodexSkillScanOptions): string {
    return join(getCodexHome(options), 'plugins', 'cache')
}

function getAdminSkillsRoot(options: CodexSkillScanOptions): string {
    return options.adminSkillsRoot ?? join('/etc', 'codex', 'skills')
}

async function listSkillDirectories(skillsRoot: string): Promise<string[]> {
    try {
        const entries = await readdir(skillsRoot, { withFileTypes: true })
        const directories = await Promise.all(entries.map(async (entry) => {
            if (entry.name.startsWith('.')) {
                return null
            }

            const fullPath = join(skillsRoot, entry.name)
            try {
                const entryStat = entry.isDirectory()
                    ? null
                    : await stat(fullPath)
                if (entry.isDirectory() || entryStat?.isDirectory()) {
                    return fullPath
                }
            } catch {
                return null
            }

            return null
        }))
        return directories.filter((directory): directory is string => directory !== null)
    } catch {
        return []
    }
}

async function readSkillHeader(skillMdPath: string): Promise<string | null> {
    let file: Awaited<ReturnType<typeof open>> | null = null
    try {
        file = await open(skillMdPath, 'r')
        const buffer = Buffer.alloc(SKILL_HEADER_BYTES)
        const result = await file.read(buffer, 0, SKILL_HEADER_BYTES, 0)
        return buffer.subarray(0, result.bytesRead).toString('utf8')
    } catch {
        return null
    } finally {
        await file?.close().catch(() => undefined)
    }
}

function unquoteYamlScalar(value: string): string {
    const trimmed = value.trim()
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1).trim()
    }
    return trimmed
}

function parseFrontmatterHeader(header: string): { name?: string; description?: string; bodyStart: string } {
    const match = header.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)/)
    if (!match) {
        return { bodyStart: header }
    }

    const metadata: { name?: string; description?: string } = {}
    const yaml = match[1] ?? ''
    for (const line of yaml.split(/\r?\n/)) {
        const scalarMatch = line.match(/^\s*(name|description)\s*:\s*(.*?)\s*$/)
        if (!scalarMatch) {
            continue
        }

        const key = scalarMatch[1] as 'name' | 'description'
        const value = unquoteYamlScalar(scalarMatch[2] ?? '')
        if (value) {
            metadata[key] = value
        }
    }

    return { ...metadata, bodyStart: match[2] ?? '' }
}

function firstParagraphDescription(bodyStart: string): string {
    const paragraph = bodyStart
        .split(/\r?\n\s*\r?\n/)
        .map((part) => part.trim())
        .find((part) => part.length > 0)

    if (!paragraph) {
        return ''
    }

    return paragraph
        .replace(/^#+\s+/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 240)
        .trim()
}

export async function parseSkillMetadata(
    skillMdPath: string,
    fallbackName: string,
    scope: CodexSkillScope,
    options: {
        namePrefix?: string
        pluginName?: string
        pluginPath?: string
    } = {}
): Promise<CodexSkillSummary | null> {
    const header = await readSkillHeader(skillMdPath)
    if (header === null) {
        return null
    }

    const parsed = parseFrontmatterHeader(header)
    const name = (parsed.name ?? fallbackName).trim()
    if (!name) {
        return null
    }

    const displayName = options.namePrefix ? `${options.namePrefix}:${name}` : name

    return {
        name: displayName,
        description: parsed.description?.trim() ?? firstParagraphDescription(parsed.bodyStart),
        path: skillMdPath,
        scope,
        pluginName: options.pluginName,
        pluginPath: options.pluginPath,
    }
}

async function readSkillsFromRoot(skillsRoot: string, scope: CodexSkillScope): Promise<CodexSkillSummary[]> {
    const skillDirs = await listSkillDirectories(skillsRoot)
    const skills = await Promise.all(skillDirs.map(async (skillDir) => (
        await parseSkillMetadata(join(skillDir, 'SKILL.md'), basename(skillDir), scope)
    )))

    return skills
        .filter((skill): skill is CodexSkillSummary => skill !== null)
        .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

async function readSkillsFromRoots(roots: string[], scope: CodexSkillScope): Promise<CodexSkillSummary[]> {
    const skillsByRoot = await Promise.all(roots.map((root) => readSkillsFromRoot(root, scope)))
    return skillsByRoot.flat().sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

interface CodexPluginManifest {
    name: string
    skillsDir: string
    pluginPath: string
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function parsePluginManifest(manifestPath: string): Promise<CodexPluginManifest | null> {
    try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
        if (!isJsonRecord(manifest) || typeof manifest.name !== 'string' || !manifest.name.trim()) {
            return null
        }

        const pluginPath = dirname(dirname(manifestPath))
        const skillsValue = typeof manifest.skills === 'string' && manifest.skills.trim()
            ? manifest.skills
            : './skills'

        return {
            name: manifest.name.trim(),
            skillsDir: resolve(pluginPath, skillsValue),
            pluginPath,
        }
    } catch {
        return null
    }
}

async function findPluginManifestPaths(pluginCacheRoot: string): Promise<string[]> {
    const manifests: string[] = []

    async function visit(directory: string): Promise<void> {
        let entries: Dirent[]
        try {
            entries = await readdir(directory, { withFileTypes: true })
        } catch {
            return
        }

        if (entries.some((entry) => entry.isDirectory() && entry.name === '.codex-plugin')) {
            const manifestPath = join(directory, PLUGIN_MANIFEST_RELATIVE_PATH)
            if (await pathExists(manifestPath)) {
                manifests.push(manifestPath)
                return
            }
        }

        await Promise.all(entries.map(async (entry) => {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                return
            }
            await visit(join(directory, entry.name))
        }))
    }

    await visit(pluginCacheRoot)
    return manifests.sort((a, b) => a.localeCompare(b))
}

async function readPluginSkills(manifest: CodexPluginManifest): Promise<CodexSkillSummary[]> {
    const skillDirs = await listSkillDirectories(manifest.skillsDir)
    const skills = await Promise.all(skillDirs.map(async (skillDir) => (
        await parseSkillMetadata(join(skillDir, 'SKILL.md'), basename(skillDir), 'plugin', {
            namePrefix: manifest.name,
            pluginName: manifest.name,
            pluginPath: manifest.pluginPath,
        })
    )))

    return skills
        .filter((skill): skill is CodexSkillSummary => skill !== null)
        .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

async function readPluginSkillsFromCache(pluginCacheRoot: string): Promise<CodexSkillSummary[]> {
    const manifestPaths = await findPluginManifestPaths(pluginCacheRoot)
    const manifests = (await Promise.all(manifestPaths.map(parsePluginManifest)))
        .filter((manifest): manifest is CodexPluginManifest => manifest !== null)
    const skillsByPlugin = await Promise.all(manifests.map(readPluginSkills))
    return skillsByPlugin.flat().sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

export async function scanCodexSkillsForSession(
    workingDirectory?: string,
    options: CodexSkillScanOptions = {}
): Promise<CodexSkillSummary[]> {
    const repoRoots = await getRepoSkillsRoots(workingDirectory)
    const userRoots = getUserSkillsRoots(options)
    const pluginCacheRoot = getPluginCacheRoot(options)
    const adminRoot = getAdminSkillsRoot(options)

    const [repoSkills, userSkills, pluginSkills, adminSkills] = await Promise.all([
        readSkillsFromRoots(repoRoots, 'repo'),
        readSkillsFromRoots(userRoots, 'user'),
        readPluginSkillsFromCache(pluginCacheRoot),
        readSkillsFromRoot(adminRoot, 'admin'),
    ])

    return [...repoSkills, ...userSkills, ...pluginSkills, ...adminSkills]
}
