import { isPermissionModeAllowedForFlavor, type AgentFlavor } from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import type { PermissionMode } from '@hapi/protocol/types'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

type SessionConfigState<TPermissionMode extends PermissionMode = PermissionMode> = {
    permissionMode?: TPermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
}

type RegisterSessionConfigRpcOptions<TPermissionMode extends PermissionMode = PermissionMode> = {
    rpcHandlerManager: RpcHandlerManager
    flavor: AgentFlavor
    modelMode?: 'nullable' | 'ignore' | 'reject'
    // When true, a `{ provider, modelId }` object payload is rebuilt into the
    // provider-qualified "provider/modelId" wire string instead of collapsing
    // to the bare modelId. OpenCode requires the qualified form: its ACP
    // session/set_model parses "provider/model" prefixes and a bare modelId
    // fails with "model not found", which used to leave the backend on the
    // old model while the hub had already recorded the new one.
    modelProviderQualified?: boolean
    modelReasoningEffortMode?: 'nullable' | 'ignore' | 'reject'
    effortMode?: 'nullable' | 'ignore' | 'reject'
    appliedFallback?: () => Record<string, unknown>
    onApply: (config: SessionConfigState<TPermissionMode>) => void | Promise<void>
    onAfterApply?: () => void | Promise<void>
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

/** Extract a model string from either a plain string or a `{ provider,
 *  modelId }` object (the form the hub sends for provider-qualified model
 *  picks). With `opts.providerQualified` the object is rebuilt as the
 *  "provider/modelId" wire string (OpenCode's native set_model format);
 *  without it only the bare modelId is returned (legacy behavior for agents
 *  whose set_model takes an unqualified id, e.g. Cursor). */
export function resolveNullableSessionModel(
    value: unknown,
    opts?: { providerQualified?: boolean }
): string | null {
    if (value === null) {
        return null
    }
    if (typeof value === 'object' && value !== null) {
        const modelObj = value as { provider?: unknown; modelId?: unknown }
        if (typeof modelObj.modelId === 'string' && modelObj.modelId.trim().length > 0) {
            const modelId = modelObj.modelId.trim()
            if (opts?.providerQualified
                && typeof modelObj.provider === 'string'
                && modelObj.provider.trim().length > 0) {
                return `${modelObj.provider.trim()}/${modelId}`
            }
            return modelId
        }
        throw new Error('Invalid model')
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
    modelProviderQualified = false,
    modelReasoningEffortMode = 'reject',
    effortMode = 'reject',
    appliedFallback,
    onApply,
    onAfterApply
}: RegisterSessionConfigRpcOptions<TPermissionMode>): void {
    rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload')
        }

        const config = payload as { permissionMode?: unknown; model?: unknown; modelReasoningEffort?: unknown; effort?: unknown }
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
                next.model = resolveNullableSessionModel(config.model, { providerQualified: modelProviderQualified })
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

        if (config.effort !== undefined) {
            if (effortMode === 'reject') {
                throw new Error('Invalid effort')
            }
            if (effortMode === 'nullable') {
                next.effort = resolveNullableSessionModel(config.effort)
                applied.effort = next.effort
            }
        }

        await onApply(next)
        await onAfterApply?.()

        return {
            applied: Object.keys(applied).length > 0
                ? applied
                : (appliedFallback?.() ?? applied)
        }
    })
}
