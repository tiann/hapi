import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { materializeReloadImportPath } from '@hapi/protocol/plugins/runtime/activation'
import { pluginRuntimeCompatibilityProblems, satisfiesVersionRange } from '@hapi/protocol/plugins/runtime/compatibility'
import type { PluginHostInfo, PluginManifestLite } from '@hapi/protocol/plugins'

describe('plugin runtime shared helpers', () => {
    let testDir: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-plugin-runtime-helpers-'))
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('materializes entry-suffix reload imports next to extensionless entries in dotted directories', async () => {
        const entryDir = join(testDir, 'com.example.plugin', 'dist')
        mkdirSync(entryDir, { recursive: true })
        const entryPath = join(entryDir, 'runner')
        writeFileSync(entryPath, 'export function activate() {}')

        const shadowPath = await materializeReloadImportPath({
            realPath: entryPath,
            pluginId: 'com.example.plugin',
            signature: 'sig',
            marker: 'hapi-runner-reload',
            strategy: 'entry-suffix'
        })

        expect(dirname(shadowPath)).toBe(entryDir)
        expect(basename(shadowPath)).toMatch(/^runner\.hapi-runner-reload-com\.example\.plugin-[a-f0-9]{16}\.mjs$/)
    })

    it('materializes entry-suffix reload imports before filename extensions', async () => {
        const entryDir = join(testDir, 'plugin')
        mkdirSync(entryDir, { recursive: true })
        const entryPath = join(entryDir, 'runner.js')
        writeFileSync(entryPath, 'export function activate() {}')

        const shadowPath = await materializeReloadImportPath({
            realPath: entryPath,
            pluginId: 'com.example.plugin',
            signature: 'sig',
            marker: 'hapi-runner-reload',
            strategy: 'entry-suffix'
        })

        expect(dirname(shadowPath)).toBe(entryDir)
        expect(basename(shadowPath)).toMatch(/^runner\.hapi-runner-reload-com\.example\.plugin-[a-f0-9]{16}\.mjs$/)
    })

    it('accepts common semver ranges with spaces after comparators', () => {
        expect(satisfiesVersionRange('0.18.4', '>= 0.18.0 < 0.19.0')).toBe(true)
        expect(satisfiesVersionRange('0.20.0', '>= 0.18.0 < 0.19.0')).toBe(false)
    })

    it('accepts plugin API ranges satisfied by any supported host API version', () => {
        const manifest: PluginManifestLite = {
            id: 'com.example.compat',
            name: 'Compat',
            version: '1.0.0',
            pluginApiVersion: '0.1',
            compatibility: {
                pluginApi: '>=0.1 <0.2'
            }
        }
        const hostInfo: PluginHostInfo = {
            runtime: 'hub',
            hapiVersion: '0.19.0',
            pluginApiVersion: '0.2',
            supportedPluginApiVersions: ['0.1', '0.2'],
            os: 'linux',
            arch: 'x64',
            supportedExtensionPoints: []
        }

        expect(pluginRuntimeCompatibilityProblems(manifest, 'hub', hostInfo)).toEqual([])
    })

    it('enforces global and runtime-specific OS and arch compatibility together', () => {
        const manifest: PluginManifestLite = {
            id: 'com.example.compat',
            name: 'Compat',
            version: '1.0.0',
            pluginApiVersion: '0.1',
            compatibility: {
                os: ['linux'],
                arch: ['x64'],
                runner: {
                    os: ['darwin'],
                    arch: ['arm64']
                }
            }
        }
        const hostInfo: PluginHostInfo = {
            runtime: 'runner',
            hapiVersion: '0.18.4',
            pluginApiVersion: '0.1',
            os: 'linux',
            arch: 'x64',
            supportedExtensionPoints: []
        }

        const problems = pluginRuntimeCompatibilityProblems(manifest, 'runner', hostInfo)

        expect(problems).toEqual(expect.arrayContaining([
            expect.stringContaining('supported OS list: darwin'),
            expect.stringContaining('supported arch list: arm64')
        ]))
        expect(problems).not.toEqual(expect.arrayContaining([
            expect.stringContaining('supported OS list: linux'),
            expect.stringContaining('supported arch list: x64')
        ]))
    })
})
