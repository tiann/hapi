import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills } from './skills'

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
    const originalCodexHome = process.env.CODEX_HOME
    let sandboxDir: string
    let homeDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skills-'))
        homeDir = join(sandboxDir, 'home')
        process.env.HOME = homeDir
        process.env.CODEX_HOME = join(homeDir, '.codex')
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

    it('lists user skills from ~/.codex/skills', async () => {
        await writeSkill(join(homeDir, '.agents', 'skills', 'amis'), 'amis', 'AMIS guide')
        await writeSkill(join(homeDir, '.codex', 'skills', 'hello-agents'), 'helloagents', 'Main skill')
        // Hidden directories (starting with .) are skipped
        await writeSkill(join(homeDir, '.codex', 'skills', '.system', 'skill-creator'), 'skill-creator', 'Create skills')

        const skills = await listSkills()

        expect(skills.map((skill) => skill.name)).toEqual(['amis', 'helloagents'])
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

        const skills = await listSkills(workingDirectory)

        expect(skills.map((skill) => skill.name)).toEqual(['local-skill', 'package-skill', 'root-skill'])
    })

    it('loads project skills from .claude/skills directories', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const workingDirectory = join(repoRoot, 'apps', 'web')

        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await writeSkill(join(repoRoot, '.claude', 'skills', 'claude-root'), 'claude-root', 'Claude root skill')
        await writeSkill(join(workingDirectory, '.claude', 'skills', 'claude-local'), 'claude-local', 'Claude local skill')

        const skills = await listSkills(workingDirectory)

        expect(skills.map((skill) => skill.name)).toEqual(['claude-local', 'claude-root'])
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

    it('lists enabled Codex plugin skills with plugin-prefixed names', async () => {
        await mkdir(join(homeDir, '.codex'), { recursive: true })
        await writeFile(join(homeDir, '.codex', 'config.toml'), [
            '[plugins."superpowers@openai-curated"]',
            'enabled = true',
            '',
            '[plugins."figma@openai-curated"]',
            'enabled = false',
        ].join('\n'))
        await writeSkill(
            join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'superpowers', '421657af', 'skills', 'using-superpowers'),
            'using-superpowers',
            'Superpowers bootstrap'
        )
        await writeSkill(
            join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'figma', '421657af', 'skills', 'figma-design'),
            'figma-design',
            'Disabled plugin skill'
        )

        const skills = await listSkills(undefined, { agent: 'codex' })

        expect(skills).toContainEqual({
            name: 'superpowers:using-superpowers',
            description: 'Superpowers bootstrap'
        })
        expect(skills.find((skill) => skill.name === 'figma:figma-design')).toBeUndefined()
    })

    it('does not list Codex plugin skills for non-Codex agents', async () => {
        await mkdir(join(homeDir, '.codex'), { recursive: true })
        await writeFile(join(homeDir, '.codex', 'config.toml'), [
            '[plugins."superpowers@openai-curated"]',
            'enabled = true',
        ].join('\n'))
        await writeSkill(
            join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'superpowers', '421657af', 'skills', 'using-superpowers'),
            'using-superpowers',
            'Superpowers bootstrap'
        )

        const skills = await listSkills(undefined, { agent: 'claude' })

        expect(skills.find((skill) => skill.name === 'superpowers:using-superpowers')).toBeUndefined()
    })

    it('does not read Codex plugin skill files that are symlinks outside the plugin installation directory', async () => {
        await mkdir(join(homeDir, '.codex'), { recursive: true })
        await writeFile(join(homeDir, '.codex', 'config.toml'), [
            '[plugins."superpowers@openai-curated"]',
            'enabled = true',
        ].join('\n'))
        const skillDir = join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'superpowers', '421657af', 'skills', 'using-superpowers')
        const skillFile = join(skillDir, 'SKILL.md')
        const outsideSkillFile = join(sandboxDir, 'outside-SKILL.md')
        await writeSkill(skillDir, 'using-superpowers', 'Superpowers bootstrap')
        await rm(skillFile)
        await writeFile(outsideSkillFile, [
            '---',
            'name: using-superpowers',
            'description: Escaped plugin skill',
            '---',
            '',
            '# escaped',
        ].join('\n'))
        await symlink(outsideSkillFile, skillFile)

        const skills = await listSkills(undefined, { agent: 'codex' })

        expect(skills.find((skill) => skill.name === 'superpowers:using-superpowers')).toBeUndefined()
    })
})
