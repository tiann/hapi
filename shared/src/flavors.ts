import type { AgentFlavor, PermissionMode } from './modes'

// --- Capability constants (prevent literal scattering) ---
export const Capabilities = {
    ModelChange: 'model-change',
    Effort: 'effort',
} as const

export type Capability = typeof Capabilities[keyof typeof Capabilities]

/** `decision`: approve / approve-for-session / abort. `allowTools`: allow / allow-tools-for-session / allow-all-edits. `generic`: allow / allow-for-session / deny. */
export type PermissionReplyStyle = 'decision' | 'allowTools' | 'generic'

type FlavorTraits = {
    readonly label: string
    readonly capabilities: ReadonlySet<Capability>
    readonly permissionReplyStyle: PermissionReplyStyle
    /** New-session form permission mode: `shared` selectable in the shared form state, `separate` selectable in the flavor's own state, `managed` not selectable. */
    readonly permissionCreateFormModeSource: 'shared' | 'separate' | 'managed'
    /** Mode a saved YOLO toggle migrates to in the new-session form; null if it is not migrated. */
    readonly yoloToggleMigrationMode: PermissionMode | null
    /** Mode that auto-approves everything; null if the flavor has none. */
    readonly yoloPermissionMode: PermissionMode | null
    /** Tools whose name starts with this are answered with decisions in any session; null if none. */
    readonly decisionToolNamePrefix: string | null
}

// --- One record per flavor ---
const agyTraits = {
    label: 'Antigravity',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'generic',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: 'always-proceed',
    yoloPermissionMode: 'always-proceed',
    decisionToolNamePrefix: null,
} satisfies FlavorTraits

const claudeTraits = {
    label: 'Claude',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'allowTools',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: 'bypassPermissions',
    yoloPermissionMode: 'bypassPermissions',
    decisionToolNamePrefix: null,
} satisfies FlavorTraits

const codexTraits = {
    label: 'Codex',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: 'yolo',
    yoloPermissionMode: 'yolo',
    decisionToolNamePrefix: 'Codex',
} satisfies FlavorTraits

const dshTraits = {
    label: 'DeepSeek Harness',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'generic',
    permissionCreateFormModeSource: 'managed',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: null,
    decisionToolNamePrefix: null,
} satisfies FlavorTraits

const copilotTraits = {
    label: 'Copilot',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: 'yolo',
    decisionToolNamePrefix: 'Copilot',
} satisfies FlavorTraits

const cursorTraits = {
    label: 'Cursor',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: 'yolo',
    yoloPermissionMode: 'yolo',
    decisionToolNamePrefix: 'Cursor',
} satisfies FlavorTraits

const geminiTraits = {
    label: 'Gemini',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: 'yolo',
    decisionToolNamePrefix: 'Gemini',
} satisfies FlavorTraits

const grokTraits = {
    label: 'Grok Build',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    // Its Auto mode depends on a machine capability, so the form keeps grok's mode apart.
    permissionCreateFormModeSource: 'separate',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: 'bypassPermissions',
    decisionToolNamePrefix: null,
} satisfies FlavorTraits

const kimiTraits = {
    label: 'Kimi',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: 'yolo',
    decisionToolNamePrefix: null,
} satisfies FlavorTraits

const opencodeTraits = {
    label: 'OpenCode',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionCreateFormModeSource: 'shared',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: 'yolo',
    decisionToolNamePrefix: 'OpenCode',
} satisfies FlavorTraits

const piTraits = {
    label: 'Pi',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'generic',
    permissionCreateFormModeSource: 'managed',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: null,
    decisionToolNamePrefix: null,
} satisfies FlavorTraits

const FLAVOR_TRAITS: Readonly<Record<AgentFlavor, FlavorTraits>> = {
    agy: agyTraits,
    claude: claudeTraits,
    codex: codexTraits,
    dsh: dshTraits,
    copilot: copilotTraits,
    cursor: cursorTraits,
    gemini: geminiTraits,
    grok: grokTraits,
    kimi: kimiTraits,
    opencode: opencodeTraits,
    pi: piTraits,
}

const UNKNOWN_FLAVOR_TRAITS: FlavorTraits = {
    label: 'Unknown',
    capabilities: new Set<Capability>(),
    permissionReplyStyle: 'generic',
    permissionCreateFormModeSource: 'managed',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: null,
    decisionToolNamePrefix: null,
}

function traitsOf(flavor: string | null | undefined): FlavorTraits {
    return isKnownFlavor(flavor) ? FLAVOR_TRAITS[flavor] : UNKNOWN_FLAVOR_TRAITS
}

// --- Query functions ---
export function isKnownFlavor(flavor: string | null | undefined): flavor is AgentFlavor {
    return typeof flavor === 'string' && Object.hasOwn(FLAVOR_TRAITS, flavor)
}

export function hasCapability(flavor: string | null | undefined, cap: Capability): boolean {
    return traitsOf(flavor).capabilities.has(cap)
}

export function getFlavorLabel(flavor: string | null | undefined): string {
    return traitsOf(flavor).label
}

// --- Convenience functions ---
export function supportsModelChange(flavor: string | null | undefined): boolean {
    return hasCapability(flavor, Capabilities.ModelChange)
}

export function supportsEffort(flavor: string | null | undefined): boolean {
    return hasCapability(flavor, Capabilities.Effort)
}

const DECISION_TOOL_NAME_PREFIXES: readonly string[] = Object.values(FLAVOR_TRAITS)
    .map((traits) => traits.decisionToolNamePrefix)
    .filter((prefix): prefix is string => prefix !== null)

export function getPermissionReplyStyle(
    flavor: string | null | undefined,
    toolName?: string
): PermissionReplyStyle {
    if (toolName && DECISION_TOOL_NAME_PREFIXES.some((prefix) => toolName.startsWith(prefix))) {
        return 'decision'
    }
    return traitsOf(flavor).permissionReplyStyle
}

export function usesNativePermissionSelect(flavor: string | null | undefined): boolean {
    return traitsOf(flavor).permissionCreateFormModeSource !== 'managed'
}

export function usesSharedPermissionModeState(flavor: string | null | undefined): boolean {
    return traitsOf(flavor).permissionCreateFormModeSource === 'shared'
}

export function getYoloToggleMigrationMode(flavor: string | null | undefined): PermissionMode | null {
    return traitsOf(flavor).yoloToggleMigrationMode
}

export function resolveHapiYoloPermissionMode(flavor: string | null | undefined): PermissionMode | null {
    return traitsOf(flavor).yoloPermissionMode
}
