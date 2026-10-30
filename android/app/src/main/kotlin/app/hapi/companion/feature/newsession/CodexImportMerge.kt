package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CodexDuplicateSessionGroup

/**
 * Pure helpers of the duplicate-merge leg (slice B), ported from
 * `web/src/components/NewSession/codexImportMerge.ts` plus the error
 * normalizers of `web/src/components/NewSession/index.tsx`
 * (`normalizeCodexScriptError` / `formatCodexImportFailure`). Android-free so
 * JVM tests pin the exact semantics.
 */
object CodexImportMerge {

    /**
     * Where navigation should land after a duplicate merge: the first group
     * with a canonical survivor, else the first imported Hapi session id,
     * else null (web `resolveCodexImportRedirectSessionId`; an empty-string
     * canonical id does not count, mirroring `Boolean(group.canonicalSessionId)`).
     */
    fun resolveCodexImportRedirectSessionId(
        merged: List<CodexDuplicateSessionGroup>,
        importedHapiSessionIds: List<String>,
    ): String? =
        merged.firstOrNull { !it.canonicalSessionId.isNullOrEmpty() }?.canonicalSessionId
            ?: importedHapiSessionIds.firstOrNull()

    /**
     * `normalizeCodexScriptError`: blank → [fallback]; timeout / active-thread
     * / launcher-not-found errors classify into their localized strings;
     * anything else passes through raw.
     */
    fun normalizeCodexScriptError(message: String?, fallback: String, strings: CodexImportStrings): String {
        val raw = message?.trim().orEmpty()
        if (raw.isEmpty()) return fallback
        if (TIMEOUT_PATTERN.containsMatchIn(raw)) return strings.timeout
        if (ACTIVE_PATTERN.containsMatchIn(raw)) return strings.sessionActive
        if (NOT_FOUND_PATTERN.containsMatchIn(raw)) return strings.clientNotFound
        return raw
    }

    /**
     * `formatCodexImportFailure`: the three classified messages pass through
     * (they are already user-facing); every other reason is wrapped into
     * `codexSync.failed.bodyWithReason`.
     */
    fun formatCodexImportFailure(reason: String, strings: CodexImportStrings): String =
        if (reason == strings.timeout || reason == strings.sessionActive || reason == strings.clientNotFound) {
            reason
        } else {
            strings.importFailedReason.format(reason)
        }

    /** `normalizeCodexScriptError` timeout pattern (`/i`). */
    val TIMEOUT_PATTERN: Regex =
        Regex("""执行超时|timed\s*out|timeout""", RegexOption.IGNORE_CASE)

    /** `normalizeCodexScriptError` active-thread pattern (`/i`). */
    val ACTIVE_PATTERN: Regex =
        Regex("""当前会话仍处于活跃状态，请等待会话结束后重试|Active Hapi process already has this Codex thread""", RegexOption.IGNORE_CASE)

    /**
     * `normalizeCodexScriptError` launcher-not-found pattern (`/i`); JS `\/`
     * is a plain `/`. Belonged to the restart feature and was deliberately
     * absent in slice A — added with it here (slice B).
     */
    val NOT_FOUND_PATTERN: Regex =
        Regex("""未安装/找不到codex客户端|unable to find codex launcher|找不到.*codex""", RegexOption.IGNORE_CASE)
}
