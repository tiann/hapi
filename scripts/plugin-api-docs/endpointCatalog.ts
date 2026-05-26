export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export type EndpointQueryParamDoc = {
    name: string
    description: string
    required?: boolean
    schema?: Record<string, unknown>
    schemaRef?: string
}

export type EndpointDoc = {
    id: string
    method: HttpMethod
    path: string
    description: string
    targetQuery?: boolean
    queryParams?: EndpointQueryParamDoc[]
    bodySchema?: string
    responseSchema: string
}

export const endpointCatalog: EndpointDoc[] = [
    {
        id: 'plugins.list',
        method: 'GET',
        path: '/api/plugins',
        description: 'List Hub and/or Runner plugin inventory for the current namespace.',
        targetQuery: true,
        responseSchema: 'PluginListResponse'
    },
    {
        id: 'plugins.diagnostics',
        method: 'GET',
        path: '/api/plugins/diagnostics',
        description: 'List plugin diagnostics for Hub or Runner targets.',
        targetQuery: true,
        responseSchema: 'PluginDiagnosticsResponse'
    },
    {
        id: 'plugins.notificationFilterOptions',
        method: 'GET',
        path: '/api/plugins/notification-filter-options',
        description: 'List recent namespace, agent, and workspace values for descriptor option sources.',
        responseSchema: 'PluginNotificationFilterOptionsResponse'
    },
    {
        id: 'plugins.capabilities',
        method: 'GET',
        path: '/api/plugins/capabilities',
        description: 'List user-facing plugin capabilities aggregated across Web, Hub, and Runner parts.',
        targetQuery: true,
        queryParams: [{
            name: 'sessionId',
            description: 'Optional session id used to resolve session-runner capability parts.',
            schema: { type: 'string', minLength: 1 }
        }],
        responseSchema: 'PluginCapabilitiesResponse'
    },
    {
        id: 'plugins.reloadAll',
        method: 'POST',
        path: '/api/plugins/reload',
        description: 'Reload all plugins on the selected target.',
        targetQuery: true,
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.installLocal',
        method: 'POST',
        path: '/api/plugins/install-local',
        description: 'Install a plugin from a target-local directory.',
        targetQuery: true,
        bodySchema: 'PluginInstallLocalRequest',
        responseSchema: 'PluginInstallResult'
    },
    {
        id: 'plugins.installPlan',
        method: 'POST',
        path: '/api/plugins/install-plan',
        description: 'Inspect a package upload and return an install plan derived from manifest positions and Hub/Runner compatibility.',
        bodySchema: 'PluginInstallPlanRequest',
        responseSchema: 'PluginInstallPlanResponse'
    },
    {
        id: 'plugins.executeInstallPlan',
        method: 'POST',
        path: '/api/plugins/install-plan/{planId}/execute',
        description: 'Execute a previously created manifest-driven install plan.',
        responseSchema: 'PluginInstallResult'
    },
    {
        id: 'plugins.installPackage',
        method: 'POST',
        path: '/api/plugins/install-package',
        description: 'Legacy target-scoped package install. Prefer install-plan for manifest-driven cross-runtime installs.',
        targetQuery: true,
        bodySchema: 'PluginInstallPackageRequest',
        responseSchema: 'PluginInstallResult'
    },
    {
        id: 'plugins.marketplace.list',
        method: 'GET',
        path: '/api/plugins/marketplace',
        description: 'List marketplace catalog entries and installed state.',
        queryParams: [
            { name: 'q', description: 'Optional text search over id, name, description, repo, and keywords.', schema: { type: 'string' } },
            { name: 'category', description: 'Optional marketplace category filter.', schema: { type: 'string' } },
            { name: 'runtime', description: 'Optional runtime filter, for example hub or runner.', schema: { type: 'string' } }
        ],
        responseSchema: 'PluginMarketplaceListResponse'
    },
    {
        id: 'plugins.marketplace.refresh',
        method: 'POST',
        path: '/api/plugins/marketplace/refresh',
        description: 'Refresh the marketplace catalog cache and return the latest entries.',
        responseSchema: 'PluginMarketplaceListResponse'
    },
    {
        id: 'plugins.marketplace.detail',
        method: 'GET',
        path: '/api/plugins/marketplace/{id}',
        description: 'Inspect one marketplace catalog entry.',
        responseSchema: 'PluginMarketplaceDetailResponse'
    },
    {
        id: 'plugins.marketplace.installPlan',
        method: 'POST',
        path: '/api/plugins/marketplace/{id}/install-plan',
        description: 'Create a manifest-driven install plan for a marketplace plugin release.',
        bodySchema: 'PluginMarketplaceInstallRequest',
        responseSchema: 'PluginMarketplaceInstallPlanResponse'
    },
    {
        id: 'plugins.marketplace.install',
        method: 'POST',
        path: '/api/plugins/marketplace/{id}/install',
        description: 'Install a marketplace plugin release after plan validation.',
        bodySchema: 'PluginMarketplaceInstallRequest',
        responseSchema: 'PluginInstallResult'
    },
    {
        id: 'plugins.localDirectory',
        method: 'POST',
        path: '/api/plugins/local-directory',
        description: 'Browse a target-local directory for plugin install UI.',
        targetQuery: true,
        bodySchema: 'PluginLocalDirectoryListRequest',
        responseSchema: 'PluginLocalDirectoryListResponse'
    },
    {
        id: 'plugins.detail',
        method: 'GET',
        path: '/api/plugins/{id}',
        description: 'Inspect one plugin on Hub or one Runner target.',
        targetQuery: true,
        responseSchema: 'PluginDetailResponse'
    },
    {
        id: 'plugins.reload',
        method: 'POST',
        path: '/api/plugins/{id}/reload',
        description: 'Reload one plugin on the selected target.',
        targetQuery: true,
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.notificationTest',
        method: 'POST',
        path: '/api/plugins/{id}/notification-test',
        description: 'Send a synthetic test notification through one active Hub notification plugin.',
        targetQuery: true,
        responseSchema: 'PluginNotificationTestResponse'
    },
    {
        id: 'plugins.enable',
        method: 'POST',
        path: '/api/plugins/{id}/enable',
        description: 'Enable one plugin with optional non-secret config.',
        targetQuery: true,
        bodySchema: 'PluginEnableRequest',
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.disable',
        method: 'POST',
        path: '/api/plugins/{id}/disable',
        description: 'Disable one plugin.',
        targetQuery: true,
        bodySchema: 'PluginDisableRequest',
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.delete',
        method: 'DELETE',
        path: '/api/plugins/{id}',
        description: 'Delete one plugin from a user-owned plugin install directory.',
        targetQuery: true,
        responseSchema: 'PluginDeleteResult'
    },
    {
        id: 'plugins.updateConfig',
        method: 'PATCH',
        path: '/api/plugins/{id}/config',
        description: 'Replace one plugin scoped config object and reload by default.',
        targetQuery: true,
        bodySchema: 'PluginConfigUpdateRequest',
        responseSchema: 'PluginReloadResult'
    }
]
