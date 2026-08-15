import type { AgentFlavor } from '@hapi/protocol'

/** Agents whose launch form uses the shared permission-mode selector. */
export const CODEX_FAMILY_PERMISSION_AGENTS = [
    'codex',
    'dsh',
    'gemini',
    'kimi',
    'copilot',
    'opencode'
] as const satisfies readonly AgentFlavor[]

export type CodexFamilyPermissionAgent = typeof CODEX_FAMILY_PERMISSION_AGENTS[number]

export function usesCodexFamilyPermissionModes(
    flavor: string | null | undefined
): flavor is CodexFamilyPermissionAgent {
    return typeof flavor === 'string'
        && (CODEX_FAMILY_PERMISSION_AGENTS as readonly string[]).includes(flavor)
}
