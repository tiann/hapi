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
    const originalDshHome = process.env.DSH_HOME
    let sandboxDir: string
    let homeDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skills-'))
        homeDir = join(sandboxDir, 'home')
        process.env.HOME = homeDir
        delete process.env.CLAUDE_CONFIG_DIR
        delete process.env.CODEX_HOME
        delete process.env.DSH_HOME
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

        if (originalDshHome === undefined) {
            delete process.env.DSH_HOME
        } else {
            process.env.DSH_HOME = originalDshHome
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

    it('lists symlinked skill directories and ignores invalid symlink targets', async () => {
        const skillsRoot = join(homeDir, '.agents', 'skills')
        const source = join(sandboxDir, 'shared-skills', 'linked')
        await writeSkill(source, 'linked', 'Linked skill')
        await mkdir(skillsRoot, { recursive: true })
        await symlink(source, join(skillsRoot, 'linked'), 'dir')
        await symlink(join(sandboxDir, 'missing'), join(skillsRoot, 'broken'), 'dir')
        await writeFile(join(sandboxDir, 'not-a-directory'), 'not a skill')
        await symlink(join(sandboxDir, 'not-a-directory'), join(skillsRoot, 'file-link'))

        const skills = await listSkills()

        expect(skills).toEqual([{ name: 'linked', description: 'Linked skill' }])
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

    it('lists Copilot user and project skills alongside shared .agents skills', async () => {
        const repoRoot = join(sandboxDir, 'copilot-repo')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(homeDir, '.copilot', 'skills', 'copilot-user'), 'copilot-user', 'Copilot user skill')
        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'Shared skill')
        await writeSkill(join(repoRoot, '.github', 'skills', 'github-skill'), 'github-skill', 'GitHub skill')

        const skills = await listSkills(repoRoot, { flavor: 'copilot' })

        expect(skills.map((skill) => skill.name)).toEqual(['copilot-user', 'github-skill', 'shared'])
    })

    it('lists DSH user and project skills alongside shared .agents skills', async () => {
        const repoRoot = join(sandboxDir, 'dsh-repo')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(homeDir, '.dsh', 'skills', 'dsh-user'), 'dsh-user', 'DSH user skill')
        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'Shared skill')
        await writeSkill(join(repoRoot, '.dsh', 'skills', 'dsh-project'), 'dsh-project', 'DSH project skill')

        const skills = await listSkills(repoRoot, { flavor: 'dsh' })

        expect(skills.map((skill) => skill.name)).toEqual(['dsh-project', 'dsh-user', 'shared'])
    })

    it('lists Antigravity (agy) user and project skills across .gemini and .agent roots', async () => {
        const repoRoot = join(sandboxDir, 'agy-repo')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(homeDir, '.gemini', 'config', 'skills', 'agy-config-skill'), 'agy-config-skill', 'AGY config skill')
        await writeSkill(join(homeDir, '.gemini', 'antigravity-cli', 'skills', 'agy-cli-skill'), 'agy-cli-skill', 'AGY CLI skill')
        await writeSkill(join(repoRoot, '.agent', 'skills', 'agy-project-skill'), 'agy-project-skill', 'AGY project skill')

        const skills = await listSkills(repoRoot, { flavor: 'agy' })

        expect(skills.map((skill) => skill.name)).toEqual(['agy-cli-skill', 'agy-config-skill', 'agy-project-skill'])
    })

    it('discovers Antigravity plugins and honors disabled flags and ~/.gemini/config/config.json overrides', async () => {
        const repoRoot = join(sandboxDir, 'agy-plugin-repo')
        await mkdir(join(repoRoot, '.git'), { recursive: true })

        // Project native plugin (enabled by default)
        const nativePlugin = join(repoRoot, '.agents', 'plugins', 'team-kit')
        await mkdir(nativePlugin, { recursive: true })
        await writeFile(join(nativePlugin, 'plugin.json'), JSON.stringify({ name: 'team-kit' }))
        await writeSkill(join(nativePlugin, 'skills', 'plugin-alpha'), 'plugin-alpha', 'Native plugin skill')

        // Antigravity-layout plugin disabled by default in plugin.json, re-enabled by config.json
        const reenabledPlugin = join(repoRoot, '.agent', 'plugins', 'reenabled-kit')
        await mkdir(join(reenabledPlugin, '.antigravity-plugin'), { recursive: true })
        await writeFile(join(reenabledPlugin, 'plugin.json'), JSON.stringify({ name: 'reenabled-kit', disabled: true }))
        await writeFile(join(reenabledPlugin, '.antigravity-plugin', 'plugin.json'), JSON.stringify({ name: 'reenabled-kit' }))
        await writeSkill(join(reenabledPlugin, 'skills', 'plugin-beta'), 'plugin-beta', 'Re-enabled skill')

        // Disabled via config.json override and via default disabled: true without override
        const disabledByConfig = join(homeDir, '.gemini', 'config', 'plugins', 'noisy-kit')
        await mkdir(disabledByConfig, { recursive: true })
        await writeFile(join(disabledByConfig, 'plugin.json'), JSON.stringify({ name: 'noisy-kit' }))
        await writeSkill(join(disabledByConfig, 'skills', 'noisy-skill'), 'noisy-skill', 'Should stay hidden')

        const disabledByManifest = join(homeDir, '.gemini', 'antigravity-cli', 'plugins', 'off-kit')
        await mkdir(disabledByManifest, { recursive: true })
        await writeFile(join(disabledByManifest, 'plugin.json'), JSON.stringify({ name: 'off-kit', disabled: true }))
        await writeSkill(join(disabledByManifest, 'skills', 'off-skill'), 'off-skill', 'Disabled by manifest')

        await mkdir(join(homeDir, '.gemini', 'config'), { recursive: true })
        await writeFile(join(homeDir, '.gemini', 'config', 'config.json'), JSON.stringify({
            plugins: {
                'reenabled-kit': { enabled: true },
                'noisy-kit': { enabled: false }
            }
        }))

        const skills = await listSkills(repoRoot, { flavor: 'agy' })
        expect(skills.map((skill) => skill.name)).toEqual(['plugin-alpha', 'plugin-beta'])
        await expect(resolveSkill('plugin-alpha', repoRoot, { flavor: 'agy' })).resolves.toEqual({
            name: 'plugin-alpha',
            description: 'Native plugin skill',
            body: '# plugin-alpha'
        })
    })

    it('loads Antigravity skills.json and plugins.json manifests with inherits, filters, cycles, and precedence', async () => {
        const repoRoot = join(sandboxDir, 'agy-manifest-repo')
        const nestedCwd = join(repoRoot, 'apps', 'web')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await mkdir(nestedCwd, { recursive: true })
        await mkdir(join(repoRoot, '.agents'), { recursive: true })
        await mkdir(join(homeDir, '.gemini', 'config'), { recursive: true })

        await writeSkill(join(repoRoot, '.agents', 'skills', 'alpha'), 'alpha', 'Project standard wins')
        await writeSkill(join(repoRoot, 'tools', 'team-skills', 'alpha'), 'alpha', 'Team manifest loses')
        await writeSkill(join(repoRoot, 'tools', 'team-skills', 'shared-tool'), 'shared-tool', 'Shared workspace skill')
        await writeSkill(join(repoRoot, 'tools', 'team-skills', 'exp-beta'), 'exp-beta', 'Should be excluded by regex')

        const sharedSkillsRoot = join(repoRoot, 'shared-pool', 'skills')
        await writeSkill(join(sharedSkillsRoot, 'lint-helper'), 'lint-helper', 'Inherited lint helper')
        await writeSkill(join(sharedSkillsRoot, 'skip-me'), 'skip-me', 'Excluded inherited skill')
        await writeSkill(join(homeDir, 'home-skills', 'til-skill'), 'til-skill', 'Home relative skill')

        await mkdir(join(repoRoot, 'manifests'), { recursive: true })
        const cycleA = join(repoRoot, 'manifests', 'cycle-a.json')
        const cycleB = join(repoRoot, 'manifests', 'cycle-b.json')
        await writeFile(cycleA, JSON.stringify({
            entries: [{ path: 'shared-pool/skills', include_only: ['lint-helper', '[unclosed-regex'] }],
            inherits: [{ path: 'manifests/cycle-b.json' }]
        }))
        await writeFile(cycleB, JSON.stringify({
            inherits: [{ path: 'manifests/cycle-a.json' }]
        }))

        await writeFile(join(repoRoot, '.agents', 'skills.json'), JSON.stringify({
            entries: [{ path: 'tools/team-skills', exclude: ['exp-.*'] }],
            inherits: [{ path: 'manifests/cycle-a.json', exclude: ['skip-me'] }]
        }))
        await writeFile(join(homeDir, '.gemini', 'config', 'skills.json'), JSON.stringify({
            entries: [{ path: '~/home-skills' }]
        }))

        const manifestPluginsRoot = join(sandboxDir, 'extra-plugins')
        await mkdir(join(manifestPluginsRoot, 'ext-kit'), { recursive: true })
        await writeFile(join(manifestPluginsRoot, 'ext-kit', 'plugin.json'), JSON.stringify({ name: 'ext-kit' }))
        await writeSkill(join(manifestPluginsRoot, 'ext-kit', 'skills', 'ext-skill'), 'ext-skill', 'Plugin manifest skill')
        await writeFile(join(homeDir, '.gemini', 'config', 'plugins.json'), JSON.stringify({
            entries: [{ path: manifestPluginsRoot, include_only: ['ext-kit'] }]
        }))

        const skills = await listSkills(nestedCwd, { flavor: 'agy' })
        expect(skills.map((skill) => skill.name)).toEqual([
            'alpha',
            'ext-skill',
            'lint-helper',
            'shared-tool',
            'til-skill'
        ])
        expect(skills.find((s) => s.name === 'alpha')?.description).toBe('Project standard wins')
        await expect(resolveSkill('ext-skill', nestedCwd, { flavor: 'agy' })).resolves.toEqual({
            name: 'ext-skill',
            description: 'Plugin manifest skill',
            body: '# ext-skill'
        })
    })

    it('uses a configured DSH_HOME for DSH user skills', async () => {
        const dshHome = join(sandboxDir, 'custom-dsh')
        process.env.DSH_HOME = dshHome

        await writeSkill(join(homeDir, '.agents', 'skills', 'shared'), 'shared', 'Shared skill')
        await writeSkill(join(homeDir, '.dsh', 'skills', 'default-dsh'), 'default-dsh', 'Default DSH skill')
        await writeSkill(join(dshHome, 'skills', 'custom-dsh'), 'custom-dsh', 'Custom DSH skill')

        const skills = await listSkills(undefined, { flavor: 'dsh' })

        expect(skills.map((skill) => skill.name)).toEqual(['custom-dsh', 'shared'])
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

    it('resolves a DSH user skill from the DSH harness home', async () => {
        await writeSkill(join(homeDir, '.dsh', 'skills', 'dsh-user'), 'dsh-user', 'DSH user skill')

        await expect(resolveSkill('dsh-user', undefined, { flavor: 'dsh' })).resolves.toEqual({
            name: 'dsh-user',
            description: 'DSH user skill',
            body: '# dsh-user'
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

    it('rejects oversized agy manifests (>256 KiB)', async () => {
        const projectDir = join(sandboxDir, 'oversized-proj')
        await mkdir(join(projectDir, '.agents'), { recursive: true })
        await writeSkill(join(projectDir, 'local-ok-skills', 'ok'), 'ok', 'Should not load')
        await writeFile(
            join(projectDir, '.agents', 'skills.json'),
            JSON.stringify({
                entries: [{ path: 'local-ok-skills' }],
                padding: 'x'.repeat(260 * 1024),
            })
        )

        const skills = await listSkills(projectDir, { flavor: 'agy' })
        expect(skills.some((skill) => skill.name === 'ok')).toBe(false)
    })

    it('resolves workspace-relative agy manifest paths from projectDir before falling back to repoRoot', async () => {
        const repoDir = join(sandboxDir, 'repo')
        const subDir = join(repoDir, 'packages', 'app')
        await mkdir(join(repoDir, '.git'), { recursive: true })
        await mkdir(join(subDir, '.agents', 'shared', 'dot-only'), { recursive: true })
        await writeSkill(join(subDir, '.agents', 'shared', 'dot-only'), 'dot-only', 'Inside .agents')
        await writeSkill(join(subDir, 'shared', 'workspace-skill'), 'workspace-skill', 'Workspace relative')
        await writeSkill(join(repoDir, 'repo-only', 'repo-fallback-skill'), 'repo-fallback-skill', 'Repo root fallback')
        await writeFile(
            join(subDir, '.agents', 'skills.json'),
            JSON.stringify({
                entries: [
                    { path: 'shared' },
                    { path: 'repo-only' },
                ],
            })
        )

        const skills = await listSkills(subDir, { flavor: 'agy' })
        const names = skills.map((s) => s.name)
        expect(names).toContain('workspace-skill')
        expect(names).toContain('repo-fallback-skill')
        expect(names).not.toContain('dot-only')
    })

    it('applies branch-specific filters when two branches inherit the same shared agy manifest', async () => {
        const projectDir = join(sandboxDir, 'diamond-proj')
        await mkdir(join(projectDir, '.agents'), { recursive: true })
        await writeSkill(join(projectDir, 'shared-pool', 'alpha'), 'alpha', 'Alpha skill')
        await writeSkill(join(projectDir, 'shared-pool', 'beta'), 'beta', 'Beta skill')
        await writeSkill(join(projectDir, 'shared-pool', 'gamma'), 'gamma', 'Gamma skill')

        await writeFile(
            join(projectDir, 'shared.json'),
            JSON.stringify({ entries: [{ path: 'shared-pool' }] })
        )
        await writeFile(
            join(projectDir, '.agents', 'skills.json'),
            JSON.stringify({
                inherits: [
                    { path: 'shared.json', include_only: ['alpha'] },
                    { path: 'shared.json', include_only: ['beta'] },
                ],
            })
        )

        const skills = await listSkills(projectDir, { flavor: 'agy' })
        const names = skills.map((s) => s.name)
        expect(names).toContain('alpha')
        expect(names).toContain('beta')
        expect(names).not.toContain('gamma')
    })

    it('enforces workspace confinement on project manifests, plugins, and symlinks while keeping user external manifests working', async () => {
        const repoDir = join(sandboxDir, 'confined-repo')
        const subDir = join(repoDir, 'packages', 'app')
        await mkdir(join(repoDir, '.git'), { recursive: true })
        await mkdir(join(subDir, '.agents', 'skills'), { recursive: true })
        await mkdir(join(subDir, '.agents', 'plugins'), { recursive: true })
        await mkdir(join(homeDir, '.gemini', 'config'), { recursive: true })

        await writeSkill(join(repoDir, 'local-pool', 'in-repo-ok'), 'in-repo-ok', 'Allowed inside repo')

        const outsideSkills = join(sandboxDir, 'outside-secret-skills')
        await writeSkill(join(outsideSkills, 'abs-escape'), 'abs-escape', 'Absolute escape')
        await writeSkill(join(outsideSkills, 'rel-escape'), 'rel-escape', 'Parent traversal escape')
        await writeSkill(join(outsideSkills, 'symlink-dir-escape'), 'symlink-dir-escape', 'Symlink dir escape')
        const outsideSkillMd = join(sandboxDir, 'outside-skill.md')
        await writeFile(outsideSkillMd, '---\nname: symlink-file-escape\ndescription: Symlink file escape\n---\n\n# secret')

        const outsideManifest = join(sandboxDir, 'external-shared.json')
        await writeFile(outsideManifest, JSON.stringify({ entries: [{ path: outsideSkills }] }))
        await writeSkill(join(outsideSkills, 'inherited-escape'), 'inherited-escape', 'Inherited manifest escape')

        const outsidePlugin = join(sandboxDir, 'outside-plugin')
        await mkdir(outsidePlugin, { recursive: true })
        await writeFile(join(outsidePlugin, 'plugin.json'), JSON.stringify({ name: 'outside-plugin' }))
        await writeSkill(join(outsidePlugin, 'skills', 'plugin-escape'), 'plugin-escape', 'Escaped plugin skill')

        const dirSymlinkType = process.platform === 'win32' ? 'junction' : 'dir'
        await symlink(join(outsideSkills, 'symlink-dir-escape'), join(subDir, '.agents', 'skills', 'symlink-dir-escape'), dirSymlinkType)
        await mkdir(join(subDir, '.agents', 'skills', 'symlink-file-wrap'), { recursive: true })
        await symlink(outsideSkillMd, join(subDir, '.agents', 'skills', 'symlink-file-wrap', 'SKILL.md'))
        await symlink(outsidePlugin, join(subDir, '.agents', 'plugins', 'outside-plugin'), dirSymlinkType)

        await writeFile(join(subDir, '.agents', 'skills.json'), JSON.stringify({
            entries: [
                { path: '../../local-pool' },
                { path: outsideSkills },
                { path: '../../../outside-secret-skills' },
            ],
            inherits: [{ path: '../../../external-shared.json' }],
        }))
        await writeFile(join(subDir, '.agents', 'plugins.json'), JSON.stringify({
            entries: [
                { path: outsidePlugin },
                { path: '.agents/plugins' },
            ],
        }))

        const userSharedDir = join(sandboxDir, 'user-shared-pool')
        await writeSkill(join(userSharedDir, 'user-external-ok'), 'user-external-ok', 'Allowed via user manifest')
        const userSharedManifest = join(sandboxDir, 'user-shared.json')
        await writeFile(userSharedManifest, JSON.stringify({ entries: [{ path: userSharedDir }] }))
        await writeFile(join(homeDir, '.gemini', 'config', 'skills.json'), JSON.stringify({
            inherits: [{ path: userSharedManifest }],
        }))

        const skills = await listSkills(subDir, { flavor: 'agy' })
        const names = skills.map((s) => s.name)
        expect(names).toContain('in-repo-ok')
        expect(names).toContain('user-external-ok')
        expect(names).not.toContain('abs-escape')
        expect(names).not.toContain('rel-escape')
        expect(names).not.toContain('symlink-dir-escape')
        expect(names).not.toContain('symlink-file-escape')
        expect(names).not.toContain('inherited-escape')
        expect(names).not.toContain('plugin-escape')
    })
})
