// Re-export from shared package for backwards compatibility
export { isKnownFlavor, supportsModelChange, supportsEffort } from '@hapi/protocol'

// Flavor-family helper not yet in shared — keep here until next migration
export function isCodexFamilyFlavor(flavor?: string | null): boolean {
    return flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode'
}
