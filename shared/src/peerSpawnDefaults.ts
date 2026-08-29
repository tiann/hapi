import { z } from 'zod'
import { AgentFlavorSchema, isPermissionModeAllowedForFlavor, type AgentFlavor, type PermissionMode } from './modes'
import { PermissionModeSchema } from './schemas'

/** Per-flavor model id overrides for peer spawn (e.g. claude: sonnet, cursor: auto). */
export const PeerSpawnModelsSchema = z.record(z.string(), z.string().trim().min(1))

export type PeerSpawnModels = z.infer<typeof PeerSpawnModelsSchema>

/** Hub-persisted peer spawn defaults (partial; unset fields fall back to stock). */
export const PeerSpawnDefaultsSchema = z.object({
    agent: AgentFlavorSchema.optional(),
    permissionMode: PermissionModeSchema.optional(),
    models: PeerSpawnModelsSchema.optional()
})

export type PeerSpawnDefaults = z.infer<typeof PeerSpawnDefaultsSchema>

/** Fully resolved peer spawn defaults returned by GET /api/hub-settings. */
export const ResolvedPeerSpawnDefaultsSchema = z.object({
    agent: AgentFlavorSchema,
    permissionMode: PermissionModeSchema,
    models: PeerSpawnModelsSchema
})

export type ResolvedPeerSpawnDefaults = z.infer<typeof ResolvedPeerSpawnDefaultsSchema>

/** Stock product defaults when hub settings omit peerSpawnDefaults. */
export const STOCK_PEER_SPAWN_DEFAULTS: ResolvedPeerSpawnDefaults = {
    agent: 'claude',
    permissionMode: 'yolo',
    models: {
        claude: 'sonnet'
    }
}

const YOLO_EQUIVALENTS: readonly PermissionMode[] = [
    'yolo',
    'always-proceed',
    'bypassPermissions'
]

/** Map a cross-flavor permission intent (e.g. yolo) to a mode the flavor supports. */
export function resolvePermissionModeForFlavor(
    mode: PermissionMode,
    flavor: AgentFlavor
): PermissionMode {
    if (isPermissionModeAllowedForFlavor(mode, flavor)) {
        return mode
    }
    if (mode === 'yolo' || mode === 'safe-yolo') {
        const equivalent = YOLO_EQUIVALENTS.find((candidate) =>
            isPermissionModeAllowedForFlavor(candidate, flavor)
        )
        if (equivalent) {
            return equivalent
        }
    }
    return 'default'
}

export function mergePeerSpawnDefaults(
    stored?: PeerSpawnDefaults | null
): ResolvedPeerSpawnDefaults {
    const models: PeerSpawnModels = {
        ...STOCK_PEER_SPAWN_DEFAULTS.models,
        ...stored?.models
    }
    const agent = stored?.agent ?? STOCK_PEER_SPAWN_DEFAULTS.agent
    const rawPermissionMode = stored?.permissionMode ?? STOCK_PEER_SPAWN_DEFAULTS.permissionMode
    return {
        agent,
        permissionMode: resolvePermissionModeForFlavor(rawPermissionMode, agent),
        models
    }
}

export type PeerSpawnConfigOverrides = {
    agent?: AgentFlavor
    permissionMode?: PermissionMode
    model?: string
    effort?: string
}

export type ResolvedPeerSpawnConfig = {
    agent: AgentFlavor
    permissionMode: PermissionMode
    model?: string
    effort?: string
}

/**
 * Resolve spawn-peer agent / permission / model / effort:
 * explicit CLI/MCP args → hub settings → stock defaults.
 */
export function resolvePeerSpawnConfig(
    overrides: PeerSpawnConfigOverrides,
    hubDefaults?: PeerSpawnDefaults | null
): ResolvedPeerSpawnConfig {
    const stored = hubDefaults ?? {}
    const agent = overrides.agent ?? stored.agent ?? STOCK_PEER_SPAWN_DEFAULTS.agent
    const rawPermissionMode = overrides.permissionMode
        ?? stored.permissionMode
        ?? STOCK_PEER_SPAWN_DEFAULTS.permissionMode
    const permissionMode = resolvePermissionModeForFlavor(rawPermissionMode, agent)
    const models: PeerSpawnModels = {
        ...STOCK_PEER_SPAWN_DEFAULTS.models,
        ...stored.models
    }
    const model = (overrides.model ?? models[agent])?.trim() || undefined
    const effort = overrides.effort?.trim() || undefined
    return {
        agent,
        permissionMode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {})
    }
}
