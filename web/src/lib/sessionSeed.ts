import { isKnownFlavor } from '@hapi/protocol'
import type { Metadata, Session, SessionSummary } from '@/types/api'

/**
 * Zero-RTT session detail seed.
 *
 * Clicking a list row navigates to `/sessions/:id`, whose first paint gates on
 * `useSession` having data. On high-RTT links the detail GET costs one full
 * round trip (~350-450ms) during which the page shows "Loading session…"
 * even though the sessions list already holds a (slim) row for the same id.
 * `useSession` seeds its cache from that row via this mapper, so SessionChat
 * renders instantly and the detail GET (which still fires) overwrites the
 * seed when it lands.
 *
 * Input is a `SessionSummary` *as stored in the sessions list cache*: with
 * `view=slim` (the only mode the list requests, see `useSessions`) rows are
 * runtime-subsets — detail-only fields are absent and empty-default fields
 * are omitted entirely. Every read below therefore goes through `??` so an
 * absent key collapses to the same value the full payload would carry at its
 * default. Fields no list row ever carries (`agentState`, `todos`,
 * `namespace`, …) are materialized as their schema defaults / undefined; the
 * first-screen consumers in SessionChat / SessionHeader access all of them
 * through optional chaining or nullable schema types (`agentState: null` is a
 * legal detail state too), so the seed renders without fallbacks firing.
 */

/** The per-flavor metadata slots that hold the native agent session id.
 *  Intersected with `keyof Metadata` so every name is checked against the
 *  real schema (a typo collapses to never and fails the map below). */
type AgentSessionIdField =
    | 'claudeSessionId' | 'codexSessionId' | 'geminiSessionId' | 'opencodeSessionId'
    | 'grokSessionId' | 'agySessionId' | 'cursorSessionId' | 'kimiSessionId'
    | 'copilotSessionId' | 'piSessionId' | 'dshSessionId'

/** Reverse of shared `getSummaryAgentSessionId`: the per-flavor metadata slot
 *  the list's derived `metadata.agentSessionId` was flattened from. Restoring
 *  it lets detail-path readers (`resolveAgentSessionIdFromMetadata`) answer
 *  resumability identically from the seed and from the full payload. Mirrors
 *  the shared map plus zcode (kept aligned with the web reader; the shared
 *  forward map does not derive it today, so the entry is inert until it
 *  does). */
const AGENT_SESSION_ID_FIELD_BY_FLAVOR: Partial<Record<string, AgentSessionIdField & keyof Metadata>> = {
    claude: 'claudeSessionId',
    codex: 'codexSessionId',
    gemini: 'geminiSessionId',
    opencode: 'opencodeSessionId',
    grok: 'grokSessionId',
    agy: 'agySessionId',
    cursor: 'cursorSessionId',
    kimi: 'kimiSessionId',
    copilot: 'copilotSessionId',
    pi: 'piSessionId',
    dsh: 'dshSessionId'
}

/** Summary metadata → full `Metadata` projection. Summary-only keys
 *  (`agentSessionId`, hoisted `conversationHistory`) are folded back into
 *  their Metadata-native locations; everything else passes through. Fields
 *  the summary never carries (`host`, `capabilities`, flavor ids other than
 *  the session's own, diagnostics-only `lastModelError` sub-fields, …) stay
 *  absent — first-screen readers access them optional-chained. */
function seedMetadata(summaryMetadata: SessionSummary['metadata']): Metadata | null {
    if (!summaryMetadata) {
        return null
    }
    const { agentSessionId, conversationHistory: _conversationHistory, ...rest } = summaryMetadata
    const metadata = { ...rest } as Metadata
    // Unknown/absent flavor resolves to the claude slot, mirroring
    // `resolveAgentSessionIdFromMetadata`'s fallback.
    const flavor = isKnownFlavor(summaryMetadata.flavor) ? summaryMetadata.flavor : 'claude'
    if (agentSessionId?.trim()) {
        const field = AGENT_SESSION_ID_FIELD_BY_FLAVOR[flavor]
        if (field) {
            metadata[field] = agentSessionId.trim()
        }
    }
    return metadata
}

/** Build the minimal renderable `Session` for a sessions-list row (slim or
 *  full). Pure; safe on rows missing any optional key. */
export function sessionSeedFromSummary(summary: SessionSummary): Session {
    return {
        // Carried from the row when present (slim omits these only at their
        // empty default, so the ?? fallback matches the omitted value).
        contentRevision: summary.contentRevision,
        readState: summary.readState,
        lastUserMessageAt: summary.lastUserMessageAt,
        hasConversationContent: summary.hasConversationContent ?? false,
        id: summary.id,
        createdAt: summary.createdAt ?? summary.updatedAt,
        updatedAt: summary.updatedAt,
        pinned: summary.pinned ?? false,
        globalPinned: summary.globalPinned ?? false,
        active: summary.active ?? false,
        // Slim omits activeAt entirely (nothing in the list reads it); 0 is
        // the schema default and SessionHeader's `activeAt || updatedAt`
        // fallback chain handles it like a legacy null.
        activeAt: summary.activeAt ?? 0,
        metadata: seedMetadata(summary.metadata),
        // Version watermarks are always present even in slim rows (the SSE
        // patch gates compare against them; omitting would drop patches).
        metadataVersion: summary.metadataVersion,
        agentStateVersion: summary.agentStateVersion,
        todosUpdatedAt: summary.todosUpdatedAt,
        thinking: summary.thinking ?? false,
        model: summary.model ?? null,
        modelReasoningEffort: summary.modelReasoningEffort ?? null,
        effort: summary.effort ?? null,
        backgroundTaskCount: summary.backgroundTaskCount ?? 0,
        derivedToolWork: summary.derivedToolWork,

        // Detail-only — no list row carries these. Values are the schema
        // defaults / undefined, which every first-screen consumer already
        // tolerates (nullable schema fields or optional-chained reads).
        namespace: '',
        seq: 0,
        agentState: null,
        thinkingAt: 0,
        activeTurnStartedAt: undefined,
        backgroundTasks: undefined,
        todos: undefined,
        teamState: undefined,
        teamStateUpdatedAt: undefined,
        serviceTier: null,
        permissionMode: undefined,
        collaborationMode: undefined,
        copilotAgentMode: undefined
    }
}
