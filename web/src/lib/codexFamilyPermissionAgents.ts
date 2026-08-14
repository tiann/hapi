import type { AgentFlavor } from '@hapi/protocol'

/** Agents that use the Codex-family permission selector. */
export const CODEX_FAMILY_PERMISSION_AGENTS = [
    'codex',
    'gemini',
    'kimi',
    'copilot',
    'opencode',
] as const satisfies readonly AgentFlavor[]

export type CodexFamilyPermissionAgent = typeof CODEX_FAMILY_PERMISSION_AGENTS[number]

/** All flavors that expose a selectable permission mode on the new-session form. */
export const FLAVOR_PERMISSION_MODE_AGENTS = [
    ...CODEX_FAMILY_PERMISSION_AGENTS,
    'reasonix'
] as const satisfies readonly AgentFlavor[]

export type FlavorPermissionModeAgent = typeof FLAVOR_PERMISSION_MODE_AGENTS[number]

export function usesCodexFamilyPermissionModes(
    flavor: string | null | undefined
): flavor is CodexFamilyPermissionAgent {
    return typeof flavor === 'string'
        && (CODEX_FAMILY_PERMISSION_AGENTS as readonly string[]).includes(flavor)
}

export function usesFlavorPermissionModes(
    flavor: string | null | undefined
): flavor is FlavorPermissionModeAgent {
    return typeof flavor === 'string'
        && (FLAVOR_PERMISSION_MODE_AGENTS as readonly string[]).includes(flavor)
}
