import {
    ProviderCreateRequestSchema,
    ProviderHealthCheckRequestSchema,
    ProviderListRequestSchema,
    ProviderSetDefaultRequestSchema,
    ProviderUpdateRequestSchema,
    type ProviderHealthCheckResponse,
    type ProviderListResponse,
    type ProviderMutationResponse
} from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { checkProviderHealth } from './providerHealth'
import { ProviderRegistry } from './providerRegistry'

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Operation failed'
}

export function registerProviderHandlers(options: {
    rpcHandlerManager: RpcHandlerManager
    providerRegistry?: ProviderRegistry
}): void {
    const { rpcHandlerManager } = options
    const registry = options.providerRegistry ?? new ProviderRegistry()

    rpcHandlerManager.registerHandler<unknown, ProviderListResponse>(RPC_METHODS.ProviderList, async (raw) => {
        const parsed = ProviderListRequestSchema.safeParse(raw ?? {})
        if (!parsed.success) return { success: false, error: 'Invalid provider list request' }
        try {
            return await registry.list(parsed.data.agent)
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, ProviderMutationResponse>(RPC_METHODS.ProviderCreate, async (raw) => {
        const parsed = ProviderCreateRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid provider profile' }
        try {
            return { success: true, profile: await registry.create(parsed.data) }
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, ProviderMutationResponse>(RPC_METHODS.ProviderUpdate, async (raw) => {
        const parsed = ProviderUpdateRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid provider update' }
        try {
            return { success: true, profile: await registry.update(parsed.data.id, parsed.data.patch) }
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, ProviderMutationResponse>(RPC_METHODS.ProviderSetDefault, async (raw) => {
        const parsed = ProviderSetDefaultRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid default provider request' }
        try {
            await registry.setDefault(parsed.data.agent, parsed.data.id)
            return { success: true }
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, ProviderHealthCheckResponse>(RPC_METHODS.ProviderHealthCheck, async (raw) => {
        const parsed = ProviderHealthCheckRequestSchema.safeParse(raw)
        if (!parsed.success) {
            return { success: false, status: 'unhealthy', checkedAt: Date.now(), error: 'Invalid provider health request' }
        }
        try {
            const profile = await registry.get(parsed.data.id)
            if (!profile) {
                return { success: false, status: 'unhealthy', checkedAt: Date.now(), error: 'Provider profile not found' }
            }
            const checked = await checkProviderHealth(profile)
            const updated = await registry.recordHealthCheck(profile.id, checked)
            return {
                ...checked,
                models: parsed.data.refreshModels ? updated.models : undefined
            }
        } catch (error) {
            return { success: false, status: 'unhealthy', checkedAt: Date.now(), error: errorMessage(error) }
        }
    })
}
