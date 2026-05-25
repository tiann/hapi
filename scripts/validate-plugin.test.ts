import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseValidatePluginArgs, validatePluginDirectory } from './validate-plugin'

const tempRoots: string[] = []

async function tempDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'hapi-validate-plugin-test-'))
    tempRoots.push(root)
    return root
}

afterEach(async () => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop()
        if (root) await rm(root, { recursive: true, force: true })
    }
})

async function writeManifest(root: string, manifest: Record<string, unknown>): Promise<void> {
    await writeFile(join(root, 'hapi.plugin.json'), `${JSON.stringify(manifest, null, 4)}\n`, 'utf8')
}

describe('validate-plugin script', () => {
    test('parses --json', () => {
        expect(parseValidatePluginArgs(['/tmp/plugin', '--json'])).toEqual({
            pluginDir: '/tmp/plugin',
            json: true
        })
    })

    test('reports missing capability contribution references', async () => {
        const root = await tempDir()
        await writeManifest(root, {
            id: 'com.example.missing-contribution',
            name: 'Missing Contribution',
            version: '0.1.0',
            pluginApiVersion: '0.1',
            capabilities: [{
                id: 'missing-panel',
                kind: 'settings.panel',
                parts: {
                    web: {
                        contributions: [{ type: 'settingsPanel', id: 'missing-panel' }]
                    }
                }
            }],
            contributions: {
                web: {
                    settingsPanels: [{
                        id: 'different-panel',
                        title: 'Different',
                        components: [{ kind: 'text', text: 'Different panel.' }]
                    }]
                }
            },
            compatibility: {
                pluginApi: '>=0.1 <0.2',
                hub: { extensionPoints: ['web.settingsPanel'] }
            }
        })

        const result = await validatePluginDirectory(root)
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'capability-contribution-missing')).toBe(true)
    })

    test('warns about unknown runtime extension points', async () => {
        const root = await tempDir()
        await writeManifest(root, {
            id: 'com.example.unknown-extension',
            name: 'Unknown Extension',
            version: '0.1.0',
            pluginApiVersion: '0.1',
            contributions: {
                web: {
                    settingsPanels: [{
                        id: 'panel',
                        title: 'Panel',
                        components: [{ kind: 'text', text: 'Panel.' }]
                    }]
                }
            },
            compatibility: {
                pluginApi: '>=0.1 <0.2',
                hub: { extensionPoints: ['hub.futurePoint'] }
            }
        })

        const result = await validatePluginDirectory(root)
        expect(result.ok).toBe(true)
        expect(result.warnings).toBe(1)
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown-extension-point' }))
    })

    test('warns about unknown capability contribution types without failing', async () => {
        const root = await tempDir()
        await writeManifest(root, {
            id: 'com.example.future-contribution',
            name: 'Future Contribution',
            version: '0.1.0',
            pluginApiVersion: '0.1',
            capabilities: [{
                id: 'future-capability',
                kind: 'integration.bridge',
                parts: {
                    hub: {
                        contributions: [{ type: 'futureContribution', id: 'future' }]
                    }
                }
            }],
            compatibility: {
                pluginApi: '>=0.1 <0.2'
            }
        })

        const result = await validatePluginDirectory(root)
        expect(result.ok).toBe(true)
        expect(result.warnings).toBe(1)
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown-capability-contribution-type' }))
    })
})
