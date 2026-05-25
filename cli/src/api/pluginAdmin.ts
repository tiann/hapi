import { configuration } from '@/configuration'
import { buildHubRequestHeaders } from './hubExtraHeaders'
import type {
    PluginConfigUpdateRequest,
    PluginDetailResponse,
    PluginInstallLocalRequest,
    PluginInstallPackageRequest,
    PluginInstallPlanRequest,
    PluginInstallPlanResponse,
    PluginInstallResult,
    PluginListResponse,
    PluginReloadResult,
    PluginTargetScope
} from '@hapi/protocol/plugins/admin'
import type {
    PluginMarketplaceDetailResponse,
    PluginMarketplaceInstallPlanResponse,
    PluginMarketplaceInstallRequest,
    PluginMarketplaceListResponse
} from '@hapi/protocol/plugins/marketplace'

async function readError(response: Response): Promise<string> {
    const body = await response.text().catch(() => '')
    return body || `${response.status} ${response.statusText}`
}

function withTargetQuery(path: string, target?: PluginTargetScope): string {
    if (!target) return path
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}target=${encodeURIComponent(target)}`
}

function withQuery(path: string, query?: Record<string, string | undefined>): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== '') {
            params.set(key, value)
        }
    }
    const suffix = params.toString()
    if (!suffix) return path
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}${suffix}`
}

function buildUrl(path: string): string {
    return new URL(path, configuration.apiUrl).toString()
}

async function fetchJson<T>(path: string, init: RequestInit, timeoutMs = 5000): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(buildUrl(path), {
            ...init,
            signal: controller.signal
        })
        if (!response.ok) {
            throw new Error(await readError(response))
        }
        return await response.json() as T
    } finally {
        clearTimeout(timer)
    }
}

export async function getPluginAdminJwt(accessToken: string, timeoutMs = 5000): Promise<string> {
    const response = await fetchJson<{ token: string }>('/api/auth', {
        method: 'POST',
        headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ accessToken })
    }, timeoutMs)
    return response.token
}

export async function getRemotePlugins(accessToken: string, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginListResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginListResponse>(withTargetQuery('/api/plugins', target), {
        method: 'GET',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function getRemotePlugin(accessToken: string, pluginId: string, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginDetailResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginDetailResponse>(withTargetQuery(`/api/plugins/${encodeURIComponent(pluginId)}`, target), {
        method: 'GET',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function updateRemotePluginConfig(accessToken: string, pluginId: string, body: PluginConfigUpdateRequest, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginReloadResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginReloadResult>(withTargetQuery(`/api/plugins/${encodeURIComponent(pluginId)}/config`, target), {
        method: 'PATCH',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function installRemoteLocalPlugin(accessToken: string, body: PluginInstallLocalRequest, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginInstallResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginInstallResult>(withTargetQuery('/api/plugins/install-local', target), {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function installRemotePackagePlugin(accessToken: string, body: PluginInstallPackageRequest, timeoutMs = 120000, target?: PluginTargetScope): Promise<PluginInstallResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginInstallResult>(withTargetQuery('/api/plugins/install-package', target), {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function createRemotePluginInstallPlan(accessToken: string, body: PluginInstallPlanRequest, timeoutMs = 120000): Promise<PluginInstallPlanResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginInstallPlanResponse>('/api/plugins/install-plan', {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function executeRemotePluginInstallPlan(accessToken: string, planId: string, timeoutMs = 120000): Promise<PluginInstallResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginInstallResult>(`/api/plugins/install-plan/${encodeURIComponent(planId)}/execute`, {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function getRemotePluginMarketplace(accessToken: string, timeoutMs = 5000, query?: {
    q?: string
    category?: string
    runtime?: string
}): Promise<PluginMarketplaceListResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginMarketplaceListResponse>(withQuery('/api/plugins/marketplace', query), {
        method: 'GET',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function getRemotePluginMarketplaceEntry(accessToken: string, pluginId: string, timeoutMs = 5000): Promise<PluginMarketplaceDetailResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginMarketplaceDetailResponse>(`/api/plugins/marketplace/${encodeURIComponent(pluginId)}`, {
        method: 'GET',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function refreshRemotePluginMarketplace(accessToken: string, timeoutMs = 5000): Promise<PluginMarketplaceListResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginMarketplaceListResponse>('/api/plugins/marketplace/refresh', {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function createRemoteMarketplaceInstallPlan(accessToken: string, pluginId: string, body: PluginMarketplaceInstallRequest, timeoutMs = 120000): Promise<PluginMarketplaceInstallPlanResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginMarketplaceInstallPlanResponse>(`/api/plugins/marketplace/${encodeURIComponent(pluginId)}/install-plan`, {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function reloadRemotePlugins(accessToken: string, pluginId?: string, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginReloadResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    const path = pluginId ? `/api/plugins/${encodeURIComponent(pluginId)}/reload` : '/api/plugins/reload'
    return await fetchJson<PluginReloadResult>(withTargetQuery(path, target), {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}
