import { z } from 'zod'
import {
    AgentFlavorSchema,
    CREATABLE_AGENT_FLAVORS,
    getLaunchPermissionModesForFlavor,
    type AgentFlavor,
    type PermissionMode
} from './modes'
import { PermissionModeSchema } from './schemas'

/** Per-flavor model id overrides for peer spawn (e.g. claude: sonnet, cursor: auto).
 * Empty string is a patch sentinel meaning “clear this flavor’s override”. */
export const PeerSpawnModelsSchema = z.record(z.string(), z.string())

export type PeerSpawnModels = z.infer<typeof PeerSpawnModelsSchema>

/** New-session / spawn defaults only accept creatable flavors (not retired gemini). */
const CreatableAgentFlavorSchema = AgentFlavorSchema.refine(
    (agent): agent is AgentFlavor => (CREATABLE_AGENT_FLAVORS as readonly string[]).includes(agent),
    { message: 'Agent flavor is not creatable' }
)

/** Hub-persisted peer spawn defaults (partial; unset fields fall back to stock). */
export const PeerSpawnDefaultsSchema = z.object({
    agent: CreatableAgentFlavorSchema.optional(),
    permissionMode: PermissionModeSchema.optional(),
    models: PeerSpawnModelsSchema.optional()
})

export type PeerSpawnDefaults = z.infer<typeof PeerSpawnDefaultsSchema>

/** Fully resolved peer spawn defaults returned by GET /api/hub-settings. */
export const ResolvedPeerSpawnDefaultsSchema = z.object({
    agent: CreatableAgentFlavorSchema,
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

/** Map a cross-flavor permission intent (e.g. yolo) to a *launchable* mode. */
export function resolvePermissionModeForFlavor(
    mode: PermissionMode,
    flavor: AgentFlavor
): PermissionMode {
    const launchModes = getLaunchPermissionModesForFlavor(flavor)
    if (launchModes.includes(mode)) {
        return mode
    }
    // Remap any auto-approval equivalent onto a launchable mode for the target
    // flavor — hub GET returns already-resolved Claude bypassPermissions, and
    // Kimi safe-yolo must not inherit onto Codex (launch catalog excludes it).
    if (mode === 'safe-yolo' || (YOLO_EQUIVALENTS as readonly PermissionMode[]).includes(mode)) {
        const equivalent = YOLO_EQUIVALENTS.find((candidate) =>
            launchModes.includes(candidate)
        )
        if (equivalent) {
            return equivalent
        }
    }
    if (launchModes.length === 0) {
        // Pi/DSH: caller must omit permissionMode on the wire.
        return 'default'
    }
    if (flavor === 'agy' && launchModes.includes('request-review')) {
        return 'request-review'
    }
    if (launchModes.includes('default')) {
        return 'default'
    }
    return launchModes[0]!
}

export function mergePeerSpawnDefaults(
    stored?: PeerSpawnDefaults | null
): ResolvedPeerSpawnDefaults {
    const storedModels: PeerSpawnModels = {}
    for (const [flavor, model] of Object.entries(stored?.models ?? {})) {
        const trimmed = model.trim()
        if (trimmed) {
            storedModels[flavor] = trimmed
        }
    }
    const models: PeerSpawnModels = {
        ...STOCK_PEER_SPAWN_DEFAULTS.models,
        ...storedModels
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
 * Resolve spawn-peer / machine-spawn agent / permission / model / effort:
 * explicit args → hub settings → stock defaults.
 *
 * Do **not** treat `permissionMode: "default"` as omit here — New Session and
 * POST /machines/:id/spawn use this resolver and must keep an explicit native
 * Default selection. CLI/MCP `spawnPeer` normalizes agent-habit `"default"` to
 * omit before calling this function.
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
