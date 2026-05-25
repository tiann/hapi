import { describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { usePluginActions } from './usePluginActions'
import type { PluginDeleteResult, PluginInstallResult, PluginReloadResult } from '@hapi/protocol/plugins/admin'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function reloadResult(id = 'com.example.plugin'): PluginReloadResult {
    return {
        ok: true,
        targetId: id,
        results: [{ id, action: 'reloaded', status: 'active', diagnostics: [] }],
        plugins: []
    }
}

function installResult(id = 'com.example.plugin'): PluginInstallResult {
    return {
        ok: true,
        action: 'installed',
        pluginId: id,
        targetPath: `/tmp/${id}`,
        diagnostics: [],
        plugins: [],
        reload: reloadResult(id)
    }
}

function deleteResult(id = 'com.example.plugin'): PluginDeleteResult {
    return {
        ok: true,
        pluginId: id,
        rootPath: `/tmp/${id}`,
        deleted: true,
        plugins: [],
        reload: reloadResult(id)
    }
}

describe('usePluginActions', () => {
    it('invalidates plugin list, diagnostics, and detail queries after actions', async () => {
        const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
        const api = {
            enablePlugin: vi.fn(async () => reloadResult()),
            installLocalPlugin: vi.fn(async () => installResult('com.installed.plugin')),
            installPackagePlugin: vi.fn(async () => installResult('com.package.plugin')),
            createMarketplaceInstallPlan: vi.fn(async () => ({
                marketplace: {
                    sourceUrl: 'https://raw.githubusercontent.com/tiann/hapi/main/marketplace/catalog.v1.json',
                    pluginId: 'com.market.plugin',
                    repo: 'example/market-plugin',
                    version: '1.0.0',
                    assetUrl: 'https://github.com/example/market-plugin/releases/download/v1.0.0/plugin.tgz',
                    checksum: 'sha256:test'
                },
                plan: {
                    planId: 'market-plan-1',
                    createdAt: 1,
                    plugin: { id: 'com.market.plugin', name: 'Market plugin', version: '1.0.0' },
                    source: { type: 'uploaded-package', filename: 'plugin.tgz', checksum: 'sha256:test', format: 'tgz' },
                    positions: ['hub'],
                    targets: [],
                    warnings: [],
                    blockingErrors: []
                }
            })),
            executePluginInstallPlan: vi.fn(async () => installResult('com.market.plugin')),
            testPluginNotification: vi.fn(async () => ({ ok: true, pluginId: 'com.example.plugin', channels: 1, message: 'sent' })),
            deletePlugin: vi.fn(async () => deleteResult('com.example.plugin')),
        } as unknown as ApiClient

        const { result } = renderHook(() => usePluginActions(api), { wrapper: createWrapper(queryClient) })

        await act(async () => {
            await result.current.enablePlugin('com.example.plugin')
        })
        await act(async () => {
            await result.current.installLocalPlugin({ sourcePath: '/tmp/plugin', enable: true, reload: true })
        })
        await act(async () => {
            await result.current.installPackagePlugin({ filename: 'plugin.tgz', contentBase64: 'AA==', checksum: 'sha256:test' }, 'hub')
        })
        await act(async () => {
            await result.current.createMarketplaceInstallPlan('com.market.plugin', { enable: true })
        })
        await act(async () => {
            await result.current.executeInstallPlan('market-plan-1')
        })
        await act(async () => {
            await result.current.testPluginNotification('com.example.plugin')
        })
        await act(async () => {
            await result.current.deletePlugin('com.example.plugin')
        })

        await waitFor(() => {
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.plugins() })
        })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.pluginDiagnostics })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.pluginCapabilitiesRoot })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.plugin('com.example.plugin') })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.plugin('com.installed.plugin') })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.plugins('hub') })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.plugin('com.package.plugin', 'hub') })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.pluginMarketplaceRoot })
        expect(api.enablePlugin).toHaveBeenCalledWith('com.example.plugin', undefined, undefined)
        expect(api.installLocalPlugin).toHaveBeenCalledWith({ sourcePath: '/tmp/plugin', enable: true, reload: true }, undefined)
        expect(api.installPackagePlugin).toHaveBeenCalledWith({ filename: 'plugin.tgz', contentBase64: 'AA==', checksum: 'sha256:test' }, 'hub')
        expect(api.createMarketplaceInstallPlan).toHaveBeenCalledWith('com.market.plugin', { enable: true })
        expect(api.executePluginInstallPlan).toHaveBeenCalledWith('market-plan-1')
        expect(api.testPluginNotification).toHaveBeenCalledWith('com.example.plugin', undefined)
        expect(api.deletePlugin).toHaveBeenCalledWith('com.example.plugin', undefined)
    })

    it('surfaces API errors so plugin pages can show error results', async () => {
        const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
        const api = {
            reloadPlugin: vi.fn(async () => { throw new Error('reload failed') })
        } as unknown as ApiClient
        const { result } = renderHook(() => usePluginActions(api), { wrapper: createWrapper(queryClient) })

        await expect(result.current.reloadPlugin('com.example.plugin')).rejects.toThrow('reload failed')
    })
})
