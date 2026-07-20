import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, MAX_SKILL_FILE_BYTES, resolveSkill } from './skills'

async function writeSkill(skillDir: string, name: string, description: string): Promise<void> {
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        `# ${name}`,
    ].join('\n'))
}

describe('listSkills', () => {
    const originalHome = process.env.HOME
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const originalCodexHome = process.env.CODEX_HOME
    let sandboxDir: string
    let homeDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skills-'))
        homeDir = join(sandboxDir, 'home')
        process.env.HOME = homeDir
        delete process.env.CLAUDE_CONFIG_DIR
        delete process.env.CODEX_HOME
        await mkdir(homeDir, { recursive: true })
    })

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }

        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
        }

        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }

        await rm(sandboxDir, { recursive: true, force: true })
    })

    it('returns empty list when skills directories are missing', async () => {
        await expect(listSkills()).resolves.toEqual([])
    })

    it('lists user skills from ~/.agents only', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'amis'), 'amis', 'AMIS guide')

        const skills = await listSkills()

        expect(skills.map((skill) => skill.name)).toEqual(['amis'])
    })

    it('lists user skills from ~/.claude/skills', async () => {
        await writeSkill(join(homeDir, '.claude', 'skills', 'claude-skill'), 'claude-skill', 'Claude skill')

        const skills = await listSkills()

        expect(skills.map((skill) => skill.name)).toEqual(['claude-skill'])
    })

    it('merges user skills from ~/.agents and ~/.claude, preferring ~/.agents', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'alpha'), 'alpha', 'Alpha from agents')
        await writeSkill(join(homeDir, '.claude', 'skills', 'beta'), 'beta', 'Beta from claude')
        await writeSkill(join(homeDir, '.claude', 'skills', 'alpha'), 'alpha', 'Alpha from claude')

        const skills = await listSkills()

        expect(skills.map((skill) => skill.name)).toEqual(['alpha', 'beta'])
        expect(skills.find((s) => s.name === 'alpha')?.description).toBe('Alpha from agents')
    })

    it('lists user skills from ~/.codex/skills including Codex bundled system skills for Codex', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'amis'), 'amis', 'AMIS guide')
        await writeSkill(join(homeDir, '.codex', 'skills', 'hello-agents'), 'helloagents', 'Main skill')
        await writeSkill(join(homeDir, '.codex', 'skills', '.system', 'skill-creator'), 'skill-creator', 'Create skills')

        const skills = await listSkills(undefined, { flavor: 'codex' })

        expect(skills.map((skill) => skill.name)).toEqual(['amis', 'helloagents', 'skill-creator'])
    })

    it('lists Grok user and project skills alongside shared .agents skills', async () => {
        const repoRoot = join(sandboxDir, 'grok-repo')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(homeDir, '.grok', 'skills', 'grok-user'), 'grok-user', 'Grok user skill')
        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'Shared skill')
        await writeSkill(join(repoRoot, '.grok', 'skills', 'grok-project'), 'grok-project', 'Grok project skill')

        const skills = await listSkills(repoRoot, { flavor: 'grok' })

        expect(skills.map((skill) => skill.name)).toEqual(['grok-project', 'grok-user', 'shared'])
    })

    it('scopes user skills to the requested flavor', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'Shared skill')
        await writeSkill(join(homeDir, '.claude', 'skills', 'claude-only'), 'claude-only', 'Claude skill')
        await writeSkill(join(homeDir, '.codex', 'skills', 'codex-only'), 'codex-only', 'Codex skill')

        const claudeSkills = await listSkills(undefined, { flavor: 'claude' })
        const codexSkills = await listSkills(undefined, { flavor: 'codex' })

        expect(claudeSkills.map((skill) => skill.name)).toEqual(['claude-only', 'shared'])
        expect(codexSkills.map((skill) => skill.name)).toEqual(['codex-only', 'shared'])
    })

    it('uses configured Claude and Codex homes for agent-specific user skills', async () => {
        const claudeConfigDir = join(sandboxDir, 'custom-claude')
        const codexHome = join(sandboxDir, 'custom-codex')
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
        process.env.CODEX_HOME = codexHome

        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'Shared skill')
        await writeSkill(join(homeDir, '.claude', 'skills', 'default-claude'), 'default-claude', 'Default Claude skill')
        await writeSkill(join(homeDir, '.codex', 'skills', 'default-codex'), 'default-codex', 'Default Codex skill')
        await writeSkill(join(claudeConfigDir, 'skills', 'custom-claude'), 'custom-claude', 'Custom Claude skill')
        await writeSkill(join(codexHome, 'skills', 'custom-codex'), 'custom-codex', 'Custom Codex skill')

        const claudeSkills = await listSkills(undefined, { flavor: 'claude' })
        const codexSkills = await listSkills(undefined, { flavor: 'codex' })

        expect(claudeSkills.map((skill) => skill.name)).toEqual(['custom-claude', 'shared'])
        expect(codexSkills.map((skill) => skill.name)).toEqual(['custom-codex', 'shared'])
    })

    it('includes Codex system skills from a configured CODEX_HOME', async () => {
        const codexHome = join(sandboxDir, 'custom-codex')
        process.env.CODEX_HOME = codexHome

        await writeSkill(join(codexHome, 'skills', 'custom-codex'), 'custom-codex', 'Custom Codex skill')
        await writeSkill(join(codexHome, 'skills', '.system', 'custom-system'), 'custom-system', 'Custom Codex system skill')

        const skills = await listSkills(undefined, { flavor: 'codex' })

        expect(skills.map((skill) => skill.name)).toEqual(['custom-codex', 'custom-system'])
    })

    it('includes installed marketplace skills for the requested flavor', async () => {
        const claudeInstallPath = join(homeDir, '.claude', 'plugins', 'cache', 'owner', 'claude-plugin', '1.0.0')
        const codexInstallPath = join(homeDir, '.codex', 'plugins', 'cache', 'owner', 'codex-plugin', '1.0.0')
        await writeSkill(join(claudeInstallPath, 'skills', 'claude-market'), 'claude-market', 'Claude marketplace skill')
        await writeSkill(join(codexInstallPath, 'skills', 'codex-market'), 'codex-market', 'Codex marketplace skill')
        await writeFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'claude-plugin@owner': [{ installPath: claudeInstallPath, lastUpdated: '2026-01-02T00:00:00.000Z' }]
            }
        }))
        await writeFile(join(homeDir, '.codex', 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'codex-plugin@owner': [{ installPath: codexInstallPath, lastUpdated: '2026-01-02T00:00:00.000Z' }]
            }
        }))

        const claudeSkills = await listSkills(undefined, { flavor: 'claude' })
        const codexSkills = await listSkills(undefined, { flavor: 'codex' })

        expect(claudeSkills.map((skill) => skill.name)).toEqual(['claude-market'])
        expect(codexSkills.map((skill) => skill.name)).toEqual(['codex-market'])
    })

    it('uses configured Claude and Codex homes for installed marketplace skills', async () => {
        const claudeConfigDir = join(sandboxDir, 'custom-claude')
        const codexHome = join(sandboxDir, 'custom-codex')
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
        process.env.CODEX_HOME = codexHome

        const claudeInstallPath = join(claudeConfigDir, 'plugins', 'cache', 'owner', 'claude-plugin', '1.0.0')
        const codexInstallPath = join(codexHome, 'plugins', 'cache', 'owner', 'codex-plugin', '1.0.0')
        await writeSkill(join(claudeInstallPath, 'skills', 'claude-market'), 'claude-market', 'Claude marketplace skill')
        await writeSkill(join(codexInstallPath, 'skills', 'codex-market'), 'codex-market', 'Codex marketplace skill')
        await writeFile(join(claudeConfigDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'claude-plugin@owner': [{ installPath: claudeInstallPath, lastUpdated: '2026-01-02T00:00:00.000Z' }]
            }
        }))
        await writeFile(join(codexHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'codex-plugin@owner': [{ installPath: codexInstallPath, lastUpdated: '2026-01-02T00:00:00.000Z' }]
            }
        }))

        const claudeSkills = await listSkills(undefined, { flavor: 'claude' })
        const codexSkills = await listSkills(undefined, { flavor: 'codex' })

        expect(claudeSkills.map((skill) => skill.name)).toEqual(['claude-market'])
        expect(codexSkills.map((skill) => skill.name)).toEqual(['codex-market'])
    })

    it('does not list cached marketplace skills that are not installed', async () => {
        await writeSkill(join(homeDir, '.codex', 'plugins', 'cache', 'owner', 'stale-plugin', '1.0.0', 'skills', 'stale-market'), 'stale-market', 'Stale marketplace skill')
        await mkdir(join(homeDir, '.codex', 'plugins'), { recursive: true })
        await writeFile(join(homeDir, '.codex', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }))

        const skills = await listSkills(undefined, { flavor: 'codex' })

        expect(skills.map((skill) => skill.name)).toEqual([])
    })

    it('uses the newest installed plugin path when multiple installations exist', async () => {
        const oldInstallPath = join(homeDir, '.codex', 'plugins', 'cache', 'owner', 'codex-plugin', '1.0.0')
        const newInstallPath = join(homeDir, '.codex', 'plugins', 'cache', 'owner', 'codex-plugin', '2.0.0')
        await writeSkill(join(oldInstallPath, 'skills', 'plugin-skill'), 'plugin-skill', 'Old marketplace skill')
        await writeSkill(join(newInstallPath, 'skills', 'plugin-skill'), 'plugin-skill', 'New marketplace skill')
        await writeFile(join(homeDir, '.codex', 'plugins', 'installed_plugins.json'), JSON.stringify({
            plugins: {
                'codex-plugin@owner': [
                    { installPath: oldInstallPath, lastUpdated: '2026-01-01T00:00:00.000Z' },
                    { installPath: newInstallPath, lastUpdated: '2026-01-02T00:00:00.000Z' }
                ]
            }
        }))

        const skills = await listSkills(undefined, { flavor: 'codex' })

        expect(skills).toEqual([{ name: 'plugin-skill', description: 'New marketplace skill' }])
    })

    it('falls back to directory name when frontmatter is missing', async () => {
        const skillDir = join(homeDir, '.agents', 'skills', 'no-frontmatter')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), '# No Frontmatter\n')

        await expect(listSkills()).resolves.toEqual([
            { name: 'no-frontmatter', description: undefined }
        ])
    })

    it('loads project skills from cwd up to repo root', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const packageDir = join(repoRoot, 'packages')
        const workingDirectory = join(packageDir, 'app')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(repoRoot, '.agents', 'skills', 'root-skill'), 'root-skill', 'Repo root skill')
        await writeSkill(join(packageDir, '.agents', 'skills', 'package-skill'), 'package-skill', 'Package skill')
        await writeSkill(join(workingDirectory, '.agents', 'skills', 'local-skill'), 'local-skill', 'Local skill')
        await writeSkill(join(sandboxDir, '.agents', 'skills', 'outside-skill'), 'outside-skill', 'Outside repo skill')

        const skills = await listSkills(workingDirectory, { flavor: 'claude' })

        expect(skills.map((skill) => skill.name)).toEqual(['local-skill', 'package-skill', 'root-skill'])
    })

    it('loads project skills from .claude/skills directories', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const workingDirectory = join(repoRoot, 'apps', 'web')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(repoRoot, '.claude', 'skills', 'claude-root'), 'claude-root', 'Claude root skill')
        await writeSkill(join(workingDirectory, '.claude', 'skills', 'claude-local'), 'claude-local', 'Claude local skill')

        const skills = await listSkills(workingDirectory, { flavor: 'claude' })

        expect(skills.map((skill) => skill.name)).toEqual(['claude-local', 'claude-root'])
    })

    it('loads project skills from .codex/skills directories', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const workingDirectory = join(repoRoot, 'apps', 'web')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(repoRoot, '.codex', 'skills', 'codex-root'), 'codex-root', 'Codex root skill')
        await writeSkill(join(workingDirectory, '.codex', 'skills', 'codex-local'), 'codex-local', 'Codex local skill')
        await writeSkill(join(workingDirectory, '.codex', 'skills', '.system', 'codex-system'), 'codex-system', 'Codex system skill')

        const skills = await listSkills(workingDirectory, { flavor: 'codex' })

        expect(skills.map((skill) => skill.name)).toEqual(['codex-local', 'codex-root', 'codex-system'])
    })

    it('prefers .agents project skills over .claude project skills with same name', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const workingDirectory = join(repoRoot, 'apps', 'web')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(workingDirectory, '.agents', 'skills', 'shared'), 'shared', 'From agents')
        await writeSkill(join(workingDirectory, '.claude', 'skills', 'shared'), 'shared', 'From claude')

        const skills = await listSkills(workingDirectory)

        expect(skills).toHaveLength(1)
        expect(skills[0]).toEqual({ name: 'shared', description: 'From agents' })
    })

    it('uses only cwd project skills outside a git repository', async () => {
        const parentDirectory = join(sandboxDir, 'workspace')
        const workingDirectory = join(parentDirectory, 'feature')

        await writeSkill(join(parentDirectory, '.agents', 'skills', 'parent-skill'), 'parent-skill', 'Parent skill')
        await writeSkill(join(workingDirectory, '.agents', 'skills', 'local-skill'), 'local-skill', 'Local skill')

        const skills = await listSkills(workingDirectory)

        expect(skills.map((skill) => skill.name)).toEqual(['local-skill'])
    })

    it('prefers nearest project skill over parent and user duplicates', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const workingDirectory = join(repoRoot, 'apps', 'web')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'User shared skill')
        await writeSkill(join(repoRoot, '.agents', 'skills', 'shared'), 'shared', 'Repo shared skill')
        await writeSkill(join(workingDirectory, '.agents', 'skills', 'shared'), 'shared', 'Local shared skill')

        const skills = await listSkills(workingDirectory)
        const sharedSkills = skills.filter((skill) => skill.name === 'shared')

        expect(sharedSkills).toHaveLength(1)
        expect(sharedSkills[0]).toEqual({
            name: 'shared',
            description: 'Local shared skill'
        })
    })

    it('resolves the same nearest project skill selected by listSkills', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const workingDirectory = join(repoRoot, 'apps', 'web')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'User shared skill')
        await writeSkill(join(repoRoot, '.agents', 'skills', 'shared'), 'shared', 'Repo shared skill')
        await writeSkill(join(workingDirectory, '.agents', 'skills', 'shared'), 'shared', 'Local shared skill')

        await expect(resolveSkill('shared', workingDirectory, { flavor: 'opencode' })).resolves.toEqual({
            name: 'shared',
            description: 'Local shared skill',
            body: '# shared'
        })
    })

    it('resolves a user skill when no project duplicate exists', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'user-only'), 'user-only', 'User skill')

        await expect(resolveSkill('user-only', undefined, { flavor: 'kimi' })).resolves.toEqual({
            name: 'user-only',
            description: 'User skill',
            body: '# user-only'
        })
    })

    it('returns null for an unknown exact skill name', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'known'), 'known', 'Known skill')

        await expect(resolveSkill('missing')).resolves.toBeNull()
    })

    it('preserves support for a symlinked SKILL.md file', async () => {
        const source = join(sandboxDir, 'shared-skill.md')
        const skillDir = join(homeDir, '.agents', 'skills', 'linked')
        await mkdir(skillDir, { recursive: true })
        await writeFile(source, [
            '---',
            'name: linked',
            'description: Linked skill',
            '---',
            '',
            '# Linked body'
        ].join('\n'))
        await symlink(source, join(skillDir, 'SKILL.md'))

        await expect(resolveSkill('linked')).resolves.toEqual({
            name: 'linked',
            description: 'Linked skill',
            body: '# Linked body'
        })
    })

    it('rejects path traversal instead of treating it as a skill path', async () => {
        await expect(resolveSkill('../settings.json')).rejects.toThrow('Invalid skill name')
        await expect(resolveSkill('nested/skill')).rejects.toThrow('Invalid skill name')
        await expect(resolveSkill('nested\\skill')).rejects.toThrow('Invalid skill name')
    })

    it('rejects a skill file that is too large to place in model context', async () => {
        const skillDir = join(homeDir, '.agents', 'skills', 'huge')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: huge',
            'description: Huge skill',
            '---',
            '',
            'x'.repeat(MAX_SKILL_FILE_BYTES)
        ].join('\n'))

        await expect(listSkills()).resolves.toContainEqual({
            name: 'huge',
            description: 'Huge skill'
        })
        await expect(resolveSkill('huge')).rejects.toThrow('Skill is too large to load')
    })
})
