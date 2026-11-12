import type { AgentState } from '@/types/api'
import type { ChatBlock, NormalizedMessage, NormalizedAgentContent } from '@/chat/types'
import { reduceChatBlocks, getLatestThreadGoal, type ReduceChatBlocksOptions } from '@/chat/reducer'
import { getPermissions, isChangeTitleToolName } from '@/chat/reducerTools'
import { dedupeAgentEvents, foldApiErrorEvents } from '@/chat/reducerEvents'
import { mergeCliOutputBlocks } from '@/chat/reducerCliOutput'
import { isSubagentToolName } from '@/chat/subagentTool'
import { asString } from '@hapi/protocol'

export type ReduceChatBlocksResult = ReturnType<typeof reduceChatBlocks>

/**
 * Incremental state for the tail-append fast path of the chat block reducer.
 *
 * `reduceChatBlocks` is a full O(n) pass over the windowed transcript. During
 * streaming the window grows by a few rows every few hundred milliseconds, so
 * most passes re-derive the exact same blocks for the unchanged prefix. This
 * state remembers the last reduction plus the identities that decide whether a
 * newly appended message can only *add* trailing blocks, letting the caller
 * skip the prefix entirely.
 */
export type TailAppendReduceState = {
    sessionId: string
    /** Last input array; kept by identity so appends can be detected. */
    normalized: NormalizedMessage[]
    agentState: AgentState | null | undefined
    result: ReduceChatBlocksResult
    /** Reducer option that is not derivable from the message list; a change
     * must invalidate the append-only fast path. */
    pendingRequestTargetId?: string
    /** Every id that keys a tool block in reduceTimeline's toolBlocksById
     * registry — tool-call ids *and* tool-result tool_use_ids (a result can
     * arrive before its call and seed the block). A repeat means a re-sent
     * tool_use that merges into an existing block (permission re-prompt flows
     * do this). */
    toolCallIds: Set<string>
    /** Every non-blank text/reasoning stream id seen so far; a repeat means a
     * snapshot that updates an earlier block in place. */
    streamIds: Set<string>
}

export function createTailAppendReduceState(
    sessionId: string,
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined,
    result: ReduceChatBlocksResult,
    pendingRequestTargetId?: string
): TailAppendReduceState {
    const toolCallIds = new Set<string>()
    const streamIds = new Set<string>()
    collectAppendIdentities(normalized, toolCallIds, streamIds)
    return { sessionId, normalized, agentState, result, toolCallIds, streamIds, pendingRequestTargetId }
}

function collectAppendIdentities(
    messages: NormalizedMessage[],
    toolCallIds: Set<string>,
    streamIds: Set<string>
): void {
    for (const message of messages) {
        if (message.role !== 'agent') continue
        for (const part of message.content) collectPartIdentity(part, toolCallIds, streamIds)
    }
}

function collectPartIdentity(
    part: NormalizedAgentContent,
    toolCallIds: Set<string>,
    streamIds: Set<string>
): void {
    if (part.type === 'tool-call' || part.type === 'tool-result') {
        toolCallIds.add(part.type === 'tool-call' ? part.id : part.tool_use_id)
        return
    }
    if (part.type === 'text' || part.type === 'reasoning') {
        const streamId = nonBlankStreamId(part.streamId)
        if (streamId) streamIds.add(streamId)
    }
}

// Mirrors nonBlank() in reducerTimeline.ts: blank values are not streams.
function nonBlankStreamId(value: unknown): string | null {
    const raw = asString(value)
    return raw !== null && raw.trim().length > 0 ? raw : null
}

const SENTINEL_REPLIES = new Set(['No response requested.', 'No response requested'])

function isSentinelAutoReply(message: NormalizedMessage): boolean {
    if (message.role !== 'agent' || message.content.length !== 1) return false
    const part = message.content[0]
    if (part.type !== 'text' || part.parentUUID === null) return false
    return SENTINEL_REPLIES.has(part.text.trim())
}

/**
 * Whether processing `appended` after the remembered prefix can only append
 * trailing blocks. Every guard here mirrors a backward-attaching mechanism in
 * reduceTimeline/reduceChatBlocks; when in doubt we return false and the caller
 * falls back to the exact full reduction. Conservative correctness first.
 */
function canAppendWithoutPrefixChanges(
    appended: NormalizedMessage[],
    state: TailAppendReduceState
): boolean {
    for (const message of appended) {
        // Sidechain rows (and their tracer grouping/orphan adoption) attach to
        // a Task card in the prefix; full reduction required.
        if (message.isSidechain) return false
        // Sentinel auto-replies are suppressed only when their parentUUID maps
        // to an injected sidechain turn, which may live in the prefix.
        if (isSentinelAutoReply(message)) return false

        if (message.role === 'event') {
            const type = message.content.type
            // These patch *earlier* blocks: usage summaries attach to the
            // latest group, durations target earlier blocks, and codex
            // agent-run events fold into an earlier card by card/agent id.
            if (
                type === 'token-count'
                || type === 'turn-summary'
                || type === 'turn-duration'
                || type === 'agent-run-start'
                || type === 'agent-run-update'
                || type === 'agent-run-trace'
            ) {
                return false
            }
            continue
        }

        if (message.role !== 'agent') continue

        for (const part of message.content) {
            // A tool result merges into the earlier tool-call block (which may
            // live in the prefix) and can also emit title changes for it.
            if (part.type === 'tool-result') return false
            if (part.type === 'tool-call') {
                // Title tool calls interact with a title-change scan across
                // the whole array; keep them on the full path.
                if (isChangeTitleToolName(part.name)) return false
                // A Task/Agent call registers itself in the tracer pre-scan
                // and can adopt *prefix* sidechain rows into its children
                // (parentToolUseId or prompt match), re-parenting them.
                if (isSubagentToolName(part.name)) return false
                // A repeated call id merges into an existing (possibly prefix)
                // block — permission re-prompt flows re-send tool_use rows.
                if (state.toolCallIds.has(part.id)) return false
                continue
            }
            if (part.type === 'text' || part.type === 'reasoning') {
                // A repeated stream id updates an earlier block in place.
                const streamId = nonBlankStreamId(part.streamId)
                if (streamId && state.streamIds.has(streamId)) return false
                continue
            }
        }
    }
    return true
}

function hasPendingPermissions(agentState: AgentState | null | undefined): boolean {
    for (const entry of getPermissions(agentState).values()) {
        if (entry.permission.status === 'pending') return true
    }
    return false
}

function isIdentityPrefix(previous: NormalizedMessage[], next: NormalizedMessage[]): boolean {
    if (next.length < previous.length) return false
    for (let index = 0; index < previous.length; index += 1) {
        if (previous[index] !== next[index]) return false
    }
    return true
}

function isSeamRelevant(block: ChatBlock): boolean {
    return block.kind === 'agent-event' || block.kind === 'cli-output'
}

/**
 * Re-run the adjacency-sensitive block passes over the seam between the
 * previous blocks and the freshly appended ones.
 *
 * mergeCliOutputBlocks / dedupeAgentEvents / foldApiErrorEvents only interact
 * across *adjacent* blocks of their kind, and their scan state resets at any
 * other block kind. The previous and appended lists have already been through
 * the passes individually, so only a trailing run on one side meeting a
 * leading run on the other can produce a different outcome than the full
 * reduction would. Re-running the composed passes over exactly that window
 * reproduces the full-pass result.
 */
function stitchSeam(previous: ChatBlock[], appended: ChatBlock[]): ChatBlock[] {
    let tailStart = previous.length
    while (tailStart > 0 && isSeamRelevant(previous[tailStart - 1])) {
        tailStart -= 1
    }
    let headEnd = 0
    while (headEnd < appended.length && isSeamRelevant(appended[headEnd])) {
        headEnd += 1
    }
    if (tailStart === previous.length || headEnd === 0) {
        // No adjacent same-kind blocks across the seam; nothing to redo.
        return [...previous, ...appended]
    }
    const window = [...previous.slice(tailStart), ...appended.slice(0, headEnd)]
    // Same composition and order as reduceChatBlocks: mergeCliOutputBlocks runs
    // inside reduceTimeline, then foldApiErrorEvents, then dedupeAgentEvents
    // (filterSilentGoalBlocks is per-block and needs no seam pass).
    const processed = dedupeAgentEvents(foldApiErrorEvents(mergeCliOutputBlocks(window)))
    return [
        ...previous.slice(0, tailStart),
        ...processed,
        ...appended.slice(headEnd)
    ]
}

export function reduceChatBlocksWithTailAppend(
    state: TailAppendReduceState | null,
    params: {
        sessionId: string
        normalized: NormalizedMessage[]
        agentState: AgentState | null | undefined
        goalStateMessages?: NormalizedMessage[]
        pendingRequestTargetId?: string
    }
): { result: ReduceChatBlocksResult; state: TailAppendReduceState } {
    const { sessionId, normalized, agentState } = params
    const goalSource = params.goalStateMessages ?? normalized

    const fullReduce = (): { result: ReduceChatBlocksResult; state: TailAppendReduceState } => {
        const options: ReduceChatBlocksOptions = {
            ...(params.goalStateMessages ? { goalStateMessages: params.goalStateMessages } : {}),
            ...(params.pendingRequestTargetId !== undefined ? { pendingRequestTargetId: params.pendingRequestTargetId } : {})
        }
        const result = reduceChatBlocks(normalized, agentState, options)
        return { result, state: createTailAppendReduceState(sessionId, normalized, agentState, result, params.pendingRequestTargetId) }
    }

    if (
        state === null
        || state.sessionId !== sessionId
        // Permission/agentState changes can alter prefix blocks (permission
        // merging, pending-card synthesis), so only identical agentState
        // references qualify.
        || state.agentState !== agentState
        || state.pendingRequestTargetId !== params.pendingRequestTargetId
        || !isIdentityPrefix(state.normalized, normalized)
        // Pending permission cards are synthesized against the whole window
        // and can be obsoleted by newly rendered tool blocks; stay exact.
        || hasPendingPermissions(agentState)
        || !canAppendWithoutPrefixChanges(normalized.slice(state.normalized.length), state)
    ) {
        return fullReduce()
    }

    const appended = normalized.slice(state.normalized.length)
    if (appended.length === 0) {
        // Same window, fresh goal source: reuse the previous blocks (identity
        // preserved downstream) and only refresh the goal.
        const latestGoal = getLatestThreadGoal(goalSource)
        if (latestGoal === state.result.latestGoal) {
            return { result: state.result, state }
        }
        const result = { ...state.result, latestGoal }
        return { result, state: { ...state, result } }
    }

    // The suffix reduction is self-contained: every backward-attaching
    // mechanism has either been ruled out above or resolves within the suffix.
    // Goal state comes from the full-array scan instead (cheap, allocation
    // free) because goal events look backwards across the whole window.
    const suffix = reduceChatBlocks(appended, agentState)
    const result: ReduceChatBlocksResult = {
        blocks: stitchSeam(state.result.blocks, suffix.blocks),
        hasReadyEvent: state.result.hasReadyEvent || suffix.hasReadyEvent,
        latestUsage: suffix.latestUsage ?? state.result.latestUsage,
        latestGoal: getLatestThreadGoal(goalSource)
    }
    const toolCallIds = new Set(state.toolCallIds)
    const streamIds = new Set(state.streamIds)
    collectAppendIdentities(appended, toolCallIds, streamIds)
    return {
        result,
        state: { sessionId, normalized, agentState, result, toolCallIds, streamIds }
    }
}
