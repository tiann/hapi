import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillMetadata, scanCodexSkillsForSession } from './codexSkills'

async function writeSkill(skillDir: string, name?: string, description?: string): Promise<void> {
    await mkdir(skillDir, { recursive: true })

    const frontmatter = name || description
        ? [
            '---',
            name ? `name: ${name}` : '',
            description ? `description: ${description}` : '',
            '---',
            '',
        ].filter(Boolean).join('\n')
        : ''

    await writeFile(join(skillDir, 'SKILL.md'), `${frontmatter}${name ? `# ${name}` : '# Fallback'}\n`)
}

async function writePluginManifest(pluginRoot: string, name = 'compound-engineering', skills = './skills/'): Promise<void> {
    await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
    await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
        name,
        skills,
    }))
}

describe('codex skill discovery', () => {
    const originalHome = process.env.HOME
    const originalCodexHome = process.env.CODEX_HOME
    let sandboxDir: string
    let homeDir: string
    let adminDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-codex-skills-'))
        homeDir = join(sandboxDir, 'home')
        adminDir = join(sandboxDir, 'admin-skills')
        process.env.HOME = homeDir
        delete process.env.CODEX_HOME
        await mkdir(homeDir, { recursive: true })
    })

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }

        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }

        await rm(sandboxDir, { recursive: true, force: true })
    })

    it('scans user skills from ~/.agents/skills', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'review'), 'review', 'Review code changes.')

        const skills = await scanCodexSkillsForSession(undefined, { adminSkillsRoot: adminDir })

        expect(skills).toEqual([
            {
                name: 'review',
                description: 'Review code changes.',
                path: join(homeDir, '.agents', 'skills', 'review', 'SKILL.md'),
                scope: 'user',
            },
        ])
    })

    it('scans user skills from CODEX_HOME/skills when CODEX_HOME is set', async () => {
        const codexHome = join(sandboxDir, 'codex-home')
        process.env.CODEX_HOME = codexHome
        await writeSkill(join(codexHome, 'skills', 'plan'), 'plan', 'Plan work.')

        const skills = await scanCodexSkillsForSession(undefined, { adminSkillsRoot: adminDir })

        expect(skills.map((skill) => skill.name)).toEqual(['plan'])
        expect(skills[0]?.scope).toBe('user')
    })

    it('scans plugin skills from CODEX_HOME/plugins/cache', async () => {
        const codexHome = join(sandboxDir, 'codex-home')
        const pluginRoot = join(codexHome, 'plugins', 'cache', 'compound-engineering-plugin', 'compound-engineering', '3.6.1')
        process.env.CODEX_HOME = codexHome
        await writePluginManifest(pluginRoot, 'compound-engineering')
        await writeSkill(join(pluginRoot, 'skills', 'ce-plan'), 'ce-plan', 'Plan work.')

        const skills = await scanCodexSkillsForSession(undefined, { homeDir, adminSkillsRoot: adminDir })

        expect(skills).toEqual([
            {
                name: 'compound-engineering:ce-plan',
                description: 'Plan work.',
                path: join(pluginRoot, 'skills', 'ce-plan', 'SKILL.md'),
                scope: 'plugin',
                pluginName: 'compound-engineering',
                pluginPath: pluginRoot,
            },
        ])
    })

    it('falls back to ~/.codex/plugins/cache when CODEX_HOME is not set', async () => {
        const pluginRoot = join(homeDir, '.codex', 'plugins', 'cache', 'compound-engineering-plugin', 'compound-engineering', '3.6.1')
        await writePluginManifest(pluginRoot, 'compound-engineering')
        await writeSkill(join(pluginRoot, 'skills', 'ce-work'), 'ce-work', 'Execute work.')

        const skills = await scanCodexSkillsForSession(undefined, { adminSkillsRoot: adminDir })

        expect(skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
            'plugin:compound-engineering:ce-work',
        ])
    })

    it('uses plugin skill frontmatter names when they differ from folder names', async () => {
        const codexHome = join(sandboxDir, 'codex-home')
        const pluginRoot = join(codexHome, 'plugins', 'cache', 'example-plugin', 'example', '1.0.0')
        process.env.CODEX_HOME = codexHome
        await writePluginManifest(pluginRoot, 'example')
        await writeSkill(join(pluginRoot, 'skills', 'folder-name'), 'frontmatter-name', 'From frontmatter.')

        const skills = await scanCodexSkillsForSession(undefined, { homeDir, adminSkillsRoot: adminDir })

        expect(skills.map((skill) => skill.name)).toEqual(['example:frontmatter-name'])
    })

    it('skips plugin manifests with missing skills directories', async () => {
        const codexHome = join(sandboxDir, 'codex-home')
        const pluginRoot = join(codexHome, 'plugins', 'cache', 'empty-plugin', 'empty', '1.0.0')
        process.env.CODEX_HOME = codexHome
        await writePluginManifest(pluginRoot, 'empty')

        const skills = await scanCodexSkillsForSession(undefined, { homeDir, adminSkillsRoot: adminDir })

        expect(skills).toEqual([])
    })

    it('skips malformed plugin manifests', async () => {
        const codexHome = join(sandboxDir, 'codex-home')
        const pluginRoot = join(codexHome, 'plugins', 'cache', 'bad-plugin', 'bad', '1.0.0')
        process.env.CODEX_HOME = codexHome
        await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
        await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), '{bad json')
        await writeSkill(join(pluginRoot, 'skills', 'ignored'), 'ignored', 'Ignored.')

        const skills = await scanCodexSkillsForSession(undefined, { homeDir, adminSkillsRoot: adminDir })

        expect(skills).toEqual([])
    })

    it('scans repo skills from cwd up to git root', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const packageDir = join(repoRoot, 'packages')
        const workingDirectory = join(packageDir, 'app')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(repoRoot, '.agents', 'skills', 'root'), 'root', 'Root skill.')
        await writeSkill(join(packageDir, '.codex', 'skills', 'package'), 'package', 'Package skill.')
        await writeSkill(join(workingDirectory, '.agents', 'skills', 'local'), 'local', 'Local skill.')
        await writeSkill(join(sandboxDir, '.agents', 'skills', 'outside'), 'outside', 'Outside skill.')

        const skills = await scanCodexSkillsForSession(workingDirectory, { homeDir, adminSkillsRoot: adminDir })

        expect(skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
            'repo:local',
            'repo:package',
            'repo:root',
        ])
    })

    it('uses only cwd repo skills when no git root exists', async () => {
        const parentDirectory = join(sandboxDir, 'workspace')
        const workingDirectory = join(parentDirectory, 'feature')

        await writeSkill(join(parentDirectory, '.agents', 'skills', 'parent'), 'parent', 'Parent skill.')
        await writeSkill(join(workingDirectory, '.agents', 'skills', 'local'), 'local', 'Local skill.')

        const skills = await scanCodexSkillsForSession(workingDirectory, { homeDir, adminSkillsRoot: adminDir })

        expect(skills.map((skill) => skill.name)).toEqual(['local'])
    })

    it('parses SKILL.md frontmatter', async () => {
        const skillDir = join(homeDir, '.agents', 'skills', 'review-folder')
        await writeSkill(skillDir, 'review', 'Review current code changes.')

        const skill = await parseSkillMetadata(join(skillDir, 'SKILL.md'), 'review-folder', 'user')

        expect(skill).toMatchObject({
            name: 'review',
            description: 'Review current code changes.',
            scope: 'user',
        })
    })

    it('falls back to directory name when frontmatter is missing', async () => {
        const skillDir = join(homeDir, '.agents', 'skills', 'no-frontmatter')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), '# First paragraph\n\nMore details that stay server-side.\n')

        const skills = await scanCodexSkillsForSession(undefined, { adminSkillsRoot: adminDir })

        expect(skills).toEqual([
            {
                name: 'no-frontmatter',
                description: 'First paragraph',
                path: join(skillDir, 'SKILL.md'),
                scope: 'user',
            },
        ])
    })

    it('silently skips missing directories', async () => {
        await expect(scanCodexSkillsForSession(join(sandboxDir, 'missing'), {
            homeDir: join(sandboxDir, 'missing-home'),
            adminSkillsRoot: join(sandboxDir, 'missing-admin'),
        })).resolves.toEqual([])
    })

    it('keeps duplicate skill names from different scopes', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(repoRoot, '.agents', 'skills', 'review'), 'review', 'Repo review.')
        await writeSkill(join(homeDir, '.agents', 'skills', 'review'), 'review', 'User review.')
        const pluginRoot = join(homeDir, '.codex', 'plugins', 'cache', 'review-plugin', 'review-plugin', '1.0.0')
        await writePluginManifest(pluginRoot, 'review-plugin')
        await writeSkill(join(pluginRoot, 'skills', 'review'), 'review', 'Plugin review.')

        const skills = await scanCodexSkillsForSession(repoRoot, { homeDir, adminSkillsRoot: adminDir })

        expect(skills.map((skill) => `${skill.scope}:${skill.name}:${skill.description}`)).toEqual([
            'repo:review:Repo review.',
            'user:review:User review.',
            'plugin:review-plugin:review:Plugin review.',
        ])
    })

    it('sorts repo, user, plugin, and admin skills by scope group', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(repoRoot, '.agents', 'skills', 'repo'), 'repo', 'Repo skill.')
        await writeSkill(join(homeDir, '.agents', 'skills', 'user'), 'user', 'User skill.')
        await writeSkill(join(adminDir, 'admin'), 'admin', 'Admin skill.')
        const pluginRoot = join(homeDir, '.codex', 'plugins', 'cache', 'plugin-package', 'plugin', '1.0.0')
        await writePluginManifest(pluginRoot, 'plugin')
        await writeSkill(join(pluginRoot, 'skills', 'plugin-skill'), 'plugin-skill', 'Plugin skill.')

        const skills = await scanCodexSkillsForSession(repoRoot, { homeDir, adminSkillsRoot: adminDir })

        expect(skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
            'repo:repo',
            'user:user',
            'plugin:plugin:plugin-skill',
            'admin:admin',
        ])
    })

    it('supports symlinked skill folders', async () => {
        const targetDir = join(sandboxDir, 'shared-review')
        const linkDir = join(homeDir, '.agents', 'skills', 'linked-review')
        await writeSkill(targetDir, 'linked-review', 'Linked skill.')
        await mkdir(join(homeDir, '.agents', 'skills'), { recursive: true })
        await symlink(targetDir, linkDir)

        const skills = await scanCodexSkillsForSession(undefined, { adminSkillsRoot: adminDir })

        expect(skills.map((skill) => skill.name)).toEqual(['linked-review'])
    })
})
