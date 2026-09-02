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

/**
 * Flavors whose create-form permission control is the native-mode select.
 * Ports: `NewSessionLogic.usesNativePermissionSelect`
 * (`ios/Packages/HapiKit/Sources/HapiClient/NewSession/NewSessionForm.swift`,
 * `android/app/src/main/kotlin/app/hapi/companion/feature/newsession/NewSessionForm.kt`).
 * claude and grok do not share the codex-family mode set, but they render
 * through the same native select.
 */
export function usesNativePermissionSelect(flavor: string | null | undefined): boolean {
    return flavor === 'claude' || flavor === 'grok' || usesCodexFamilyPermissionModes(flavor)
}

/**
 * Flavors that keep their create-form permission choice in the single shared
 * `nativePermissionMode` state. Grok is a native-select flavor but is
 * excluded: its Auto option depends on a machine capability
 * (`autoPermissionModeSupported`) that the other native-select flavors do
 * not gate on, so it keeps its own state (`grokPermissionMode`) instead.
 */
export function usesSharedPermissionModeState(flavor: string | null | undefined): boolean {
    return usesNativePermissionSelect(flavor) && flavor !== 'grok'
}

/**
 * Flavors whose create surface carried the HAPI YOLO toggle before it moved
 * to the native permission select. Their stored toggle preference migrates
 * once into the native mode it mapped to; flavors that moved earlier already
 * settled on 'default' and are intentionally left alone.
 */
export const LEGACY_YOLO_BRIDGE_AGENTS: readonly AgentFlavor[] = ['codex', 'claude']
