import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PluginDeleteResult, PluginInstallLocalRequest, PluginInstallPackageRequest, PluginInstallPlanRequest, PluginInstallPlanResponse, PluginInstallResult, PluginNotificationTestResponse, PluginReloadResult, PluginTargetScope } from '@hapi/protocol/plugins/admin'
import type { PluginMarketplaceInstallPlanResponse, PluginMarketplaceInstallRequest } from '@hapi/protocol/plugins/marketplace'
import { queryKeys } from '@/lib/query-keys'

type PluginActionMutationResult = PluginReloadResult | PluginInstallResult | PluginInstallPlanResponse | PluginMarketplaceInstallPlanResponse | PluginDeleteResult | PluginNotificationTestResponse

type PluginAction = {
    type: 'enable' | 'disable' | 'reload' | 'reload-all' | 'config' | 'notification-test' | 'install-local' | 'install-package' | 'install-plan' | 'marketplace-install-plan' | 'execute-install-plan' | 'delete'
    id?: string
    target?: PluginTargetScope
    config?: Record<string, unknown>
    installLocal?: PluginInstallLocalRequest
    installPackage?: PluginInstallPackageRequest
    installPlan?: PluginInstallPlanRequest
    marketplaceInstallPlan?: { pluginId: string; request: PluginMarketplaceInstallRequest }
    planId?: string
}

export function usePluginActions(api: ApiClient | null): {
    enablePlugin: (id: string, config?: Record<string, unknown>, target?: PluginTargetScope) => Promise<PluginReloadResult>
    disablePlugin: (id: string, target?: PluginTargetScope) => Promise<PluginReloadResult>
    reloadPlugin: (id: string, target?: PluginTargetScope) => Promise<PluginReloadResult>
    reloadPlugins: (target?: PluginTargetScope) => Promise<PluginReloadResult>
    saveConfig: (id: string, config: Record<string, unknown>, target?: PluginTargetScope) => Promise<PluginReloadResult>
    testPluginNotification: (id: string, target?: PluginTargetScope) => Promise<PluginNotificationTestResponse>
    installLocalPlugin: (body: PluginInstallLocalRequest, target?: PluginTargetScope) => Promise<PluginInstallResult>
    installPackagePlugin: (body: PluginInstallPackageRequest, target?: PluginTargetScope) => Promise<PluginInstallResult>
    createInstallPlan: (body: PluginInstallPlanRequest) => Promise<PluginInstallPlanResponse>
    createMarketplaceInstallPlan: (pluginId: string, body: PluginMarketplaceInstallRequest) => Promise<PluginMarketplaceInstallPlanResponse>
    executeInstallPlan: (planId: string) => Promise<PluginInstallResult>
    deletePlugin: (id: string, target?: PluginTargetScope) => Promise<PluginDeleteResult>
    isPending: boolean
} {
    const queryClient = useQueryClient()
    const invalidate = async (id?: string, target?: PluginTargetScope) => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.plugins() })
        if (target) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.plugins(target) })
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.pluginDiagnostics })
        await queryClient.invalidateQueries({ queryKey: queryKeys.pluginCapabilitiesRoot })
        if (id) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.plugin(id, target) })
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.pluginMarketplaceRoot })
    }
    const mutation = useMutation<PluginActionMutationResult, Error, PluginAction>({
        mutationFn: async (action) => {
            if (!api) throw new Error('API unavailable')
            if (action.type === 'enable' && action.id) return await api.enablePlugin(action.id, action.config, action.target)
            if (action.type === 'disable' && action.id) return await api.disablePlugin(action.id, action.target)
            if (action.type === 'reload' && action.id) return await api.reloadPlugin(action.id, action.target)
            if (action.type === 'config' && action.id && action.config) return await api.updatePluginConfig(action.id, action.config, action.target)
            if (action.type === 'notification-test' && action.id) return await api.testPluginNotification(action.id, action.target)
            if (action.type === 'install-local' && action.installLocal) return await api.installLocalPlugin(action.installLocal, action.target)
            if (action.type === 'install-package' && action.installPackage) return await api.installPackagePlugin(action.installPackage, action.target)
            if (action.type === 'install-plan' && action.installPlan) return await api.createPluginInstallPlan(action.installPlan)
            if (action.type === 'marketplace-install-plan' && action.marketplaceInstallPlan) {
                return await api.createMarketplaceInstallPlan(action.marketplaceInstallPlan.pluginId, action.marketplaceInstallPlan.request)
            }
            if (action.type === 'execute-install-plan' && action.planId) return await api.executePluginInstallPlan(action.planId)
            if (action.type === 'delete' && action.id) return await api.deletePlugin(action.id, action.target)
            return await api.reloadPlugins(action.target)
        },
        onSuccess: (result, action) => {
            const installedId = 'pluginId' in result ? result.pluginId : undefined
            if (action.type === 'install-plan' || action.type === 'marketplace-install-plan' || action.type === 'notification-test') return
            void invalidate(action.id ?? installedId, action.target)
        },
    })

    return {
        enablePlugin: async (id, config, target) => await mutation.mutateAsync({ type: 'enable', id, config, target }) as PluginReloadResult,
        disablePlugin: async (id, target) => await mutation.mutateAsync({ type: 'disable', id, target }) as PluginReloadResult,
        reloadPlugin: async (id, target) => await mutation.mutateAsync({ type: 'reload', id, target }) as PluginReloadResult,
        reloadPlugins: async (target) => await mutation.mutateAsync({ type: 'reload-all', target }) as PluginReloadResult,
        saveConfig: async (id, config, target) => await mutation.mutateAsync({ type: 'config', id, config, target }) as PluginReloadResult,
        testPluginNotification: async (id, target) => await mutation.mutateAsync({ type: 'notification-test', id, target }) as PluginNotificationTestResponse,
        installLocalPlugin: async (body, target) => await mutation.mutateAsync({ type: 'install-local', installLocal: body, target }) as PluginInstallResult,
        installPackagePlugin: async (body, target) => await mutation.mutateAsync({ type: 'install-package', installPackage: body, target }) as PluginInstallResult,
        createInstallPlan: async (body) => await mutation.mutateAsync({ type: 'install-plan', installPlan: body }) as PluginInstallPlanResponse,
        createMarketplaceInstallPlan: async (pluginId, body) => await mutation.mutateAsync({ type: 'marketplace-install-plan', marketplaceInstallPlan: { pluginId, request: body } }) as PluginMarketplaceInstallPlanResponse,
        executeInstallPlan: async (planId) => await mutation.mutateAsync({ type: 'execute-install-plan', planId }) as PluginInstallResult,
        deletePlugin: async (id, target) => await mutation.mutateAsync({ type: 'delete', id, target }) as PluginDeleteResult,
        isPending: mutation.isPending,
    }
}
