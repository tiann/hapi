import type { AgentFlavor } from './modes'

// --- Capability constants (prevent literal scattering) ---
export const Capabilities = {
    ModelChange: 'model-change',
    Effort: 'effort',
} as const

export type Capability = typeof Capabilities[keyof typeof Capabilities]

// --- Per-flavor capability sets ---
const FLAVOR_CAPS: Record<AgentFlavor, ReadonlySet<Capability>> = {
    claude: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    gemini: new Set([Capabilities.ModelChange]),
    kimi: new Set([Capabilities.ModelChange]),
    grok: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    codex: new Set([Capabilities.ModelChange]),
    cursor: new Set([Capabilities.ModelChange]),
    opencode: new Set([Capabilities.ModelChange]),
    pi: new Set([Capabilities.ModelChange, Capabilities.Effort]),
}

// --- Flavor display names ---
const FLAVOR_LABELS: Record<AgentFlavor, string> = {
    claude: 'Claude',
    gemini: 'Gemini',
    kimi: 'Kimi',
    grok: 'Grok Build',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    pi: 'Pi',
}

// --- Query functions ---
export function isKnownFlavor(flavor: string | null | undefined): flavor is AgentFlavor {
    return typeof flavor === 'string' && Object.hasOwn(FLAVOR_CAPS, flavor)
}

export function hasCapability(flavor: string | null | undefined, cap: Capability): boolean {
    if (!isKnownFlavor(flavor)) return false
    return FLAVOR_CAPS[flavor].has(cap)
}

export function getFlavorLabel(flavor: string | null | undefined): string {
    if (!isKnownFlavor(flavor)) return 'Unknown'
    return FLAVOR_LABELS[flavor]
}

// --- Convenience functions ---
export function supportsModelChange(flavor: string | null | undefined): boolean {
    return hasCapability(flavor, Capabilities.ModelChange)
}

export function supportsEffort(flavor: string | null | undefined): boolean {
    return hasCapability(flavor, Capabilities.Effort)
}

export function isCodexFamilyFlavor(flavor: string | null | undefined): boolean {
    return flavor === 'codex'
        || flavor === 'gemini'
        || flavor === 'grok'
        || flavor === 'kimi'
        || flavor === 'opencode'
}
