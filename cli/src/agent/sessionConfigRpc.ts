import { isPermissionModeAllowedForFlavor, type AgentFlavor } from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import type { PermissionMode } from '@hapi/protocol/types'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

type SessionConfigState<TPermissionMode extends PermissionMode = PermissionMode> = {
    permissionMode?: TPermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
}

type RegisterSessionConfigRpcOptions<TPermissionMode extends PermissionMode = PermissionMode> = {
    rpcHandlerManager: RpcHandlerManager
    flavor: AgentFlavor
    modelMode?: 'nullable' | 'ignore' | 'reject'
    modelReasoningEffortMode?: 'nullable' | 'ignore' | 'reject'
    appliedFallback?: () => Record<string, unknown>
    onApply: (config: SessionConfigState<TPermissionMode>) => void
    onAfterApply?: () => void
}

export function resolveSessionConfigPermissionMode<TPermissionMode extends PermissionMode>(
    value: unknown,
    flavor: AgentFlavor
): TPermissionMode {
    const parsed = PermissionModeSchema.safeParse(value)
    if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, flavor)) {
        throw new Error('Invalid permission mode')
    }
    return parsed.data as TPermissionMode
}

export function resolveNullableSessionModel(value: unknown): string | null {
    if (value === null) {
        return null
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Invalid model')
    }
    return value.trim()
}

export function registerSessionConfigRpc<TPermissionMode extends PermissionMode>({
    rpcHandlerManager,
    flavor,
    modelMode = 'reject',
    modelReasoningEffortMode = 'reject',
    appliedFallback,
    onApply,
    onAfterApply
}: RegisterSessionConfigRpcOptions<TPermissionMode>): void {
    rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload')
        }

        const config = payload as { permissionMode?: unknown; model?: unknown; modelReasoningEffort?: unknown }
        const applied: Record<string, unknown> = {}
        const next: SessionConfigState<TPermissionMode> = {}

        if (config.permissionMode !== undefined) {
            next.permissionMode = resolveSessionConfigPermissionMode<TPermissionMode>(config.permissionMode, flavor)
            applied.permissionMode = next.permissionMode
        }

        if (config.model !== undefined) {
            if (modelMode === 'reject') {
                throw new Error('Invalid model')
            }
            if (modelMode === 'nullable') {
                next.model = resolveNullableSessionModel(config.model)
                applied.model = next.model
            }
        }


        if (config.modelReasoningEffort !== undefined) {
            if (modelReasoningEffortMode === 'reject') {
                throw new Error('Invalid model reasoning effort')
            }
            if (modelReasoningEffortMode === 'nullable') {
                next.modelReasoningEffort = resolveNullableSessionModel(config.modelReasoningEffort)
                applied.modelReasoningEffort = next.modelReasoningEffort
            }
        }

        onApply(next)
        onAfterApply?.()

        return {
            applied: Object.keys(applied).length > 0
                ? applied
                : (appliedFallback?.() ?? applied)
        }
    })
}
