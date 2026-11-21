import { AGENT_FLAVORS, isCodexFamilyFlavor, type AgentFlavor } from '@hapi/protocol'

const permissionAgents = AGENT_FLAVORS
    .filter(isCodexFamilyFlavor)
    .filter(flavor => flavor !== 'grok')

/**
 * Codex-family flavors that use the shared create-form permission state.
 * Derived from the shared codex-family membership minus grok: grok belongs to
 * the family for tool-permission UI and uses separate create-form state for
 * its own mode catalog (default / auto / plan / bypassPermissions).
 */
export const CODEX_FAMILY_PERMISSION_AGENTS: Readonly<typeof permissionAgents> = permissionAgents

export type CodexFamilyPermissionAgent = typeof CODEX_FAMILY_PERMISSION_AGENTS[number]

export function usesCodexFamilyPermissionModes(
    flavor: string | null | undefined
): flavor is CodexFamilyPermissionAgent {
    return typeof flavor === 'string'
        && (CODEX_FAMILY_PERMISSION_AGENTS as readonly string[]).includes(flavor)
}

/**
 * Flavors outside the codex-family mode set that still render the create-form
 * permission control through the native-mode select.
 * Ports: `NewSessionLogic.usesNativePermissionSelect`
 * (`ios/Packages/HapiKit/Sources/HapiClient/NewSession/NewSessionForm.swift`,
 * `android/app/src/main/kotlin/app/hapi/companion/feature/newsession/NewSessionForm.kt`).
 */
const NATIVE_PERMISSION_SELECT_EXTRA_FLAVORS: readonly AgentFlavor[] = ['claude', 'grok', 'cursor', 'agy']

export function usesNativePermissionSelect(flavor: string | null | undefined): boolean {
    return typeof flavor === 'string'
        && ((NATIVE_PERMISSION_SELECT_EXTRA_FLAVORS as readonly string[]).includes(flavor)
            || usesCodexFamilyPermissionModes(flavor))
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
export const LEGACY_YOLO_BRIDGE_AGENTS: readonly AgentFlavor[] = ['codex', 'claude', 'cursor', 'agy']
