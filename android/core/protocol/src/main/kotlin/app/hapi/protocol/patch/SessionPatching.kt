package app.hapi.protocol.patch

import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionPatch
import kotlin.math.abs
import kotlin.math.max

/**
 * Pure session-patch application — line-for-line port of
 * `web/src/lib/sessionPatch.ts` (the normative reference; also specified in
 * `docs/api/client-contract/sse.md` "Versioned patch algorithm").
 */

/**
 * Version-monotonicity gate for the versioned `metadata` / `agentState` /
 * `todos` / `teamState` sub-patches. **Strictly greater** only: the dual SSE
 * connections have no shared ordering, so the same version can arrive twice
 * and an older one after a newer one — applying either would regress state
 * (resurrected permission requests, rewound resume ids).
 */
fun isNewerVersionedPatch(patchVersion: Long, currentVersion: Long): Boolean {
    return patchVersion > currentVersion
}

/**
 * True when applying [patch] to [session] would change nothing that renders.
 *
 * Keep-alive patches re-send fields about every ~10 s with only `activeAt`
 * moving. Sub-minute `activeAt` deltas are ignored (relative-time labels only
 * change at minute boundaries); a delta of >= 60 s is still render-relevant.
 *
 * Port notes: the TS iterates `Object.entries(patch)` with `!==` — here each
 * present field is compared explicitly. A present versioned wrapper is always
 * relevant in TS (object identity), replicated with the `!= null` checks. A
 * present `scratchlistUpdatedAt` is always relevant ([Session] carries no such
 * field). Kotlin cannot distinguish an absent `activeTurnStartedAt` on the
 * cached session from an explicit `null` the way TS `undefined !== null` does;
 * the divergence is unobservable through [applySessionDetailPatch] because
 * that field is never assigned anyway.
 */
fun isRenderIrrelevantSessionPatch(session: Session, patch: SessionPatch): Boolean {
    patch.active?.let { if (session.active != it) return false }
    patch.thinking?.let { if (session.thinking != it) return false }
    if (patch.activeTurnStartedAt is OptionalField.Present
        && session.activeTurnStartedAt != patch.activeTurnStartedAt.value
    ) {
        return false
    }
    patch.activeAt?.let { if (abs(it - session.activeAt) >= 60_000) return false }
    patch.updatedAt?.let { if (session.updatedAt != it) return false }
    if (patch.metadata != null) return false
    if (patch.agentState != null) return false
    if (patch.todos != null) return false
    if (patch.teamState != null) return false
    if (patch.model is OptionalField.Present && session.model != patch.model.value) return false
    if (patch.modelReasoningEffort is OptionalField.Present
        && session.modelReasoningEffort != patch.modelReasoningEffort.value
    ) {
        return false
    }
    if (patch.effort is OptionalField.Present && session.effort != patch.effort.value) return false
    if (patch.serviceTier is OptionalField.Present && session.serviceTier != patch.serviceTier.value) return false
    patch.permissionMode?.let { if (session.permissionMode != it) return false }
    patch.collaborationMode?.let { if (session.collaborationMode != it) return false }
    patch.copilotAgentMode?.let { if (session.copilotAgentMode != it) return false }
    patch.backgroundTaskCount?.let { if (session.backgroundTaskCount != it) return false }
    if (patch.scratchlistUpdatedAt != null) return false
    return true
}

/**
 * Apply a validated [SessionPatch] onto a detail [Session]. Returns `null`
 * when nothing render-relevant changed (keep the prior object identity).
 * Field-by-field only — never wholesale-assign the versioned `{version,
 * value}` wrappers.
 *
 * Replicated exactly from the TS reference:
 * - flat fields (`active`, `thinking`, `activeAt`, `model`,
 *   `modelReasoningEffort`, `effort`, `serviceTier`, `permissionMode`,
 *   `collaborationMode`, `copilotAgentMode`, `backgroundTaskCount`) are
 *   last-write-wins when present; a present-`null` `model` /
 *   `modelReasoningEffort` / `effort` / `serviceTier` clears the field;
 * - `updatedAt` is max-monotonic (a rejected stale replay must not rewind it);
 * - versioned sub-patches apply only when strictly newer than the cached
 *   watermark (`todosUpdatedAt` / `teamStateUpdatedAt` treat absent as 0);
 * - **`activeTurnStartedAt` and `scratchlistUpdatedAt` are deliberately NOT
 *   applied** — the TS reference never assigns them (`scratchlistUpdatedAt`
 *   is a bare refetch trigger; `activeTurnStartedAt` only arrives with full
 *   session payloads). They still participate in the render-irrelevance
 *   check, matching `Object.entries` semantics.
 */
fun applySessionDetailPatch(session: Session, patch: SessionPatch): Session? {
    if (isRenderIrrelevantSessionPatch(session, patch)) {
        return null
    }
    var next = session
    var changed = false

    fun set(value: Session) {
        next = value
        changed = true
    }

    patch.active?.let { if (next.active != it) set(next.copy(active = it)) }
    patch.thinking?.let { if (next.thinking != it) set(next.copy(thinking = it)) }
    patch.activeAt?.let { if (next.activeAt != it) set(next.copy(activeAt = it)) }
    // Monotonic with hub applySessionPatch: a rejected stale
    // metadata/agentState replay must not rewind updatedAt.
    patch.updatedAt?.let {
        val nextUpdatedAt = max(next.updatedAt, it)
        if (next.updatedAt != nextUpdatedAt) set(next.copy(updatedAt = nextUpdatedAt))
    }
    val model = patch.model
    if (model is OptionalField.Present && next.model != model.value) {
        set(next.copy(model = model.value))
    }
    val modelReasoningEffort = patch.modelReasoningEffort
    if (modelReasoningEffort is OptionalField.Present && next.modelReasoningEffort != modelReasoningEffort.value) {
        set(next.copy(modelReasoningEffort = modelReasoningEffort.value))
    }
    val effort = patch.effort
    if (effort is OptionalField.Present && next.effort != effort.value) {
        set(next.copy(effort = effort.value))
    }
    val serviceTier = patch.serviceTier
    if (serviceTier is OptionalField.Present && next.serviceTier != serviceTier.value) {
        set(next.copy(serviceTier = serviceTier.value))
    }
    patch.permissionMode?.let { if (next.permissionMode != it) set(next.copy(permissionMode = it)) }
    patch.collaborationMode?.let { if (next.collaborationMode != it) set(next.copy(collaborationMode = it)) }
    patch.copilotAgentMode?.let { if (next.copilotAgentMode != it) set(next.copy(copilotAgentMode = it)) }
    patch.backgroundTaskCount?.let { if (next.backgroundTaskCount != it) set(next.copy(backgroundTaskCount = it)) }
    // Version gates: dual SSE can deliver duplicates out of order. Only mark
    // changed when a strictly newer version lands — otherwise keep the
    // previous object identity (no redundant render).
    patch.todos?.let {
        if (isNewerVersionedPatch(it.version, next.todosUpdatedAt ?: 0)) {
            set(next.copy(todos = it.value, todosUpdatedAt = it.version))
        }
    }
    patch.teamState?.let {
        if (isNewerVersionedPatch(it.version, next.teamStateUpdatedAt ?: 0)) {
            set(next.copy(teamState = it.value, teamStateUpdatedAt = it.version))
        }
    }
    patch.metadata?.let {
        if (isNewerVersionedPatch(it.version, next.metadataVersion)) {
            set(next.copy(metadata = it.value, metadataVersion = it.version))
        }
    }
    patch.agentState?.let {
        if (isNewerVersionedPatch(it.version, next.agentStateVersion)) {
            set(next.copy(agentState = it.value, agentStateVersion = it.version))
        }
    }
    return if (changed) next else null
}
