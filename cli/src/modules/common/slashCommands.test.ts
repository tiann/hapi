import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listSlashCommands } from './slashCommands'

describe('listSlashCommands', () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const originalCodexHome = process.env.CODEX_HOME
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    let sandboxDir: string
    let claudeConfigDir: string
    let codexHome: string
    let xdgConfigHome: string
    let opencodeUserDir: string
    let projectDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-slash-commands-'))
        claudeConfigDir = join(sandboxDir, 'global-claude')
        codexHome = join(sandboxDir, 'global-codex')
        xdgConfigHome = join(sandboxDir, 'xdg-config')
        opencodeUserDir = join(xdgConfigHome, 'opencode', 'command')
        projectDir = join(sandboxDir, 'project')

        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
        process.env.CODEX_HOME = codexHome
        process.env.XDG_CONFIG_HOME = xdgConfigHome

        await mkdir(join(claudeConfigDir, 'commands'), { recursive: true })
        await mkdir(join(codexHome, 'prompts'), { recursive: true })
        await mkdir(opencodeUserDir, { recursive: true })
        await mkdir(join(projectDir, '.claude', 'commands'), { recursive: true })
        await mkdir(join(projectDir, '.codex', 'prompts'), { recursive: true })
        await mkdir(join(projectDir, '.opencode', 'command'), { recursive: true })
    })

    afterEach(async () => {
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
        if (originalXdgConfigHome === undefined) {
            delete process.env.XDG_CONFIG_HOME
        } else {
            process.env.XDG_CONFIG_HOME = originalXdgConfigHome
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

    it('returns empty project commands when project directory does not exist', async () => {
        const nonExistentProjectDir = join(sandboxDir, 'not-exists')

        await expect(listSlashCommands('claude', nonExistentProjectDir)).resolves.toBeDefined()
    })

    it('exposes HAPI-supported Codex built-ins', async () => {
        const commands = await listSlashCommands('codex', projectDir)

        expect(commands.map((command) => command.name)).toEqual(expect.arrayContaining([
            'clear',
            'compact',
            'goal',
            'plan',
            'status',
            'model',
            'reasoning',
            'permissions',
        ]))
    })

    it('lets project codex prompts override same-name built-ins', async () => {
        await writeFile(
            join(projectDir, '.codex', 'prompts', 'clear.md'),
            ['---', 'description: Project clear', '---', '', 'Project clear prompt'].join('\n')
        )

        const commands = await listSlashCommands('codex', projectDir)
        const clearCommands = commands.filter(cmd => cmd.name === 'clear')

        expect(clearCommands).toHaveLength(1)
        expect(clearCommands[0]?.source).toBe('project')
        expect(clearCommands[0]?.description).toBe('Project clear')
        expect(clearCommands[0]?.content).toBe('Project clear prompt')
    })

    it('loads Codex global and project prompts', async () => {
        await writeFile(
            join(codexHome, 'prompts', 'global-prompt.md'),
            ['---', 'description: Global Codex prompt', '---', '', 'Global Codex body'].join('\n')
        )
        await writeFile(
            join(projectDir, '.codex', 'prompts', 'project-prompt.md'),
            ['---', 'description: Project Codex prompt', '---', '', 'Project Codex body'].join('\n')
        )

        const commands = await listSlashCommands('codex', projectDir)

        expect(commands.find(cmd => cmd.name === 'global-prompt')).toMatchObject({
            source: 'user',
            description: 'Global Codex prompt',
            content: 'Global Codex body',
        })
        expect(commands.find(cmd => cmd.name === 'project-prompt')).toMatchObject({
            source: 'project',
            description: 'Project Codex prompt',
            content: 'Project Codex body',
        })
    })

    it('exposes HAPI-supported OpenCode built-ins', async () => {
        const commands = await listSlashCommands('opencode', projectDir)

        const names = commands.map((command) => command.name)
        expect(names).toEqual(expect.arrayContaining([
            'help',
            'status',
            'plan',
            'default',
            'init',
        ]))
        // Anything covered by composer buttons, plus aliases and unsupported
        // placeholders, must stay out of the autocomplete menu — the resolver
        // still accepts them when typed manually.
        for (const hidden of ['model', 'reasoning', 'effort', 'permissions', 'permission', 'clear', 'compact']) {
            expect(names).not.toContain(hidden)
        }
    })

    it('loads OpenCode user and project commands', async () => {
        await writeFile(
            join(opencodeUserDir, 'global-opencode.md'),
            ['---', 'description: Global OpenCode prompt', '---', '', 'Global OpenCode body'].join('\n')
        )
        await writeFile(
            join(projectDir, '.opencode', 'command', 'project-opencode.md'),
            ['---', 'description: Project OpenCode prompt', '---', '', 'Project OpenCode body'].join('\n')
        )

        const commands = await listSlashCommands('opencode', projectDir)

        expect(commands.find(cmd => cmd.name === 'global-opencode')).toMatchObject({
            source: 'user',
            description: 'Global OpenCode prompt',
            content: 'Global OpenCode body',
        })
        expect(commands.find(cmd => cmd.name === 'project-opencode')).toMatchObject({
            source: 'project',
            description: 'Project OpenCode prompt',
            content: 'Project OpenCode body',
        })
    })

    it('exposes only Grok ACP-native built-ins', async () => {
        const commands = await listSlashCommands('grok', projectDir)
        const builtinNames = commands
            .filter((command) => command.source === 'builtin')
            .map((command) => command.name)

        expect(builtinNames).toEqual([
            'compact',
            'context',
            'session-info',
            'goal',
            'always-approve',
            'auto',
        ])
        for (const composerControl of ['model', 'effort', 'plan', 'view-plan']) {
            expect(builtinNames).not.toContain(composerControl)
        }
    })

    it('lets project opencode prompts override same-name built-ins', async () => {
        await writeFile(
            join(projectDir, '.opencode', 'command', 'status.md'),
            ['---', 'description: Project status', '---', '', 'Project status prompt'].join('\n')
        )

        const commands = await listSlashCommands('opencode', projectDir)
        const statusCommands = commands.filter(cmd => cmd.name === 'status')

        expect(statusCommands).toHaveLength(1)
        expect(statusCommands[0]?.source).toBe('project')
        expect(statusCommands[0]?.description).toBe('Project status')
        expect(statusCommands[0]?.content).toBe('Project status prompt')
    })

    it('loads Codex project prompts from cwd up to repo root with nearest override', async () => {
        const repoRoot = join(sandboxDir, 'repo')
        const workingDirectory = join(repoRoot, 'apps', 'web')
        await mkdir(join(repoRoot, '.git'), { recursive: true })
        await mkdir(join(repoRoot, '.codex', 'prompts'), { recursive: true })
        await mkdir(join(workingDirectory, '.codex', 'prompts'), { recursive: true })

        await writeFile(
            join(repoRoot, '.codex', 'prompts', 'shared.md'),
            ['---', 'description: Root prompt', '---', '', 'Root body'].join('\n')
        )
        await writeFile(
            join(workingDirectory, '.codex', 'prompts', 'shared.md'),
            ['---', 'description: Local prompt', '---', '', 'Local body'].join('\n')
        )

        const commands = await listSlashCommands('codex', workingDirectory)
        const sharedCommands = commands.filter(cmd => cmd.name === 'shared')

        expect(sharedCommands).toHaveLength(1)
        expect(sharedCommands[0]).toMatchObject({
            source: 'project',
            description: 'Local prompt',
            content: 'Local body',
        })
    })
})
