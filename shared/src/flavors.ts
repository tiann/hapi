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
    codex: new Set([]),
    cursor: new Set([]),
    opencode: new Set([]),
}

// --- Flavor display names ---
const FLAVOR_LABELS: Record<AgentFlavor, string> = {
    claude: 'Claude',
    gemini: 'Gemini',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
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
