/**
 * Shared types for the multi-flavor agent-session import surface.
 *
 * The codex flavor (web/src/components/CodexSessionSyncDialog.tsx +
 * hub/src/web/routes/codexDesktop.ts) already shipped upstream in
 * `tiann/hapi#796`. This module factors out the small surface the dialog
 * needs to render a per-flavor row generically so the cursor flavor (and
 * future claude / gemini / opencode flavors) can reuse the same UI shape
 * without one-off type drift.
 *
 * Hub-side parallel routes (`/codex/*` and `/cursor/*`) remain alongside
 * each other rather than being collapsed into a generic
 * `/api/agent-sessions/...` so each flavor keeps its own refusal vocabulary
 * and row shape.
 */

/** Agent flavors supported by the import dialog. */
export type AgentImportFlavor = 'codex' | 'cursor'

/**
 * Source format of an importable cursor session as discovered on disk.
 *
 * The strict refusal contract (see `cursorImporter`) only ships ACP-mode
 * HAPI rows. `legacy` sessions are transplanted via the `agent acp`
 * verify-probe before being given a HAPI row; if the probe refuses, the
 * row is never created and the legacy `store.db` is not touched.
 *
 * `acp` sessions are imported by reading the existing
 * `~/.cursor/acp-sessions/<uuid>/` directory directly (no transplant).
 */
export type CursorImportSourceFormat = 'legacy' | 'acp'

/**
 * Mirrors `tiann/hapi#824`'s `CursorMigrateRefusalReason` (defined in
 * shared/src/apiTypes.ts) plus the few import-only cases that the
 * migrator does not produce because it always operates on a pre-existing
 * HAPI session.
 */
export type CursorImportRefusalReason =
    | 'verify_load_failed'
    | 'missing_on_disk_store'
    | 'target_already_exists'
    | 'already_imported'
    | 'agent_binary_not_found'
    | 'verify_timeout'
    | 'corrupted_store'
    | 'ambiguous_legacy_store'
    | 'internal_error'

/** Per-row metadata returned by `GET /api/cursor/importable-sessions`. */
export interface CursorImportableSessionSummary {
    /** The cursor sessionId (UUID-ish basename of the on-disk dir). */
    id: string
    /** Best-effort display title — chat name from meta record, or "Untitled". */
    title: string
    /** First user message from the store, when readable. */
    firstUserMessage?: string | null
    /** Absolute workspace path the chat was opened against. */
    workspacePath?: string | null
    /** Absolute path of the on-disk `store.db` we read this row from. */
    storeDbPath: string
    /** Source format: legacy needs verify+transplant; acp imports as-is. */
    sourceFormat: CursorImportSourceFormat
    /** mtime of the on-disk `store.db`. */
    modifiedAt: number
    /** Size of the on-disk `store.db` in bytes. */
    sizeBytes: number
    /**
     * Set to the HAPI sessionId when a HAPI session row in this namespace
     * already references this cursor uuid. Dialog renders such rows as
     * read-only chips ("already imported") and refuses to re-import.
     */
    alreadyImportedHapiSessionId?: string | null
}

export interface CursorImportableSessionsResponse {
    success: true
    sessions: CursorImportableSessionSummary[]
}

/** Per-row import result. The `import` endpoint returns one of these per uuid. */
export type CursorImportRowOutcome =
    | {
        ok: true
        uuid: string
        hapiSessionId: string
        sourceFormat: CursorImportSourceFormat
        durationMs: number
    }
    | {
        ok: false
        uuid: string
        reason: CursorImportRefusalReason
        message: string
        durationMs: number
    }

export interface CursorImportSelection {
    uuid: string
    /**
     * Per-row workspace path from discovery. Required for legacy drawers that
     * can land under multiple `<wsh>` hashes; also used so import metadata
     * keeps a resumable `path` instead of `''`.
     */
    workspacePath?: string | null
}

export interface CursorImportRequest {
    /**
     * Preferred shape: one entry per selected row with its discovered
     * workspace path. Takes precedence over `uuids` when present.
     */
    selections?: CursorImportSelection[]
    /**
     * Legacy batch shape (uuid-only). Prefer `selections` so legacy imports
     * do not lose the workspace path the importer needs to resume.
     */
    uuids?: string[]
    /**
     * Optional global workspace path applied to every uuid when using the
     * legacy `uuids` shape (or as a fallback when a selection omits its own).
     */
    workspacePath?: string | null
}

export interface CursorImportResponse {
    success: true
    results: CursorImportRowOutcome[]
    importedCount: number
}
