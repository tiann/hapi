import type { PermissionMode, SteeringCapability, SteeringSessionMetadata, SteeringSessionState } from './modes'

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
    /** Permission modes offered for the flavor; empty when the flavor has none. */
    readonly permissionModes: readonly PermissionMode[]
    /** Whether the mode is one of the flavor's permission modes. */
    allowsPermissionMode(mode: string): mode is PermissionMode
    /** New-session form permission mode: `shared` selectable in the shared form state, `separate` selectable in the flavor's own state, `managed` not selectable. */
    readonly permissionCreateFormModeSource: 'shared' | 'separate' | 'managed'
    /** Mode a saved YOLO toggle migrates to in the new-session form; null if it is not migrated. */
    readonly yoloToggleMigrationMode: PermissionMode | null
    /** Mode that auto-approves everything; null if the flavor has none. */
    readonly yoloPermissionMode: PermissionMode | null
    /** Tools whose name starts with this are answered with decisions in any session; null if none. */
    readonly decisionToolNamePrefix: string | null
    /** Offered when creating a new session. */
    readonly creatable: boolean
    /** How a queued message is delivered into an active turn; null if the flavor cannot steer. */
    readonly steering: SteeringCapability | null
}

type FlavorSpec<TModes extends readonly PermissionMode[]> = {
    label: string
    capabilities: ReadonlySet<Capability>
    permissionReplyStyle: PermissionReplyStyle
    permissionModes: TModes
    decisionToolNamePrefix?: string
    /** The new-session form keeps this flavor's mode in its own state instead of the shared one. */
    ownPermissionFormState?: boolean
    /** Saved new-session YOLO toggles from before permission modes migrate to the auto-approve mode. */
    migratesYoloToggle?: boolean
    creatable?: boolean
    steering?: SteeringCapability
}

const AUTO_APPROVE_MODES: readonly PermissionMode[] = ['yolo', 'bypassPermissions', 'always-proceed']

function defineFlavor<const TModes extends readonly PermissionMode[]>(
    spec: FlavorSpec<TModes>
): Omit<FlavorTraits, 'permissionModes' | 'allowsPermissionMode'> & {
    readonly permissionModes: TModes
    allowsPermissionMode(mode: string): mode is TModes[number]
} {
    const autoApproveModes = spec.permissionModes.filter((mode) => AUTO_APPROVE_MODES.includes(mode))
    if (autoApproveModes.length > 1) {
        throw new Error(`Flavor ${spec.label} lists more than one auto-approve mode: ${autoApproveModes.join(', ')}`)
    }
    const yoloPermissionMode = autoApproveModes[0] ?? null
    return {
        label: spec.label,
        capabilities: spec.capabilities,
        permissionReplyStyle: spec.permissionReplyStyle,
        permissionModes: spec.permissionModes,
        allowsPermissionMode: (mode): mode is TModes[number] => (spec.permissionModes as readonly string[]).includes(mode),
        permissionCreateFormModeSource: spec.permissionModes.length === 0
            ? 'managed'
            : spec.ownPermissionFormState ? 'separate' : 'shared',
        yoloToggleMigrationMode: spec.migratesYoloToggle ? yoloPermissionMode : null,
        yoloPermissionMode,
        decisionToolNamePrefix: spec.decisionToolNamePrefix ?? null,
        creatable: spec.creatable ?? true,
        steering: spec.steering ?? null,
    }
}

// Only sessions running on agy acp can steer.
function isAgyAcpSession(metadata: SteeringSessionMetadata): boolean {
    return metadata.agyProtocol === 'acp'
}

// Legacy stream-json sessions cannot steer, including pre-ACP sessions with only an id.
function isCursorAcpSession(metadata: SteeringSessionMetadata): boolean {
    return metadata.cursorSessionProtocol !== 'stream-json'
        && (Boolean(metadata.cursorSessionProtocol) || !metadata.cursorSessionId)
}

const agy = defineFlavor({
    label: 'Antigravity',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'generic',
    permissionModes: ['request-review', 'acceptEdits', 'plan', 'always-proceed'],
    migratesYoloToggle: true,
    // Concurrent ACP `session/prompt` (`agy acp`); agy answers the interrupted request at once and folds the steer in after any running tool call finishes.
    steering: { activeTurnState: 'steeringActive', supportsSession: isAgyAcpSession },
})

const claude = defineFlavor({
    label: 'Claude',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'allowTools',
    permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
    migratesYoloToggle: true,
    // Stream-json stdin write during the turn (TUI Ctrl+X Ctrl+S); folded in at the next tool boundary, remote mode only.
    steering: { activeTurnState: 'steeringActive' },
})

const codex = defineFlavor({
    label: 'Codex',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'autoReview', 'yolo'],
    decisionToolNamePrefix: 'Codex',
    migratesYoloToggle: true,
    // App-server `turn/steer` (true mid-turn inject).
    steering: { activeTurnState: 'steeringActive' },
})

const dsh = defineFlavor({
    label: 'DeepSeek Harness',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'generic',
    // DSH applies its own server-side permission policy, so no modes are offered.
    permissionModes: [],
})

const copilot = defineFlavor({
    label: 'Copilot',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    decisionToolNamePrefix: 'Copilot',
})

const cursor = defineFlavor({
    label: 'Cursor',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'],
    decisionToolNamePrefix: 'Cursor',
    migratesYoloToggle: true,
    // ACP: concurrent `session/prompt` soft-send without cancel; legacy stream-json sessions cannot steer.
    steering: { activeTurnState: 'steeringActive', supportsSession: isCursorAcpSession },
})

const gemini = defineFlavor({
    label: 'Gemini',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    decisionToolNamePrefix: 'Gemini',
    // Google sunset the consumer Gemini CLI, so it cannot be launched; stored sessions stay viewable.
    creatable: false,
})

const grok = defineFlavor({
    label: 'Grok Build',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'auto', 'plan', 'bypassPermissions'],
    // Its Auto mode depends on a machine capability, so the form keeps grok's mode apart.
    ownPermissionFormState: true,
})

const kimi = defineFlavor({
    label: 'Kimi',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
})

const opencode = defineFlavor({
    label: 'OpenCode',
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'plan', 'yolo'],
    decisionToolNamePrefix: 'OpenCode',
    // v1: concurrent ACP `session/prompt`; v2: durable REST inbox steering at a native step boundary. Both require live steeringActive.
    steering: { activeTurnState: 'steeringActive' },
})

const pi = defineFlavor({
    label: 'Pi',
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'generic',
    // Pi RPC always auto-approves, so no modes are offered.
    permissionModes: [],
    // Native steer over the Pi runtime.
    steering: { activeTurnState: 'thinking' },
})

// One entry per flavor; the key is the flavor id stored in session metadata.
export const Flavors = {
    agy, claude, codex, dsh, copilot, cursor, gemini, grok, kimi, opencode, pi,
} satisfies Record<string, FlavorTraits>

export type AgentFlavor = keyof typeof Flavors

// Object.keys is not typed per key and z.enum needs a non-empty tuple.
export const AGENT_FLAVORS = Object.keys(Flavors) as unknown as readonly [AgentFlavor, ...AgentFlavor[]]

export const CREATABLE_AGENT_FLAVORS: readonly AgentFlavor[] = AGENT_FLAVORS.filter(
    (flavor) => Flavors[flavor].creatable
)

/** Permission mode union declared by a flavor, for example `PermissionModeOf<typeof Flavors.codex>`. */
export type PermissionModeOf<T extends { readonly permissionModes: readonly PermissionMode[] }> = T['permissionModes'][number]

const UNKNOWN_FLAVOR_TRAITS: FlavorTraits = {
    label: 'Unknown',
    capabilities: new Set<Capability>(),
    permissionReplyStyle: 'generic',
    // Unknown flavors fall back to the Claude list.
    permissionModes: claude.permissionModes,
    allowsPermissionMode: claude.allowsPermissionMode,
    permissionCreateFormModeSource: 'managed',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: null,
    decisionToolNamePrefix: null,
    creatable: false,
    steering: null,
}

function traitsOf(flavor: string | null | undefined): FlavorTraits {
    return isKnownFlavor(flavor) ? Flavors[flavor] : UNKNOWN_FLAVOR_TRAITS
}

// --- Query functions ---
export function isKnownFlavor(flavor: string | null | undefined): flavor is AgentFlavor {
    return typeof flavor === 'string' && Object.hasOwn(Flavors, flavor)
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

const DECISION_TOOL_NAME_PREFIXES: readonly string[] = Object.values(Flavors)
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

/** Flavors that can deliver a queued message into an active turn without waiting for the turn to end; the UI hides Steer for the others. */
export const STEERING_SUPPORTED_FLAVORS: readonly AgentFlavor[] = AGENT_FLAVORS.filter(
    (flavor) => Flavors[flavor].steering !== null
)

function getSteeringCapability(flavor?: string | null): SteeringCapability | null {
    return traitsOf(flavor).steering
}

export function isSteeringSupportedForFlavor(flavor?: string | null): boolean {
    return getSteeringCapability(flavor) !== null
}

/**
 * Session-aware steer gate. Legacy Cursor stream-json sessions advertise
 * flavor `cursor` but cannot steer, including pre-ACP sessions with only an id.
 * Native admission and remote-control checks remain the caller's responsibility.
 */
export function isSteeringSupportedForSession(metadata?: SteeringSessionMetadata | null): boolean {
    const capability = getSteeringCapability(metadata?.flavor)
    return capability !== null && (capability.supportsSession?.(metadata ?? {}) ?? true)
}

/**
 * Whether the provider reports an active steerable turn. This does not imply
 * that the session is active, remotely controlled, or will accept a native steer.
 */
export function hasActiveSteeringTurn(session: SteeringSessionState): boolean {
    if (!isSteeringSupportedForSession(session.metadata)) return false
    return getSteeringCapability(session.metadata?.flavor)?.activeTurnState === 'thinking'
        ? session.thinking === true
        : session.agentState?.steeringActive === true
}

export function getPermissionModesForFlavor(flavor?: string | null): readonly PermissionMode[] {
    return traitsOf(flavor).permissionModes
}

export function isPermissionModeAllowedForFlavor(mode: PermissionMode, flavor?: string | null): boolean {
    return getPermissionModesForFlavor(flavor).includes(mode)
}
