import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMentions } from './mentions'

async function writePluginConfig(homeDir: string, lines: string[]): Promise<void> {
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(join(homeDir, '.codex', 'config.toml'), lines.join('\n'))
}

async function writePluginManifest(
    homeDir: string,
    marketplace: string,
    pluginName: string,
    version: string,
    description: string,
    appEntries?: Record<string, { id: string }>,
    options: { appsPath?: string } = {}
): Promise<void> {
    const pluginDir = join(homeDir, '.codex', 'plugins', 'cache', marketplace, pluginName, version)
    await mkdir(join(pluginDir, '.codex-plugin'), { recursive: true })
    const manifest = {
        name: pluginName,
        description,
        apps: appEntries ? options.appsPath ?? './.app.json' : undefined,
    }
    await writeFile(join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2))
    if (appEntries && !options.appsPath) {
        await writeFile(join(pluginDir, '.app.json'), JSON.stringify({ apps: appEntries }, null, 2))
    }
}

describe('listMentions', () => {
    const originalHome = process.env.HOME
    const originalCodexHome = process.env.CODEX_HOME
    let sandboxDir: string
    let homeDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-mentions-'))
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

    it('lists enabled Codex plugin mentions and emits explicit app mentions when app metadata exists', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
            '',
            '[plugins."superpowers@openai-curated"]',
            'enabled = true',
            '',
            '[plugins."gmail@openai-curated"]',
            'enabled = false',
        ])
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '421657af',
            'GitHub workflow plugin',
            { github: { id: 'connector_github_123' } }
        )
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'superpowers',
            '421657af',
            'Superpowers plugin'
        )
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'gmail',
            '421657af',
            'Disabled Gmail plugin',
            { gmail: { id: 'connector_gmail_456' } }
        )

        const mentions = await listMentions({ agent: 'codex' })

        expect(mentions).toContainEqual({
            name: 'github',
            label: '@github',
            insertText: '[$github](app://connector_github_123)',
            description: 'GitHub workflow plugin',
            kind: 'app',
            pluginName: 'github',
        })
        expect(mentions).toContainEqual({
            name: 'superpowers',
            label: '@superpowers',
            insertText: '@superpowers',
            description: 'Superpowers plugin',
            kind: 'plugin',
            pluginName: 'superpowers',
        })
        expect(mentions.find((mention) => mention.name === 'gmail')).toBeUndefined()
    })



    it('ignores plugin keys that would resolve outside the Codex plugin cache', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."../../evil@openai-curated"]',
            'enabled = true',
        ])
        await mkdir(join(homeDir, '.codex', 'plugins', 'evil', '1.0.0', '.codex-plugin'), { recursive: true })
        await writeFile(
            join(homeDir, '.codex', 'plugins', 'evil', '1.0.0', '.codex-plugin', 'plugin.json'),
            JSON.stringify({ name: 'evil', description: 'Escaped plugin' }, null, 2)
        )

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([])
    })

    it('does not read app manifests outside the plugin installation directory', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '1.0.0',
            'GitHub workflow plugin',
            { github: { id: 'connector_github_123' } },
            { appsPath: '../outside-apps.json' }
        )
        await writeFile(join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'github', 'outside-apps.json'), JSON.stringify({
            apps: { leaked: { id: 'connector_leaked' } }
        }))

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([{
            name: 'github',
            label: '@github',
            insertText: '@github',
            description: 'GitHub workflow plugin',
            kind: 'plugin',
            pluginName: 'github',
        }])
    })

    it('chooses the latest cached plugin version deterministically by version-like directory name', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '1.0.0',
            'Old GitHub plugin',
            { github: { id: 'connector_old' } }
        )
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '2.0.0',
            'New GitHub plugin',
            { github: { id: 'connector_new' } }
        )

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([{
            name: 'github',
            label: '@github',
            insertText: '[$github](app://connector_new)',
            description: 'New GitHub plugin',
            kind: 'app',
            pluginName: 'github',
        }])
    })



    it('uses an in-cache latest symlink before version-name fallback', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '1.0.0',
            'Latest-linked GitHub plugin',
            { github: { id: 'connector_latest' } }
        )
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '2.0.0',
            'Higher-version GitHub plugin',
            { github: { id: 'connector_newer' } }
        )
        await symlink('1.0.0', join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'github', 'latest'), 'dir')

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([{
            name: 'github',
            label: '@github',
            insertText: '[$github](app://connector_latest)',
            description: 'Latest-linked GitHub plugin',
            kind: 'app',
            pluginName: 'github',
        }])
    })

    it('ignores latest symlinks that resolve outside the plugin root', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        const outsidePlugin = join(sandboxDir, 'outside-plugin')
        await mkdir(join(outsidePlugin, '.codex-plugin'), { recursive: true })
        await writeFile(join(outsidePlugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
            name: 'github',
            description: 'Escaped GitHub plugin'
        }, null, 2))
        await mkdir(join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'github'), { recursive: true })
        await symlink(outsidePlugin, join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'github', 'latest'), 'dir')

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([])
    })

    it('ignores version-directory symlinks that resolve outside the plugin root', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '1.0.0',
            'Safe GitHub plugin',
            { github: { id: 'connector_safe' } }
        )
        const outsidePlugin = join(sandboxDir, 'outside-plugin-version')
        await mkdir(join(outsidePlugin, '.codex-plugin'), { recursive: true })
        await writeFile(join(outsidePlugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
            name: 'github',
            description: 'Escaped GitHub plugin'
        }, null, 2))
        await symlink(outsidePlugin, join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'github', '2.0.0'), 'dir')

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([{
            name: 'github',
            label: '@github',
            insertText: '[$github](app://connector_safe)',
            description: 'Safe GitHub plugin',
            kind: 'app',
            pluginName: 'github',
        }])
    })

    it('does not read plugin manifests that are symlinks outside the plugin installation directory', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        const pluginJson = join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'github', '1.0.0', '.codex-plugin', 'plugin.json')
        const outsidePluginJson = join(sandboxDir, 'outside-plugin.json')
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '1.0.0',
            'Safe GitHub plugin'
        )
        await rm(pluginJson)
        await writeFile(outsidePluginJson, JSON.stringify({
            name: 'github',
            description: 'Escaped GitHub plugin',
            apps: './.app.json'
        }, null, 2))
        await symlink(outsidePluginJson, pluginJson)

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([{
            name: 'github',
            label: '@github',
            insertText: '@github',
            description: undefined,
            kind: 'plugin',
            pluginName: 'github',
        }])
    })

    it('does not read app manifests that are symlinks outside the plugin installation directory', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '1.0.0',
            'GitHub workflow plugin',
            { github: { id: 'connector_github_123' } },
            { appsPath: './.app.json' }
        )
        const outsideApps = join(sandboxDir, 'outside-apps.json')
        await writeFile(outsideApps, JSON.stringify({ apps: { leaked: { id: 'connector_leaked' } } }))
        await symlink(outsideApps, join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'github', '1.0.0', '.app.json'))

        await expect(listMentions({ agent: 'codex' })).resolves.toEqual([{
            name: 'github',
            label: '@github',
            insertText: '@github',
            description: 'GitHub workflow plugin',
            kind: 'plugin',
            pluginName: 'github',
        }])
    })

    it('returns no Codex mentions for non-Codex agents', async () => {
        await writePluginConfig(homeDir, [
            '[plugins."github@openai-curated"]',
            'enabled = true',
        ])
        await writePluginManifest(
            homeDir,
            'openai-curated',
            'github',
            '421657af',
            'GitHub workflow plugin',
            { github: { id: 'connector_github_123' } }
        )

        await expect(listMentions({ agent: 'claude' })).resolves.toEqual([])
    })
})
