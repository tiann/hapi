package app.hapi.companion.feature.newsession

import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.catalog.PermissionModes
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.SpawnSessionRequest
import kotlinx.serialization.Serializable

/**
 * New-session form model + the pure mapping/validation logic around it.
 * Everything here is Android-free so JVM tests can assert the exact spawn
 * body against `SpawnSessionRequestSchema`. Web reference:
 * `web/src/components/NewSession/index.tsx` (`handleCreate`).
 */
@Serializable
data class NewSessionForm(
    val machineId: String? = null,
    val directory: String = "",
    /** Flavor id from [AgentFlavor.CREATABLE]. */
    val agent: String = "claude",
    /** `'auto'` = no explicit model (claude presets / codex catalog ids). */
    val model: String = "auto",
    /** Claude launch effort; `'auto'` = omit. */
    val effort: String = "auto",
    /** Codex reasoning effort; `'default'` = omit. */
    val modelReasoningEffort: String = "default",
    /** Native permission mode for grok + codex-family flavors. */
    val permissionMode: String = "default",
    /** HAPI YOLO preference for the remaining flavors (claude/agy/cursor/pi). */
    val yolo: Boolean = false,
    /** `'simple' | 'worktree'`. */
    val sessionType: String = SESSION_TYPE_SIMPLE,
    val worktreeName: String = "",
    /** `'standard' | 'fast'` (codex; only sent while the fast tier is visible). */
    val serviceTier: String = "standard",
    /** `'default' | 'plan'` (codex). */
    val collaborationMode: String = "default",
    /** `'interactive' | 'plan' | 'autopilot'` (copilot; always sent for copilot). */
    val copilotAgentMode: String = "interactive",
) {
    val trimmedDirectory: String get() = directory.trim()
}

const val SESSION_TYPE_SIMPLE = "simple"
const val SESSION_TYPE_WORKTREE = "worktree"

object NewSessionLogic {

    /**
     * Flavors sharing the codex-style native permission select
     * (`web/src/lib/codexFamilyPermissionAgents.ts`). Gemini is listed for
     * completeness though it is not creatable.
     */
    val CODEX_FAMILY_PERMISSION_AGENTS = setOf("codex", "gemini", "kimi", "copilot", "opencode")

    fun usesCodexFamilyPermissionModes(flavor: String?): Boolean =
        flavor in CODEX_FAMILY_PERMISSION_AGENTS

    /** Flavors whose permission control is the native-mode select. */
    fun usesNativePermissionSelect(flavor: String?): Boolean =
        flavor == "grok" || usesCodexFamilyPermissionModes(flavor)

    /**
     * Exact spawn body (`POST /api/machines/:id/spawn`), field-for-field port
     * of the web `handleCreate` mapping:
     * - `model`/`effort` only for flavors whose picker exists in this v1
     *   (claude static list, codex machine catalog; others send no model);
     * - `yolo` for non-grok/non-codex-family flavors — **including `false`**;
     * - `permissionMode` for grok + codex-family — including `'default'`;
     * - `sessionType` always; `worktreeName` only for worktree and non-blank;
     * - `serviceTier` only while the codex fast tier is visible (then also
     *   `'standard'`); `collaborationMode` only when not `'default'`;
     * - `copilotAgentMode` always for copilot;
     * - `startingMode` omitted = the runner's `'remote'` default (v1 fixes
     *   remote; pty is deferred, matching the web create form).
     */
    fun buildSpawnRequest(form: NewSessionForm, codexFastTierVisible: Boolean): SpawnSessionRequest {
        val agent = form.agent
        val codexFamily = usesCodexFamilyPermissionModes(agent)
        val isGrok = agent == "grok"
        val resolvedModel = when {
            // v1 model pickers: claude (static presets) and codex (machine
            // catalog). Other flavors' discovery endpoints are TODO(M3d+),
            // so their model is never sent.
            (agent == "claude" || agent == "codex") && form.model != "auto" -> form.model
            else -> null
        }
        return SpawnSessionRequest(
            directory = form.trimmedDirectory,
            agent = agent,
            model = resolvedModel,
            effort = if (agent == "claude" && form.effort != "auto") form.effort else null,
            modelReasoningEffort = if (agent == "codex" && form.modelReasoningEffort != "default") {
                form.modelReasoningEffort
            } else {
                null
            },
            yolo = if (agent == "dsh" || isGrok || codexFamily) null else form.yolo,
            permissionMode = if (isGrok || codexFamily) form.permissionMode else null,
            sessionType = form.sessionType,
            worktreeName = if (form.sessionType == SESSION_TYPE_WORKTREE) {
                form.worktreeName.trim().ifEmpty { null }
            } else {
                null
            },
            serviceTier = if (agent == "codex" && codexFastTierVisible) form.serviceTier else null,
            collaborationMode = if (agent == "codex" && form.collaborationMode != "default") {
                form.collaborationMode
            } else {
                null
            },
            copilotAgentMode = if (agent == "copilot") form.copilotAgentMode else null,
            startingMode = null,
        )
    }

    // ------------------------------------------------------- autocomplete --

    /** Parent listing target for the autocomplete dropdown. */
    data class ParentQuery(
        /** Absolute directory to `POST list-directory`. */
        val parent: String,
        /** Typed tail the entries are prefix-filtered by (case-insensitive). */
        val prefix: String,
        /** Separator used by the typed path; suggestions preserve it. */
        val separator: String = "/",
    )

    /**
     * Derives the list-directory request from the typed text: list the parent
     * of the path segment being typed. Only absolute paths autocomplete
     * (the hub lists runner-local absolute paths).
     *
     * `/data/gi` → list `/data`, prefix `gi`; `/data/` → list `/data`, no
     * prefix; `/` → list `/`; relative text → null (no request).
     */
    fun parentQuery(input: String): ParentQuery? {
        val text = input.trim()
        val isPosix = text.startsWith("/")
        val isDrive = Regex("^[A-Za-z]:[\\\\/].*").matches(text)
        val isUnc = text.startsWith("\\\\") || text.startsWith("//")
        if (!isPosix && !isDrive && !isUnc) return null

        val lastForward = text.lastIndexOf('/')
        val lastBackward = text.lastIndexOf('\\')
        val separatorIndex = maxOf(lastForward, lastBackward)
        if (separatorIndex < 0) return null
        val separator = text[separatorIndex].toString()
        val rawParent = text.substring(0, separatorIndex)
        val parent = when {
            separatorIndex == 0 -> separator
            Regex("^[A-Za-z]:$").matches(rawParent) -> rawParent + separator
            rawParent.isEmpty() && isUnc -> separator + separator
            else -> rawParent
        }
        return ParentQuery(
            parent = parent,
            prefix = text.substring(separatorIndex + 1),
            separator = separator,
        )
    }

    /**
     * Joins a listed entry back into a full suggestion path, then filters
     * to directories matching the typed prefix, capped like the web (8).
     */
    fun buildSuggestions(
        query: ParentQuery,
        entries: List<app.hapi.protocol.wire.MachineDirectoryEntry>,
        limit: Int = 8,
    ): List<String> {
        val base = if (query.parent.endsWith('/') || query.parent.endsWith('\\')) {
            query.parent
        } else {
            query.parent + query.separator
        }
        return entries.asSequence()
            .filter { it.type == "directory" }
            .filter { it.name.startsWith(query.prefix, ignoreCase = true) }
            .map { "$base${it.name}" }
            .take(limit)
            .toList()
    }

    // ------------------------------------------------------- recent paths --

    /** LRU cap per machine (web caps at 5; native chips fit a couple more). */
    const val MAX_RECENT_PATHS = 8

    /** Dedupe-to-front LRU push (web `addRecentPath`). Blank input is a no-op. */
    fun pushRecent(existing: List<String>, path: String, cap: Int = MAX_RECENT_PATHS): List<String> {
        val trimmed = path.trim()
        if (trimmed.isEmpty()) return existing
        return (listOf(trimmed) + existing.filter { it != trimmed }).take(cap)
    }

    // ---------------------------------------------------------- worktree --

    /**
     * Client-side worktree-name check. The runner slugs the name to
     * `[a-z0-9-]` (`cli/src/runner/worktree.ts` `toSlug`); a name with no
     * alphanumeric characters slugs to nothing and the spawn fails server
     * side, so reject it up front. Empty is fine — the runner generates a
     * `MMDD-xxxx` default.
     */
    fun worktreeNameError(name: String): String? {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return null
        return if (trimmed.none { it.isLetterOrDigit() }) {
            "Name needs at least one letter or digit"
        } else {
            null
        }
    }

    // ------------------------------------------------------ codex catalog --

    /** Active catalog entry for [model] (`'auto'` → the default row). */
    fun resolveCodexModel(models: List<CodexModelSummary>, model: String): CodexModelSummary? {
        val normalized = model.trim()
        if (normalized.isEmpty() || normalized == "auto") {
            return models.firstOrNull { it.isDefault } ?: models.firstOrNull()
        }
        return models.firstOrNull { it.id == normalized }
    }

    /**
     * `codexModelAdvertisesFastTier`: the fast-mode control only appears when
     * the active model's catalog row advertises a fast service tier. Empty
     * catalog → hidden (no authoritative answer yet).
     */
    fun codexModelAdvertisesFastTier(model: String, models: List<CodexModelSummary>): Boolean {
        if (models.isEmpty()) return false
        val normalized = model.trim().lowercase()
        val active = if (normalized.isNotEmpty() && normalized != "auto") {
            models.firstOrNull { it.id.trim().lowercase() == normalized }
        } else {
            models.firstOrNull { it.isDefault }
        }
        return active?.serviceTiers?.any { it.trim().contains("fast", ignoreCase = true) } == true
    }

    /**
     * Supported reasoning efforts of the active codex model, normalized
     * (trim/lowercase/dedupe — `getCodexModelReasoningEfforts`); null when the
     * catalog does not advertise any (fall back to the static list).
     */
    fun codexReasoningEfforts(models: List<CodexModelSummary>, model: String): List<String>? {
        val efforts = resolveCodexModel(models, model)?.supportedReasoningEfforts ?: return null
        val normalized = efforts.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
        return normalized.ifEmpty { null }
    }

    // ------------------------------------------------------------- drafts --

    /**
     * Draft sanitization on restore (web `loadNewSessionFormDraft`): an
     * uncreatable/unknown agent coerces to claude and drops the
     * agent-dependent fields; a permission mode outside the flavor's catalog
     * resets to default.
     */
    fun sanitizeDraft(draft: NewSessionForm): NewSessionForm {
        val creatable = AgentFlavor.CREATABLE.any { it.id == draft.agent }
        val base = if (creatable) draft else NewSessionForm(
            machineId = draft.machineId,
            directory = draft.directory,
            agent = "claude",
            yolo = draft.yolo,
            sessionType = draft.sessionType,
            worktreeName = draft.worktreeName,
        )
        val allowedModes = PermissionModes.forFlavor(base.agent).map { it.wireId }
        val sessionType = if (base.sessionType == SESSION_TYPE_WORKTREE) SESSION_TYPE_WORKTREE else SESSION_TYPE_SIMPLE
        return base.copy(
            permissionMode = if (base.permissionMode in allowedModes) base.permissionMode else "default",
            serviceTier = if (base.serviceTier == "fast") "fast" else "standard",
            collaborationMode = if (base.collaborationMode == "plan") "plan" else "default",
            copilotAgentMode = app.hapi.protocol.catalog.CopilotAgentMode.normalize(base.copilotAgentMode).wireId,
            sessionType = sessionType,
        )
    }
}
