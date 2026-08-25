import {
    AGENT_FLAVORS,
    getCodexCollaborationModeOptions,
    getPermissionModeOptionsForFlavor,
    type CodexCollaborationModeOption,
    type PermissionModeOption
} from '@hapi/protocol/modes'

export type ModesCatalog = {
    /** Codex-only collaboration axis (independent of the permission mode). */
    codexCollaborationModes: CodexCollaborationModeOption[]
    /**
     * Permission modes offered per agent flavor, in offer order, each with its
     * display label and tone. An empty array means the flavor exposes no
     * runtime permission switching (e.g. pi).
     */
    permissionModesByFlavor: Record<string, PermissionModeOption[]>
}

/**
 * Built directly from shared/src/modes.ts (the same module the web app
 * imports), so the emitted catalog can never drift from the running web
 * implementation. Emitted to shared/fixtures/catalogs/modes.json with the
 * same canonical serialization as the chat fixtures.
 */
export function buildModesCatalog(): ModesCatalog {
    const permissionModesByFlavor: Record<string, PermissionModeOption[]> = {}
    for (const flavor of AGENT_FLAVORS) {
        permissionModesByFlavor[flavor] = getPermissionModeOptionsForFlavor(flavor)
    }
    return {
        codexCollaborationModes: getCodexCollaborationModeOptions(),
        permissionModesByFlavor
    }
}
