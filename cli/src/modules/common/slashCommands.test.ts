import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listSlashCommands } from './slashCommands'

describe('listSlashCommands', () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const originalHome = process.env.HOME
    const originalCodexHome = process.env.CODEX_HOME
    let sandboxDir: string
    let claudeConfigDir: string
    let homeDir: string
    let projectDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-slash-commands-'))
        claudeConfigDir = join(sandboxDir, 'global-claude')
        homeDir = join(sandboxDir, 'home')
        projectDir = join(sandboxDir, 'project')

        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
        process.env.HOME = homeDir
        process.env.CODEX_HOME = join(homeDir, '.codex')

        await mkdir(join(claudeConfigDir, 'commands'), { recursive: true })
        await mkdir(homeDir, { recursive: true })
        await mkdir(join(projectDir, '.claude', 'commands'), { recursive: true })
    })

    afterEach(async () => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
        }
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

    it('keeps backward-compatible behavior when projectDir is not provided', async () => {
        await writeFile(
            join(claudeConfigDir, 'commands', 'global-only.md'),
            ['---', 'description: Global only', '---', '', 'Global command body'].join('\n')
        )

        const commands = await listSlashCommands('claude')
        const command = commands.find(cmd => cmd.name === 'global-only')

        expect(command).toBeDefined()
        expect(command?.source).toBe('user')
        expect(command?.description).toBe('Global only')
    })

    it('loads project-level commands when projectDir is provided', async () => {
        await writeFile(
            join(projectDir, '.claude', 'commands', 'project-only.md'),
            ['---', 'description: Project only', '---', '', 'Project command body'].join('\n')
        )

        const commands = await listSlashCommands('claude', projectDir)
        const command = commands.find(cmd => cmd.name === 'project-only')

        expect(command).toBeDefined()
        expect(command?.source).toBe('project')
        expect(command?.description).toBe('Project only')
    })

    it('prefers project command when project and global have same name', async () => {
        await writeFile(
            join(claudeConfigDir, 'commands', 'shared.md'),
            ['---', 'description: Global shared', '---', '', 'Global body'].join('\n')
        )
        await writeFile(
            join(projectDir, '.claude', 'commands', 'shared.md'),
            ['---', 'description: Project shared', '---', '', 'Project body'].join('\n')
        )

        const commands = await listSlashCommands('claude', projectDir)
        const sharedCommands = commands.filter(cmd => cmd.name === 'shared')

        expect(sharedCommands).toHaveLength(1)
        expect(sharedCommands[0]?.source).toBe('project')
        expect(sharedCommands[0]?.description).toBe('Project shared')
        expect(sharedCommands[0]?.content).toBe('Project body')
    })

    it('loads nested project commands using colon-separated names', async () => {
        await mkdir(join(projectDir, '.claude', 'commands', 'trellis'), { recursive: true })
        await writeFile(
            join(projectDir, '.claude', 'commands', 'trellis', 'start.md'),
            ['---', 'description: Trellis start', '---', '', 'Start flow'].join('\n')
        )

        const commands = await listSlashCommands('claude', projectDir)
        const command = commands.find(cmd => cmd.name === 'trellis:start')

        expect(command).toBeDefined()
        expect(command?.source).toBe('project')
        expect(command?.description).toBe('Trellis start')
    })

    it('loads Claude built-in and custom commands for claude-deepseek', async () => {
        await writeFile(
            join(claudeConfigDir, 'commands', 'deepseek-user.md'),
            ['---', 'description: DeepSeek user', '---', '', 'User command body'].join('\n')
        )
        await writeFile(
            join(projectDir, '.claude', 'commands', 'deepseek-project.md'),
            ['---', 'description: DeepSeek project', '---', '', 'Project command body'].join('\n')
        )

        const commands = await listSlashCommands('claude-deepseek', projectDir)

        expect(commands).toContainEqual({
            name: 'clear',
            description: 'Clear conversation history',
            source: 'builtin'
        })
        expect(commands).toContainEqual({
            name: 'goal',
            description: 'Set, view, or clear the conversation goal',
            source: 'builtin'
        })
        expect(commands).toContainEqual({
            name: 'deepseek-user',
            description: 'DeepSeek user',
            source: 'user',
            content: 'User command body',
            pluginName: undefined
        })
        expect(commands).toContainEqual({
            name: 'deepseek-project',
            description: 'DeepSeek project',
            source: 'project',
            content: 'Project command body',
            pluginName: undefined
        })
    })

    it('loads Claude built-in and custom commands for claude-ark', async () => {
        await writeFile(
            join(claudeConfigDir, 'commands', 'ark-user.md'),
            ['---', 'description: Ark user', '---', '', 'User command body'].join('\n')
        )
        await writeFile(
            join(projectDir, '.claude', 'commands', 'ark-project.md'),
            ['---', 'description: Ark project', '---', '', 'Project command body'].join('\n')
        )

        const commands = await listSlashCommands('claude-ark', projectDir)

        expect(commands).toContainEqual({
            name: 'clear',
            description: 'Clear conversation history',
            source: 'builtin'
        })
        expect(commands).toContainEqual({
            name: 'goal',
            description: 'Set, view, or clear the conversation goal',
            source: 'builtin'
        })
        expect(commands).toContainEqual({
            name: 'ark-user',
            description: 'Ark user',
            source: 'user',
            content: 'User command body',
            pluginName: undefined
        })
        expect(commands).toContainEqual({
            name: 'ark-project',
            description: 'Ark project',
            source: 'project',
            content: 'Project command body',
            pluginName: undefined
        })
    })

    it('lists Codex compact as a built-in command', async () => {
        const commands = await listSlashCommands('codex')

        expect(commands).toContainEqual({
            name: 'compact',
            description: 'Compact conversation context',
            source: 'builtin',
        })
        expect(commands).toContainEqual({
            name: 'goal',
            description: 'Set, view, or clear the conversation goal',
            source: 'builtin',
        })
    })

    it('lists Codex plugin commands from enabled plugin cache entries', async () => {
        await mkdir(join(homeDir, '.codex'), { recursive: true })
        await writeFile(
            join(homeDir, '.codex', 'config.toml'),
            [
                '[plugins."superpowers@openai-curated"]',
                'enabled = true',
                '',
                '[plugins."figma@openai-curated"]',
                'enabled = false',
            ].join('\n')
        )
        await mkdir(
            join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'superpowers', '421657af', 'commands'),
            { recursive: true }
        )
        await writeFile(
            join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'superpowers', '421657af', 'commands', 'plan.md'),
            ['---', 'description: Superpowers planner', '---', '', 'Use planning workflow'].join('\n')
        )
        await mkdir(
            join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'figma', '421657af', 'commands'),
            { recursive: true }
        )
        await writeFile(
            join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'figma', '421657af', 'commands', 'design.md'),
            ['---', 'description: Disabled plugin command', '---', '', 'Should stay hidden'].join('\n')
        )

        const commands = await listSlashCommands('codex')

        expect(commands).toContainEqual({
            name: 'superpowers:plan',
            description: 'Superpowers planner',
            source: 'plugin',
            content: 'Use planning workflow',
            pluginName: 'superpowers',
        })
        expect(commands.find((cmd) => cmd.name === 'figma:design')).toBeUndefined()
    })

    it('does not read Codex plugin command directories that are symlinks outside the plugin installation directory', async () => {
        await mkdir(join(homeDir, '.codex'), { recursive: true })
        await writeFile(join(homeDir, '.codex', 'config.toml'), [
            '[plugins."superpowers@openai-curated"]',
            'enabled = true',
        ].join('\n'))
        const pluginDir = join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'superpowers', '421657af')
        const outsideCommandsDir = join(sandboxDir, 'outside-commands')
        await mkdir(pluginDir, { recursive: true })
        await mkdir(outsideCommandsDir, { recursive: true })
        await writeFile(
            join(outsideCommandsDir, 'plan.md'),
            ['---', 'description: Escaped planner', '---', '', 'Escaped workflow'].join('\n')
        )
        await symlink(outsideCommandsDir, join(pluginDir, 'commands'), 'dir')

        const commands = await listSlashCommands('codex')

        expect(commands.find((cmd) => cmd.name === 'superpowers:plan')).toBeUndefined()
    })

    it('returns empty project commands when project directory does not exist', async () => {
        const nonExistentProjectDir = join(sandboxDir, 'not-exists')

        await expect(listSlashCommands('claude', nonExistentProjectDir)).resolves.toBeDefined()
    })
})
