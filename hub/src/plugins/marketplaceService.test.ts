import { describe, expect, it } from 'bun:test'
import { PluginMarketplaceService, type MarketplaceFetch } from './marketplaceService'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { embeddedPluginMarketplaceCatalog } from '@hapi/protocol/plugins/marketplaceSources.generated'
import type { PluginHostInfo } from '@hapi/protocol/plugins/admin'
import { PluginMarketplaceCatalogSchema, type PluginMarketplaceEntry } from '@hapi/protocol/plugins/marketplace'
import { createPluginMarketplaceHostContext } from '@hapi/protocol/plugins/runtime/versioning'

function catalogResponse(): Awaited<ReturnType<MarketplaceFetch>> {
    return jsonResponse({
        schemaVersion: 'hapi-plugin-marketplace/v1',
        updatedAt: '2026-05-24T00:00:00.000Z',
        plugins: []
    })
}

function jsonResponse(value: unknown): Awaited<ReturnType<MarketplaceFetch>> {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
            return JSON.stringify(value)
        }
    }
}

function packageCatalog(url: string, extraPackageMetadata: Record<string, unknown> = {}): unknown {
    return {
        schemaVersion: 'hapi-plugin-marketplace/v1',
        updatedAt: '2026-05-24T00:00:00.000Z',
        plugins: [{
            id: 'com.example.package',
            name: 'Package Plugin',
            repo: 'example/package-plugin',
            releases: [{
                version: '1.0.0',
                tag: 'v1.0.0',
                manifest: {
                    id: 'com.example.package',
                    name: 'Package Plugin',
                    version: '1.0.0',
                    pluginApiVersion: '0.1'
                },
                package: {
                    filename: 'plugin.tgz',
                    url,
                    format: 'tgz',
                    checksum: `sha256:${'a'.repeat(64)}`,
                    ...extraPackageMetadata
                }
            }]
        }]
    }
}

describe('PluginMarketplaceService', () => {
    it('rejects non-http marketplace display links', () => {
        const homepageCatalog = packageCatalog('https://example.com/plugin.tgz') as { plugins: Array<Record<string, unknown>> }
        homepageCatalog.plugins[0]!.homepage = 'javascript:alert(1)'
        expect(PluginMarketplaceCatalogSchema.safeParse(homepageCatalog).success).toBe(false)

        const malformedCatalog = packageCatalog('https://example.com/plugin.tgz') as { plugins: Array<Record<string, unknown>> }
        malformedCatalog.plugins[0]!.homepage = 'not a url'
        expect(() => PluginMarketplaceCatalogSchema.safeParse(malformedCatalog)).not.toThrow()
        expect(PluginMarketplaceCatalogSchema.safeParse(malformedCatalog).success).toBe(false)

        const authorCatalog = packageCatalog('https://example.com/plugin.tgz') as { plugins: Array<Record<string, unknown>> }
        authorCatalog.plugins[0]!.author = { name: 'Example', url: 'data:text/html,evil' }
        expect(PluginMarketplaceCatalogSchema.safeParse(authorCatalog).success).toBe(false)
    })

    it('rejects release metadata with duplicate versions or manifest version mismatches', () => {
        const release = (version: string, manifestVersion = version) => ({
            version,
            tag: `v${version}`,
            manifest: {
                id: 'com.example.package',
                name: 'Package Plugin',
                version: manifestVersion,
                pluginApiVersion: '0.1'
            },
            package: {
                filename: 'plugin.tgz',
                url: `https://github.com/example/package-plugin/releases/download/v${version}/plugin.tgz`,
                format: 'tgz',
                checksum: `sha256:${'a'.repeat(64)}`
            }
        })
        const baseCatalog = {
            schemaVersion: 'hapi-plugin-marketplace/v1',
            updatedAt: '2026-05-24T00:00:00.000Z',
            plugins: [{
                id: 'com.example.package',
                name: 'Package Plugin',
                repo: 'example/package-plugin',
                releases: [release('1.0.0')]
            }]
        }

        expect(PluginMarketplaceCatalogSchema.safeParse({
            ...baseCatalog,
            plugins: [{ ...baseCatalog.plugins[0], releases: [release('1.0.0', '2.0.0')] }]
        }).success).toBe(false)
        expect(PluginMarketplaceCatalogSchema.safeParse({
            ...baseCatalog,
            plugins: [{ ...baseCatalog.plugins[0], releases: [release('1.0.0'), release('1.0.0')] }]
        }).success).toBe(false)
    })

    it('selects the latest non-yanked host-compatible release', () => {
        const entry: PluginMarketplaceEntry = {
            id: 'com.example.package',
            name: 'Package Plugin',
            repo: 'example/package-plugin',
            releases: ['1.0.0', '1.1.0', '1.2.0'].map((version) => ({
                version,
                tag: `v${version}`,
                manifest: {
                    id: 'com.example.package',
                    name: 'Package Plugin',
                    version,
                    pluginApiVersion: '0.1',
                    runtimes: { hub: { entry: 'hub.js' } },
                    ...(version === '1.2.0' ? { compatibility: { hub: { extensionPoints: ['hub.futureAction'] } } } : {})
                },
                package: {
                    filename: 'plugin.tgz',
                    url: `https://github.com/example/package-plugin/releases/download/v${version}/plugin.tgz`,
                    format: 'tgz',
                    checksum: `sha256:${'a'.repeat(64)}`
                },
                ...(version === '1.1.0' ? { yanked: { reason: 'bad release' } } : {})
            }))
        }
        const hostInfo: PluginHostInfo = {
            runtime: 'hub',
            hapiVersion: '0.18.4',
            pluginApiVersion: '0.1',
            supportedPluginApiVersions: ['0.1'],
            os: 'linux',
            arch: 'x64',
            supportedExtensionPoints: ['hub.messageAction']
        }

        expect(new PluginMarketplaceService().selectRelease(entry, undefined, createPluginMarketplaceHostContext([hostInfo])).version).toBe('1.0.0')
    })

    it('selects runner releases without compatibility constraints when Runner hostInfo is missing', () => {
        const entry: PluginMarketplaceEntry = {
            id: 'com.example.runner',
            name: 'Runner Plugin',
            repo: 'example/runner-plugin',
            releases: [{
                version: '1.0.0',
                tag: 'v1.0.0',
                manifest: {
                    id: 'com.example.runner',
                    name: 'Runner Plugin',
                    version: '1.0.0',
                    pluginApiVersion: '0.1',
                    runtimes: { runner: { entry: 'runner.js' } }
                },
                package: {
                    filename: 'plugin.tgz',
                    url: 'https://github.com/example/runner-plugin/releases/download/v1.0.0/plugin.tgz',
                    format: 'tgz',
                    checksum: `sha256:${'a'.repeat(64)}`
                }
            }]
        }

        expect(new PluginMarketplaceService().selectRelease(entry, undefined, createPluginMarketplaceHostContext([{ runtime: 'runner' }])).version).toBe('1.0.0')
    })

    it('loads catalogs that include future unsupported API releases and still selects an older compatible release', async () => {
        const testDir = mkdtempSync(join(tmpdir(), 'hapi-marketplace-future-api-'))
        const catalogPath = join(testDir, 'catalog.v1.json')
        writeFileSync(catalogPath, JSON.stringify({
            schemaVersion: 'hapi-plugin-marketplace/v1',
            updatedAt: '2026-05-24T00:00:00.000Z',
            plugins: [{
                id: 'com.example.future',
                name: 'Future Plugin',
                repo: 'example/future-plugin',
                releases: ['1.0.0', '2.0.0'].map((version) => ({
                    version,
                    tag: `v${version}`,
                    manifest: {
                        id: 'com.example.future',
                        name: 'Future Plugin',
                        version,
                        pluginApiVersion: version === '2.0.0' ? '0.2' : '0.1',
                        runtimes: { hub: { entry: 'hub.js' } },
                        ...(version === '2.0.0' ? { futureRequiredField: { newShape: true } } : {})
                    },
                    package: {
                        filename: 'plugin.tgz',
                        url: `https://github.com/example/future-plugin/releases/download/v${version}/plugin.tgz`,
                        format: 'tgz',
                        checksum: `sha256:${'a'.repeat(64)}`
                    }
                }))
            }]
        }))
        const service = new PluginMarketplaceService({ sourceUrl: catalogPath, allowLocalSources: true })
        try {
            const { entry } = await service.getEntry('com.example.future')

            expect(service.selectRelease(entry, undefined, createPluginMarketplaceHostContext([{
                runtime: 'hub',
                hapiVersion: '0.18.4',
                pluginApiVersion: '0.1',
                supportedPluginApiVersions: ['0.1'],
                os: 'linux',
                arch: 'x64',
                supportedExtensionPoints: []
            }])).version).toBe('1.0.0')
        } finally {
            rmSync(testDir, { recursive: true, force: true })
        }
    })

    it('cache-busts forced catalog refreshes without changing the public source URL', async () => {
        const calls: string[] = []
        let now = 1000
        const service = new PluginMarketplaceService({
            sourceUrl: 'https://example.com/catalog.v1.json?branch=main',
            now: () => now,
            fetch: async (url) => {
                calls.push(url)
                return catalogResponse()
            }
        })

        const first = await service.getCatalog()
        const cached = await service.getCatalog()
        now = 2000
        const refreshed = await service.getCatalog({ force: true })

        expect(cached).toBe(first)
        expect(refreshed.sourceUrl).toBe('https://example.com/catalog.v1.json?branch=main')
        expect(calls).toEqual([
            'https://example.com/catalog.v1.json?branch=main',
            'https://example.com/catalog.v1.json?branch=main&_hapiCacheBust=2000'
        ])
    })

    it('builds install-plan package requests from embedded HAPI source plugins', async () => {
        const service = new PluginMarketplaceService({ now: () => 3000 })

        const snapshot = await service.getCatalog()
        const entry = snapshot.catalog.plugins.find((plugin) => plugin.id === 'com.hapi.schedule-send')
        expect(snapshot.sourceUrl).toBe('embedded://hapi-marketplace/catalog.v1.json')
        expect(entry?.releases[0]?.source?.path).toBe('plugins/com.hapi.schedule-send')

        const result = await service.buildInstallPlanRequest('com.hapi.schedule-send', { enable: true })

        expect(result.marketplace).toMatchObject({
            distribution: 'hapi-source',
            sourcePath: 'plugins/com.hapi.schedule-send',
            pluginId: 'com.hapi.schedule-send',
            version: '0.1.1'
        })
        expect(result.request).toMatchObject({
            filename: 'com.hapi.schedule-send-0.1.1.hapi-source.tgz',
            format: 'tgz',
            enable: true,
            installSource: {
                type: 'marketplace',
                distribution: 'hapi-source',
                sourcePath: 'plugins/com.hapi.schedule-send'
            }
        })
        expect(result.request.contentBase64.length).toBeGreaterThan(0)
        expect(result.request.checksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    })

    it('rejects source catalog entries whose embedded source checksum does not match', async () => {
        const testDir = mkdtempSync(join(tmpdir(), 'hapi-marketplace-source-test-'))
        const catalog = structuredClone(embeddedPluginMarketplaceCatalog)
        const entry = catalog.plugins.find((plugin) => plugin.id === 'com.hapi.schedule-send')!
        entry.releases[0]!.source!.treeChecksum = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
        const catalogPath = join(testDir, 'catalog.v1.json')
        writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))

        const service = new PluginMarketplaceService({
            sourceUrl: catalogPath,
            sourceRoot: join(testDir, 'missing-checkout'),
            allowLocalSources: true
        })

        await expect(service.buildInstallPlanRequest('com.hapi.schedule-send')).rejects.toThrow('source checksum mismatch')
    })

    it('rejects untrusted local and insecure remote catalogs by default', async () => {
        const testDir = mkdtempSync(join(tmpdir(), 'hapi-marketplace-policy-'))
        const catalogPath = join(testDir, 'catalog.v1.json')
        writeFileSync(catalogPath, JSON.stringify({
            schemaVersion: 'hapi-plugin-marketplace/v1',
            updatedAt: '2026-05-24T00:00:00.000Z',
            plugins: []
        }))
        try {
            await expect(new PluginMarketplaceService({ sourceUrl: catalogPath }).getCatalog()).rejects.toThrow('local catalogs are disabled')
            await expect(new PluginMarketplaceService({
                sourceUrl: 'http://example.com/catalog.v1.json',
                fetch: async () => catalogResponse()
            }).getCatalog()).rejects.toThrow('must use HTTPS')
        } finally {
            rmSync(testDir, { recursive: true, force: true })
        }
    })

    it('rejects untrusted local and insecure marketplace packages by default', async () => {
        const catalogForPackage = (url: string) => ({
            schemaVersion: 'hapi-plugin-marketplace/v1',
            updatedAt: '2026-05-24T00:00:00.000Z',
            plugins: [{
                id: 'com.example.package-policy',
                name: 'Package Policy Plugin',
                repo: 'example/package-policy',
                releases: [{
                    version: '0.1.0',
                    tag: 'v0.1.0',
                    manifest: {
                        id: 'com.example.package-policy',
                        name: 'Package Policy Plugin',
                        version: '0.1.0',
                        pluginApiVersion: '0.1'
                    },
                    package: {
                        filename: 'plugin.tgz',
                        url,
                        format: 'tgz',
                        checksum: `sha256:${'a'.repeat(64)}`
                    }
                }]
            }]
        })
        const serviceForPackage = (url: string) => new PluginMarketplaceService({
            sourceUrl: 'https://example.com/catalog.v1.json',
            fetch: async () => jsonResponse(catalogForPackage(url))
        })

        await expect(serviceForPackage(pathToFileURL('/tmp/plugin.tgz').toString()).buildInstallPlanRequest('com.example.package-policy')).rejects.toThrow('file packages are disabled')
        await expect(serviceForPackage('ftp://example.com/plugin.tgz').buildInstallPlanRequest('com.example.package-policy')).rejects.toThrow('local packages are disabled')
        await expect(serviceForPackage('http://example.com/plugin.tgz').buildInstallPlanRequest('com.example.package-policy')).rejects.toThrow('must use HTTPS')
    })

    it('rejects oversized remote marketplace packages from content-length before buffering', async () => {
        const service = new PluginMarketplaceService({
            sourceUrl: 'https://example.com/catalog.v1.json',
            maxPackageBytes: 1,
            fetch: async (url) => {
                if (url.endsWith('/catalog.v1.json')) {
                    return jsonResponse(packageCatalog('https://example.com/plugin.tgz'))
                }
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '2' : null },
                    body: null,
                    async text() {
                        return ''
                    }
                }
            }
        })

        await expect(service.buildInstallPlanRequest('com.example.package')).rejects.toThrow('Plugin package is too large.')
    })

    it('rejects remote marketplace package responses without a readable stream', async () => {
        const service = new PluginMarketplaceService({
            sourceUrl: 'https://example.com/catalog.v1.json',
            maxPackageBytes: 25,
            fetch: async (url) => {
                if (url.endsWith('/catalog.v1.json')) {
                    return jsonResponse(packageCatalog('https://example.com/plugin.tgz'))
                }
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => null },
                    body: null,
                    async text() {
                        return ''
                    }
                }
            }
        })

        await expect(service.buildInstallPlanRequest('com.example.package')).rejects.toThrow('did not provide a readable stream')
    })

    it('aborts oversized streamed marketplace downloads once the quota is exceeded', async () => {
        let reads = 0
        const service = new PluginMarketplaceService({
            sourceUrl: 'https://example.com/catalog.v1.json',
            maxPackageBytes: 1,
            fetch: async (url) => {
                if (url.endsWith('/catalog.v1.json')) {
                    return jsonResponse(packageCatalog('https://example.com/plugin.tgz'))
                }
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => null },
                    body: {
                        getReader: () => ({
                            async read() {
                                reads += 1
                                if (reads === 1) return { done: false, value: new Uint8Array([1]) }
                                return { done: false, value: new Uint8Array([2]) }
                            },
                            releaseLock() {}
                        })
                    },
                    async text() {
                        return ''
                    }
                }
            }
        })

        await expect(service.buildInstallPlanRequest('com.example.package')).rejects.toThrow('Plugin package is too large.')
        expect(reads).toBe(2)
    })

    it('rejects remote source catalogs without a trusted source root or embedded source metadata', async () => {
        const service = new PluginMarketplaceService({
            sourceUrl: 'https://example.com/catalog.v1.json',
            fetch: async () => jsonResponse({
                schemaVersion: 'hapi-plugin-marketplace/v1',
                updatedAt: '2026-05-24T00:00:00.000Z',
                plugins: [{
                    id: 'com.example.source-policy',
                    name: 'Source Policy Plugin',
                    repo: 'example/source-policy',
                    releases: [{
                        version: '0.1.0',
                        tag: 'hapi-source-com.example.source-policy-v0.1.0',
                        manifest: {
                            id: 'com.example.source-policy',
                            name: 'Source Policy Plugin',
                            version: '0.1.0',
                            pluginApiVersion: '0.1'
                        },
                        source: {
                            type: 'hapi-source',
                            path: 'plugins/com.example.source-policy'
                        }
                    }]
                }]
            })
        })

        await expect(service.buildInstallPlanRequest('com.example.source-policy')).rejects.toThrow('require HAPI_PLUGIN_MARKETPLACE_SOURCE_ROOT')
    })
})
