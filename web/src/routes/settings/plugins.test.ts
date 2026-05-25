import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginListItem } from '@hapi/protocol/plugins/admin'
import type { PluginMarketplaceEntryView } from '@hapi/protocol/plugins/marketplace'
import {
    DEFAULT_PLUGIN_SETTINGS_TAB,
    MarketplaceDetailPanel,
    MarketplacePluginCard,
    createMarketplaceInstallPlanKey,
    groupPluginListForDisplay,
    marketplaceHasLocalNewerVersion,
    preferredPluginDetailTarget
} from './plugins'

function plugin(overrides: Partial<PluginListItem> & Pick<PluginListItem, 'id'>): PluginListItem {
    return {
        id: overrides.id,
        name: overrides.name ?? overrides.id,
        version: overrides.version ?? '0.1.0',
        description: overrides.description,
        source: overrides.source ?? 'bundled',
        status: overrides.status ?? 'disabled',
        enabled: overrides.enabled ?? false,
        active: overrides.active ?? false,
        rootPath: overrides.rootPath ?? `/plugins/${overrides.id}`,
        manifestPath: overrides.manifestPath ?? `/plugins/${overrides.id}/hapi.plugin.json`,
        runtimes: overrides.runtimes ?? {},
        diagnostics: overrides.diagnostics ?? [],
        target: overrides.target,
        configScope: overrides.configScope,
        updatedAt: overrides.updatedAt,
        install: overrides.install
    }
}

function marketplaceEntry(overrides: Partial<PluginMarketplaceEntryView> = {}): PluginMarketplaceEntryView {
    const id = overrides.id ?? 'com.example.market'
    return {
        id,
        name: overrides.name ?? 'Marketplace Plugin',
        description: overrides.description ?? 'Marketplace description',
        repo: overrides.repo ?? 'owner/repo',
        categories: overrides.categories ?? ['utility'],
        runtimes: overrides.runtimes ?? ['hub'],
        releases: overrides.releases ?? [{
            version: '0.1.0',
            tag: 'v0.1.0',
            manifest: {
                id,
                name: 'Marketplace Plugin',
                version: '0.1.0',
                pluginApiVersion: '0.1'
            },
            package: {
                filename: 'plugin.tgz',
                url: 'https://example.com/plugin.tgz',
                format: 'tgz',
                checksum: `sha256:${'a'.repeat(64)}`
            }
        }],
        latestCompatibleVersion: overrides.latestCompatibleVersion ?? overrides.releases?.[0]?.version ?? '0.1.0',
        installed: overrides.installed,
        display: overrides.display,
        homepage: overrides.homepage,
        author: overrides.author,
        license: overrides.license,
        keywords: overrides.keywords,
        capabilities: overrides.capabilities
    }
}

const t = (key: string, params?: Record<string, string | number>): string => {
    if (!params) return key
    return Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), key)
}

afterEach(() => cleanup())

describe('groupPluginListForDisplay', () => {
    it('defaults the settings page to installed plugins', () => {
        expect(DEFAULT_PLUGIN_SETTINGS_TAB).toBe('installed')
    })

    it('collapses the Hub descriptor mirror and Runner runtime row into one plugin group', () => {
        const groups = groupPluginListForDisplay([
            plugin({
                id: 'com.example.cross-runner',
                target: { scope: 'hub', runtime: 'hub', active: true, stale: false },
                runtimes: { runner: { entry: 'dist/runner.js', active: false } }
            }),
            plugin({
                id: 'com.example.cross-runner',
                target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true, stale: false },
                runtimes: { runner: { entry: 'dist/runner.js', active: false } }
            })
        ])

        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({
            id: 'com.example.cross-runner',
            enabled: false,
            active: false,
            status: 'disabled',
            primary: {
                target: { scope: 'runner:runner-1' }
            }
        })
        expect(groups[0]?.plugins.map((entry) => entry.target?.scope).sort()).toEqual(['hub', 'runner:runner-1'])
    })

    it('prefers the Runner detail target when a Hub row only mirrors Runner settings descriptors', () => {
        const plugins = [
            plugin({
                id: 'com.example.cross-runner',
                target: { scope: 'hub', runtime: 'hub', active: true, stale: false },
                runtimes: { runner: { entry: 'dist/runner.js', active: false } }
            }),
            plugin({
                id: 'com.example.cross-runner',
                target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true, stale: false },
                runtimes: { runner: { entry: 'dist/runner.js', active: true } },
                status: 'active',
                enabled: true,
                active: true
            })
        ]

        expect(preferredPluginDetailTarget(plugins, 'com.example.cross-runner')).toBe('runner:runner-1')
        expect(preferredPluginDetailTarget(plugins, 'com.example.cross-runner', 'hub')).toBe('runner:runner-1')
    })

    it('surfaces the worst target status while preserving active/enabled aggregate flags', () => {
        const groups = groupPluginListForDisplay([
            plugin({
                id: 'com.example.cross',
                target: { scope: 'hub', runtime: 'hub', active: true, stale: false },
                runtimes: { hub: { entry: 'hub.js', active: true } },
                status: 'active',
                enabled: true,
                active: true
            }),
            plugin({
                id: 'com.example.cross',
                target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true, stale: false },
                runtimes: { runner: { entry: 'runner.js', active: false } },
                status: 'failed',
                enabled: true,
                active: false,
                diagnostics: [{ severity: 'error', code: 'boom', message: 'runner failed' }]
            })
        ])

        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({
            id: 'com.example.cross',
            status: 'failed',
            enabled: true,
            active: true
        })
        expect(groups[0]?.diagnostics).toEqual([expect.objectContaining({ code: 'boom' })])
    })

    it('keeps different plugin ids as separate display groups', () => {
        const groups = groupPluginListForDisplay([
            plugin({ id: 'com.example.b', target: { scope: 'hub', runtime: 'hub', active: true, stale: false } }),
            plugin({ id: 'com.example.a', target: { scope: 'hub', runtime: 'hub', active: true, stale: false } })
        ])

        expect(groups.map((group) => group.id)).toEqual(['com.example.a', 'com.example.b'])
    })
})

describe('MarketplacePluginCard', () => {
    it('expands details inside the current marketplace card without a separate review button', () => {
        const entry = marketplaceEntry()
        render(createElement(
            MarketplacePluginCard,
            {
                entry,
                t,
                locale: 'en',
                disabled: false,
                overwrite: false,
                pendingAction: null,
                expanded: true,
                onDetails: () => undefined,
                onInstall: () => undefined
            },
            createElement('div', null, 'inline marketplace details')
        ))

        expect(screen.queryByRole('button', { name: 'settings.plugins.install.previewPlan' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'settings.plugins.marketplace.closeDetails' })).toBeInTheDocument()
        const details = screen.getByText('inline marketplace details')
        expect(details.closest('[data-plugin-id="com.example.market"]')).toHaveAttribute('data-expanded', 'true')
    })

    it('keeps marketplace detail content free of duplicate warning and action buttons', () => {
        const entry = marketplaceEntry()
        render(createElement(
            MarketplacePluginCard,
            {
                entry,
                t,
                locale: 'en',
                disabled: false,
                overwrite: false,
                pendingAction: null,
                expanded: true,
                onDetails: () => undefined,
                onInstall: () => undefined
            },
            createElement(MarketplaceDetailPanel, {
                entry,
                plan: null,
                pendingAction: null,
                overwrite: false,
                t,
                locale: 'en',
                onVersionChange: () => undefined
            })
        ))

        expect(screen.queryByText('settings.plugins.marketplace.trustWarning')).not.toBeInTheDocument()
        expect(screen.getAllByRole('button', { name: 'settings.plugins.marketplace.closeDetails' })).toHaveLength(1)
        expect(screen.getAllByRole('button', { name: 'settings.plugins.marketplace.action.install' })).toHaveLength(1)
    })

    it('shows local-newer installed marketplace plugins as non-installable by default', () => {
        const entry = marketplaceEntry({
            installed: {
                version: '0.2.0',
                enabled: true,
                updateAvailable: false
            }
        })
        render(createElement(
            MarketplacePluginCard,
            {
                entry,
                t,
                locale: 'en',
                disabled: false,
                overwrite: false,
                pendingAction: null,
                expanded: false,
                onDetails: () => undefined,
                onInstall: () => undefined
            }
        ))

        expect(marketplaceHasLocalNewerVersion(entry)).toBe(true)
        expect(screen.getByText('settings.plugins.marketplace.localNewer')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'settings.plugins.marketplace.action.localNewer' })).toBeDisabled()
    })

    it('uses the server-selected compatible update version for marketplace update labels', () => {
        const entry = marketplaceEntry({
            latestCompatibleVersion: '0.2.0',
            releases: ['0.1.0', '0.2.0', '0.3.0'].map((version) => ({
                version,
                tag: `v${version}`,
                manifest: {
                    id: 'com.example.market',
                    name: 'Marketplace Plugin',
                    version,
                    pluginApiVersion: '0.1'
                },
                package: {
                    filename: 'plugin.tgz',
                    url: 'https://example.com/plugin.tgz',
                    format: 'tgz',
                    checksum: `sha256:${'a'.repeat(64)}`
                }
            })),
            installed: {
                version: '0.1.0',
                enabled: true,
                updateAvailable: true,
                updateVersion: '0.2.0'
            }
        })
        render(createElement(
            MarketplacePluginCard,
            {
                entry,
                t,
                locale: 'en',
                disabled: false,
                overwrite: false,
                pendingAction: null,
                expanded: false,
                onDetails: () => undefined,
                onInstall: () => undefined
            }
        ))

        expect(screen.getByText('settings.plugins.marketplace.updateAvailable')).toBeInTheDocument()
        expect(screen.getByText('settings.plugins.marketplace.action.update')).toBeInTheDocument()
    })
})

describe('createMarketplaceInstallPlanKey', () => {
    it('invalidates marketplace install plans when install options change', () => {
        const base = createMarketplaceInstallPlanKey({
            pluginId: 'com.example.market',
            enable: true,
            overwrite: false
        })
        const changedVersion = createMarketplaceInstallPlanKey({
            pluginId: 'com.example.market',
            version: '0.2.0',
            enable: true,
            overwrite: false
        })
        const updateAvailable = createMarketplaceInstallPlanKey({
            pluginId: 'com.example.market',
            enable: true,
            overwrite: false,
            updateAvailable: true
        })

        expect(changedVersion).not.toEqual(base)
        expect(JSON.parse(updateAvailable)).toMatchObject({ overwrite: true })
    })
})
