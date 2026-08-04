import type { AgentFlavor } from '@hapi/protocol'

/** Agents that share codex-family permission modes (default / read-only / safe-yolo / yolo). */
export const CODEX_FAMILY_PERMISSION_AGENTS = [
    'codex',
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
