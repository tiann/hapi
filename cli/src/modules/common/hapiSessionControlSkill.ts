import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock'
import { parse as parseYaml } from 'yaml'
import { runtimePath } from '@/projectPath'
import { resolveSkill } from './skills'

export const HAPI_SESSION_CONTROL_SKILL_NAME = 'hapi-session-control'
export const HAPI_SESSION_CONTROL_SKILL_DESCRIPTION =
    'Create, wait for, inspect, message, stop, archive, or delete HAPI coding-agent sessions across machines and workspaces. Use for delegated work, peer messages, session links or IDs, result collection, and cleanup.'

function homeDirectory(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir()
}

export function nativeSkillRoot(flavor: string): string {
    const home = homeDirectory()
    switch (flavor) {
        case 'claude':
            return join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills')
        case 'codex':
            return join(process.env.CODEX_HOME || join(home, '.codex'), 'skills')
        case 'grok':
            return join(process.env.GROK_HOME || join(home, '.grok'), 'skills')
        case 'dsh':
            return join(process.env.DSH_HOME || join(home, '.dsh'), 'skills')
        case 'cursor':
            return join(home, '.cursor', 'skills')
        case 'opencode':
            // HAPI gives local OpenCode an isolated OPENCODE_CONFIG_DIR per
            // session; the runtime's native Agent Skills compatibility root
            // remains stable across local, remote, and resumed launches.
            return join(home, '.agents', 'skills')
        case 'kimi':
            return join(home, '.kimi', 'skills')
        case 'copilot':
            return join(home, '.copilot', 'skills')
        case 'agy':
            return join(home, '.gemini', 'antigravity-cli', 'skills')
        case 'pi':
            return join(home, '.pi', 'agent', 'skills')
        default:
            return join(home, '.agents', 'skills')
    }
}

function parseCanonicalSkill(source: string): { description: string; body: string } {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) throw new Error('Bundled hapi-session-control skill has no frontmatter')
    const frontmatter = parseYaml(match[1]!) as Record<string, unknown>
    if (frontmatter.name !== HAPI_SESSION_CONTROL_SKILL_NAME || typeof frontmatter.description !== 'string') {
        throw new Error('Bundled hapi-session-control skill has invalid metadata')
    }
    return { description: frontmatter.description.trim(), body: match[2]!.trim() }
}

export async function ensureHapiSessionControlSkill(flavor: string, workingDirectory: string): Promise<string> {
    const sourcePath = join(runtimePath(), 'skills', HAPI_SESSION_CONTROL_SKILL_NAME, 'SKILL.md')
    const source = await readFile(sourcePath, 'utf8').catch((error) => {
        throw new Error(`Canonical ${HAPI_SESSION_CONTROL_SKILL_NAME} skill is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    })
    const canonical = parseCanonicalSkill(source)
    const skillRoot = nativeSkillRoot(flavor)
    const targetDir = join(skillRoot, HAPI_SESSION_CONTROL_SKILL_NAME)
    const targetPath = join(targetDir, 'SKILL.md')
    const markerPath = join(targetDir, '.hapi-managed')

    await mkdir(skillRoot, { recursive: true, mode: 0o700 })
    await withSettingsFileLock(targetDir, async () => {
        const targetDirStat = await lstat(targetDir).catch(() => null)
        if (targetDirStat?.isSymbolicLink()) {
            throw new Error(`Refusing to replace user-managed skill directory symlink at ${targetDir}`)
        }
        if (targetDirStat && !targetDirStat.isDirectory()) {
            throw new Error(`Refusing to replace user-managed skill path at ${targetDir}`)
        }

        const created = !targetDirStat
        if (created) {
            await mkdir(targetDir, { mode: 0o700 })
        }

        const markerStat = await lstat(markerPath).catch(() => null)
        if (markerStat?.isSymbolicLink() || (markerStat && !markerStat.isFile())) {
            throw new Error(`Refusing invalid HAPI skill ownership marker at ${markerPath}`)
        }
        if (created) {
            await writeFile(markerPath, HAPI_SESSION_CONTROL_SKILL_NAME, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        }
        const managed = created || (
            markerStat?.isFile()
            && await readFile(markerPath, 'utf8').catch(() => null) === HAPI_SESSION_CONTROL_SKILL_NAME
        )

        const targetStat = await lstat(targetPath).catch(() => null)
        if (targetStat?.isSymbolicLink()) {
            throw new Error(`Refusing to replace user-managed skill file symlink at ${targetPath}`)
        }
        if (targetStat && !targetStat.isFile()) {
            throw new Error(`Refusing to replace user-managed skill path at ${targetPath}`)
        }
        const installed = targetStat?.isFile()
            ? await readFile(targetPath, 'utf8').catch(() => null)
            : null
        if (installed !== source && !managed) {
            throw new Error(`Refusing to overwrite user-managed skill at ${targetPath}`)
        }
        if (installed !== source) {
            const temporaryPath = join(targetDir, `.SKILL.md.${process.pid}.${randomUUID()}.tmp`)
            try {
                await writeFile(temporaryPath, source, { encoding: 'utf8', mode: 0o600 })
                await rename(temporaryPath, targetPath)
            } finally {
                await unlink(temporaryPath).catch(() => {})
            }
        }
    })

    const effective = await resolveSkill(HAPI_SESSION_CONTROL_SKILL_NAME, workingDirectory, { flavor })
    if (
        !effective
        || canonical.description !== HAPI_SESSION_CONTROL_SKILL_DESCRIPTION
        || effective.description !== HAPI_SESSION_CONTROL_SKILL_DESCRIPTION
        || effective.body !== canonical.body
    ) {
        throw new Error(`Canonical ${HAPI_SESSION_CONTROL_SKILL_NAME} skill is shadowed or could not be verified`)
    }
    return targetPath
}
