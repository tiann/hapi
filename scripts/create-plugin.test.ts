import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPlugin, parseCreatePluginArgs, type PluginTemplateName } from './create-plugin'
import { validatePluginDirectory } from './validate-plugin'

const repoRoot = join(import.meta.dir, '..')
const tempRoots: string[] = []
const repoPluginDirs: string[] = []

async function tempDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'hapi-create-plugin-test-'))
    tempRoots.push(root)
    return root
}

afterEach(async () => {
    while (repoPluginDirs.length > 0) {
        const dir = repoPluginDirs.pop()
        if (dir) await rm(dir, { recursive: true, force: true })
    }
    while (tempRoots.length > 0) {
        const root = tempRoots.pop()
        if (root) await rm(root, { recursive: true, force: true })
    }
})

describe('create-plugin script', () => {
    test('parses create args with default directory', () => {
        const parsed = parseCreatePluginArgs(['com.example.demo', '--template', 'hub-notification'], '/repo')
        expect(parsed).toEqual({
            pluginId: 'com.example.demo',
            template: 'hub-notification',
            dir: '/repo/plugins/com.example.demo',
            force: false
        })
    })

    test('creates valid scaffold for each supported template', async () => {
        const templates: PluginTemplateName[] = ['hub-notification', 'runner-env', 'web-descriptor']
        for (const template of templates) {
            const root = await tempDir()
            const dir = join(root, `com.example.${template}`)
            const result = await createPlugin({
                pluginId: `com.example.${template}`,
                template,
                dir,
                name: `Example ${template}`,
                force: false
            })

            expect(result.files).toContain('hapi.plugin.json')
            expect(existsSync(join(dir, 'hapi.plugin.json'))).toBe(true)
            expect(existsSync(join(dir, 'hapi.marketplace.json'))).toBe(false)

            const validation = await validatePluginDirectory(dir)
            expect(validation.ok).toBe(true)
            expect(validation.errors).toBe(0)
        }
    })

    test('creates marketplace metadata for direct first-party plugin scaffolds', async () => {
        const pluginId = 'com.example.create-plugin-test'
        const dir = join(repoRoot, 'plugins', pluginId)
        repoPluginDirs.push(dir)
        await rm(dir, { recursive: true, force: true })

        const result = await createPlugin({
            pluginId,
            template: 'web-descriptor',
            dir,
            force: false
        })

        expect(result.files).toContain('hapi.marketplace.json')
        expect(existsSync(join(dir, 'hapi.marketplace.json'))).toBe(true)
        const validation = await validatePluginDirectory(dir)
        expect(validation.ok).toBe(true)
    })

    test('rejects nested first-party plugin scaffold paths', async () => {
        const dir = join(repoRoot, 'plugins', 'nested', 'com.example.bad-nested')
        repoPluginDirs.push(join(repoRoot, 'plugins', 'nested'))

        await expect(createPlugin({
            pluginId: 'com.example.bad-nested',
            template: 'web-descriptor',
            dir,
            force: false
        })).rejects.toThrow('direct children of plugins')
    })

    test('refuses to replace an existing directory unless forced', async () => {
        const root = await tempDir()
        const dir = join(root, 'com.example.exists')
        await createPlugin({
            pluginId: 'com.example.exists',
            template: 'web-descriptor',
            dir,
            force: false
        })

        await expect(createPlugin({
            pluginId: 'com.example.exists',
            template: 'web-descriptor',
            dir,
            force: false
        })).rejects.toThrow('already exists')

        const replaced = await createPlugin({
            pluginId: 'com.example.exists',
            template: 'hub-notification',
            dir,
            force: true
        })
        expect(replaced.files).toContain('src/hub.js')
    })

    test('refuses to force replace non-plugin directories', async () => {
        const root = await tempDir()
        const dir = join(root, 'not-a-plugin')
        await mkdir(dir)
        await writeFile(join(dir, 'important.txt'), 'keep me', 'utf8')

        await expect(createPlugin({
            pluginId: 'com.example.not-a-plugin',
            template: 'web-descriptor',
            dir,
            force: true
        })).rejects.toThrow('only replaces empty directories or existing plugin directories')
    })
})
