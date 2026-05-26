import { describe, expect, it } from 'bun:test'
import type { PluginHostInfo } from '../admin'
import type { PluginMarketplaceEntry } from '../marketplace'
import { comparePluginVersions, createPluginMarketplaceHostContext, latestCompatibleMarketplaceRelease, parsePluginSemver } from './versioning'

const hubHost: PluginHostInfo = {
    runtime: 'hub',
    hapiVersion: '0.18.4',
    pluginApiVersion: '0.1',
    supportedPluginApiVersions: ['0.1'],
    os: 'linux',
    arch: 'x64',
    supportedExtensionPoints: ['hub.messageAction']
}

function marketplaceEntry(versions: Array<{ version: string; yanked?: boolean; requiredExtensionPoint?: string }>): PluginMarketplaceEntry {
    return {
        id: 'com.example.market',
        name: 'Market',
        repo: 'owner/repo',
        releases: versions.map((release) => ({
            version: release.version,
            tag: `v${release.version}`,
            manifest: {
                id: 'com.example.market',
                name: 'Market',
                version: release.version,
                pluginApiVersion: '0.1',
                runtimes: { hub: { entry: 'hub.js' } },
                ...(release.requiredExtensionPoint ? {
                    compatibility: {
                        hub: { extensionPoints: [release.requiredExtensionPoint] }
                    }
                } : {})
            },
            package: {
                filename: 'plugin.tgz',
                url: `https://github.com/owner/repo/releases/download/v${release.version}/plugin.tgz`,
                format: 'tgz',
                checksum: `sha256:${'a'.repeat(64)}`
            },
            ...(release.yanked ? { yanked: { reason: 'bad release' } } : {})
        }))
    }
}

describe('plugin versioning helpers', () => {
    it('parses full SemVer and rejects invalid prerelease numeric identifiers', () => {
        expect(parsePluginSemver('1.2.3-beta.1+build.5')).toMatchObject({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: ['beta', '1'],
            build: 'build.5'
        })
        expect(parsePluginSemver('1.0.0-01')).toBeNull()
    })

    it('orders SemVer prereleases before their stable release and ignores build metadata precedence', () => {
        expect(comparePluginVersions('1.0.0-beta.1', '1.0.0-beta.2')).toBeLessThan(0)
        expect(comparePluginVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
        expect(comparePluginVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0)
    })

    it('selects latest non-yanked release compatible with current host APIs and extension points', () => {
        const entry = marketplaceEntry([
            { version: '1.0.0' },
            { version: '1.1.0', yanked: true },
            { version: '1.2.0', requiredExtensionPoint: 'hub.futureAction' }
        ])

        expect(latestCompatibleMarketplaceRelease(entry, createPluginMarketplaceHostContext([hubHost]))?.version).toBe('1.0.0')
    })

    it('does not reject runner-only releases without compatibility constraints when Runner hostInfo is missing', () => {
        const entry: PluginMarketplaceEntry = {
            id: 'com.example.runner',
            name: 'Runner',
            repo: 'owner/runner',
            releases: [{
                version: '1.0.0',
                tag: 'v1.0.0',
                manifest: {
                    id: 'com.example.runner',
                    name: 'Runner',
                    version: '1.0.0',
                    pluginApiVersion: '0.1',
                    runtimes: { runner: { entry: 'runner.js' } }
                },
                package: {
                    filename: 'plugin.tgz',
                    url: 'https://github.com/owner/runner/releases/download/v1.0.0/plugin.tgz',
                    format: 'tgz',
                    checksum: `sha256:${'a'.repeat(64)}`
                }
            }]
        }

        expect(latestCompatibleMarketplaceRelease(entry, createPluginMarketplaceHostContext([{ runtime: 'runner' }]))?.version).toBe('1.0.0')
    })

    it('skips future unsupported plugin API releases instead of making the whole entry unusable', () => {
        const entry: PluginMarketplaceEntry = {
            id: 'com.example.future',
            name: 'Future',
            repo: 'owner/future',
            releases: ['1.0.0', '2.0.0'].map((version) => ({
                version,
                tag: `v${version}`,
                manifest: {
                    id: 'com.example.future',
                    name: 'Future',
                    version,
                    pluginApiVersion: version === '2.0.0' ? '0.2' : '0.1',
                    runtimes: { hub: { entry: 'hub.js' } }
                },
                package: {
                    filename: 'plugin.tgz',
                    url: `https://github.com/owner/future/releases/download/v${version}/plugin.tgz`,
                    format: 'tgz',
                    checksum: `sha256:${'a'.repeat(64)}`
                }
            }))
        }

        expect(latestCompatibleMarketplaceRelease(entry, createPluginMarketplaceHostContext([hubHost]))?.version).toBe('1.0.0')
    })
})
