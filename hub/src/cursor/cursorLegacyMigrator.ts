/**
 * Legacy stream-json → ACP migrator (transplant strategy).
 *
 * See tiann/hapi#824 and docs/plans/2026-06-06-cursor-legacy-to-acp-spike.md
 * for the spike that established the design. Short version:
 *
 *   1. cursor-agent's `agent acp` resolves `session/load` against
 *      ~/.cursor/acp-sessions/<uuid>/{store.db, meta.json}.
 *   2. The legacy stream-json flow stores chats at
 *      ~/.cursor/chats/<workspace-hash>/<uuid>/store.db.
 *   3. The on-disk SQLite schema is byte-identical between the two stores
 *      (blobs content-addressed Merkle tree + meta key-value).
 *   4. Therefore: cp legacy store.db into the ACP location, synthesize the
 *      meta.json sidecar, verify session/load works, then flip HAPI's
 *      cursorSessionProtocol = 'acp' so the existing cursorAcpRemoteLauncher
 *      (already in #799) picks the session up on next resume.
 *
 * Per-session sequence (cp + verify + flip + rm):
 *   a) cp legacy store.db -> ~/.cursor/acp-sessions/<uuid>/store.db
 *   b) write meta.json sidecar
 *   c) verify by spawning `agent acp` in a temp $HOME pointing at a *copy*
 *      of the transplanted store, doing initialize + session/load + (optional)
 *      a trivial session/prompt
 *   d) ONLY if verify passes: flip cursorSessionProtocol in hapi.db, set
 *      session.model from legacy meta record's lastUsedModel, and rm the
 *      legacy source.
 *   e) If verify fails: rm the new ~/.cursor/acp-sessions/<uuid>/ entry,
 *      leave the legacy store untouched.
 *
 * The verify is staged in a temp $HOME so the verify session/prompt never
 * pollutes the operator's real acp-sessions store. After verify passes, the
 * real placement is just a fresh cp of the original legacy store.db.
 *
 * Per orchestrator policy (Q1 in the spike report):
 *   - cp + verify + rm; the rm is gated on observable success
 *   - --keep-source preserves the legacy store after success
 *   - --force-archive-then-migrate archives a running session first
 *
 * The fork-side launcher in cli/src/cursor/cursorAcpRemoteLauncher.ts already
 * routes on metadata.cursorSessionProtocol === 'acp' (set by this migrator).
 * No launcher change is required.
 */

import { join, dirname } from 'node:path'
import { homedir, hostname, tmpdir } from 'node:os'
import { mkdtempSync, copyFileSync, writeFileSync, existsSync, mkdirSync, rmSync, rmdirSync, statSync, readdirSync, readFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'

import type { CursorMigrateOutcome, CursorMigrateRefusalReason } from '@hapi/protocol/apiTypes'
import type { Metadata } from '@hapi/protocol/schemas'
import type { Session } from '@hapi/protocol/types'
import { AcpVerifyProbe, tryAcquireAcpActiveLock, type AcpActiveLockHandle } from './acpVerifyProbe'

/* ---------- types ---------- */

export interface CursorLegacyMigratorOptions {
    keepSource?: boolean
    forceArchiveRunning?: boolean
    skipVerify?: boolean
    /** Internal: max time to wait for a running session to release the store.db file lock after archive. */
    lockReleaseTimeoutMs?: number
    /** Internal: max time the verify spawn is allowed in total. */
    verifyTimeoutMs?: number
    /** Internal: the verify prompt body. Kept ultra-short to bound token cost. */
    verifyPromptText?: string
}

export interface CursorLegacyMigratorDeps {
    /** Resolve the operator's HOME dir. Override in tests. */
    homeDir?: () => string
    /**
     * Resolve the local hostname. Used to detect cross-host sessions
     * (where the recorded `metadata.host` does not match the machine the
     * hub is running on) — those sessions cannot be migrated because the
     * legacy ~/.cursor/chats files exist on a different machine.
     * Default: `process.env.HAPI_HOSTNAME || os.hostname()`. Codex
     * review #34 P2.
     */
    hostName?: () => string
    /**
     * Spawn factory for the verify probe. Override in tests to inject a mock probe.
     * The second arg is the session-owner home (`metadata.homeDir`) resolved by
     * `migrateOne`, which the default factory passes through to the probe as
     * `agentLookupHome` so service-account hub deployments resolve `agent` under
     * the human user's `~/.local/bin` rather than the hub user's. tiann/hapi#844
     * upstream Codex Major.
     */
    createProbe?: (env: NodeJS.ProcessEnv, agentLookupHome: string) => AcpVerifyProbe
    /**
     * Optional escape hatch for the operator-driven CLI/REST flow that wants
     * to reserve the global agent-acp-active lock for the entire migration
     * window. Returns `null` if the lock is already held; the migrator then
     * refuses with `acp_transport_active`.
     *
     * **Default in production: a no-op grant that never refuses.** The
     * verify probe's child agent CLI now runs with an isolated HAPI_HOME
     * (see verifyInTempHome), so the verify spawn does not race against any
     * live ACP transport on the host. Refusing migration up-front when the
     * host has other live transports — which is the common case on machines
     * running peer agents — would make the auto-migration path unreachable
     * for the operator who actually has 90+ legacy sessions to migrate.
     *
     * Tests can inject `() => null` to exercise the legacy refusal path.
     * Operator CLI/REST callers can inject `tryAcquireAcpActiveLock(home)`
     * if they want the conservative pre-isolation behavior back.
     */
    acquireAcpActiveLock?: () => { release(): void } | null
    /**
     * Run `PRAGMA wal_checkpoint(TRUNCATE)` on the legacy store.db.
     * Default: bun:sqlite checkpoint that refuses on busy=1 or partial
     * apply. Tests can inject a no-op to simulate a writer landing
     * between checkpoint return and the post-checkpoint fingerprint.
     * Codex review #34 P2 v8.
     */
    checkpointLegacyStore?: (storeDbPath: string) => void
    /** Where to allocate the verify staging temp dir. Default: os.tmpdir(). */
    tmpDir?: () => string
    /** Time source for telemetry. Default: Date.now. */
    now?: () => number
    /** Optional hook to archive a running session. Required when forceArchiveRunning=true. */
    archiveSession?: (sessionId: string) => Promise<void>
    /**
     * Wait for the archived session's store.db file lock to be released.
     * Default: combined SQLite busy-probe + size-stability + minimum dwell
     * time. The dwell is required because the hub cannot directly observe
     * the runner subprocess exiting (it has no PID handle); without a
     * minimum wait an idle runner with no SQLite write lock can pass the
     * probe immediately while still in the middle of SIGTERM cleanup.
     * Codex review #34 P1 v3.
     */
    awaitLockRelease?: (storePath: string, timeoutMs: number) => Promise<boolean>
    /**
     * Check whether ANY `agent acp` transport is registered as active in
     * $HAPI_HOME/locks/agent-acp-active. Cursor's `agent` binary enforces
     * single-instance semantics: spawning a second `agent acp` while one
     * is live can SIGTERM the live one. Refuse the migration in that case
     * because the verify-in-temp-HOME step would otherwise crash the
     * operator's active Cursor ACP session. Codex review #34 P1.
     * Default: read the lock dir under $HAPI_HOME (or tmpdir/hapi).
     */
    isAgentAcpTransportActive?: () => { active: boolean; holderPid: number | null }
    /**
     * Re-read the latest session state from the hub cache, used to detect
     * a resume that happened between preflight and the destructive steps.
     * SyncEngine injects a real implementation; tests can inject a static
     * sentinel. Codex review #34 P1: protects against the TOCTOU window
     * where a session is resumed while migration is in flight.
     */
    getCurrentSession?: (sessionId: string, namespace: string) => { active: boolean; lifecycleState?: string; cursorSessionProtocol?: string } | null
    /** Logger sink. Default: silent. */
    logger?: { debug: (msg: string, ctx?: unknown) => void; info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void }
    /** Used to update hapi.db sessions.metadata.cursorSessionProtocol = 'acp' and session.model. */
    updateSessionAfterMigrate?: (sessionId: string, namespace: string, lastUsedModel: string | null) => UpdateAfterMigrateResult
    /**
     * Best-effort count of messages HAPI has already synced for this session
     * (read from hapi.db, see hub/src/store/messages.ts). Used to refuse a
     * transplant when the candidate legacy store contains an order-of-
     * magnitude fewer blobs than HAPI's known history - the canonical
     * symptom of the #844 ambiguous-source regression where a sibling
     * workspace-hash drawer with stale or unrelated content gets picked
     * up by the readdir scan. Return 0 (or omit the dep) to disable the
     * sanity check entirely (e.g. unit tests, brand new sessions).
     *
     * Hub injects an implementation that calls
     * `store.messages.countMessages(sessionId)`. tiann/hapi#872.
     */
    getHapiMessageCount?: (sessionId: string, namespace: string) => number
}

export type UpdateAfterMigrateResult =
    | { ok: true }
    | { ok: false; reason: 'version_mismatch_or_missing' }
    | { ok: false; reason: 'session_active' }

export interface LegacyStoreLocation {
    workspaceHash: string
    storeDbPath: string
}

/**
 * One legacy store candidate found on disk for a given cursorSessionId.
 * Carried inside AmbiguousLegacyStoreError so callers and operators can
 * see the full picture (which workspace-hash drawer, how big, how recently
 * written) rather than a silently-picked first match.
 */
export interface LegacyStoreCandidate {
    workspaceHash: string
    storeDbPath: string
    sizeBytes: number
    mtimeMs: number
}

/**
 * Raised by findLegacyChatStore when the same cursorSessionId exists in
 * 2+ workspace-hash drawers AND the optional canonical-path probe did not
 * resolve the ambiguity. The migrator translates this to an
 * `ambiguous_legacy_store` refusal outcome so the caller can surface a
 * banner ("manually resolve") instead of transplanting an alien store.
 *
 * The first-match-wins behaviour shipped in #844 is exactly the bug we
 * are guarding against here - see tiann/hapi#872 for the postmortem.
 */
export class AmbiguousLegacyStoreError extends Error {
    public readonly cursorSessionId: string
    public readonly candidates: ReadonlyArray<LegacyStoreCandidate>
    constructor(cursorSessionId: string, candidates: ReadonlyArray<LegacyStoreCandidate>) {
        const hashList = candidates.map((c) => c.workspaceHash).join(', ')
        super(`cursor session ${cursorSessionId} exists in ${candidates.length} workspace-hash drawers and the canonical workspace path did not resolve to one of them: ${hashList}`)
        this.name = 'AmbiguousLegacyStoreError'
        this.cursorSessionId = cursorSessionId
        this.candidates = candidates
    }
}

/**
 * Compute the cursor workspace-hash for a cwd path. Cursor stores legacy
 * chats under `~/.cursor/chats/<md5(workspacePath)>/...`; this lets us
 * jump straight to the right drawer for the session's canonical path
 * instead of relying on readdir order. tiann/hapi#872.
 */
export function workspaceHashFromPath(workspacePath: string): string {
    return createHash('md5').update(workspacePath).digest('hex')
}

/* ---------- helpers ---------- */

const DEFAULT_VERIFY_PROMPT = 'Reply with exactly: ack'
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
const DEFAULT_LOCK_RELEASE_TIMEOUT_MS = 5_000
const DEFAULT_REPLAY_DRAIN_MS = 3_000
const AUTH_FILES = ['cli-config.json', 'agent-cli-state.json', 'acp-config.json']

function noopLogger() {
    return { debug() {}, info() {}, warn() {}, error() {} }
}

function refusal(sessionId: string, reason: CursorMigrateRefusalReason, message: string, start: number, now: () => number): CursorMigrateOutcome {
    return { ok: false, sessionId, reason, message, durationMs: now() - start }
}

/* ---------- public API ---------- */

/**
 * UUID-ish pattern: a cursor session id MUST be a basename that cannot
 * escape the chats/acp-sessions trees via path traversal.
 * Moved here so findLegacyChatStore and listLegacyChatStoreCandidates
 * can both reference it without a temporal-dead-zone hazard.
 * tiann/hapi#877 bot Minor.
 */
const CURSOR_SESSION_ID_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Resolve the on-disk legacy ~/.cursor/chats/<wsh>/<cursorSessionId>/store.db
 * for the given cursorSessionId.
 *
 * Cursor stores legacy chats under `~/.cursor/chats/<md5(workspacePath)>/...`,
 * keyed by the *cwd* the session was opened in. A single cursorSessionId can
 * land in several `<wsh>` drawers in the wild - e.g. when the same chat was
 * resumed from a worktree, a sibling workspace, or a diagnostic location. The
 * original #844 implementation iterated readdir and returned the first match;
 * tiann/hapi#872 documents how that silently transplanted alien content
 * over the real store on resume.
 *
 * The resolution order here is:
 *   1. If `sessionWorkspacePath` is provided, hash it and check that drawer
 *      first. If a store.db exists there, return immediately. This is the
 *      "we know which cwd you opened it from" fast path.
 *   2. Otherwise (no canonical path, or no canonical-drawer match), scan
 *      every `<wsh>` directory and collect every candidate.
 *      - 0 candidates -> null (caller surfaces no_legacy_store_on_disk).
 *      - 1 candidate  -> return it (regression-equivalent of pre-#872 single-
 *                        drawer path).
 *      - 2+ candidates -> throw AmbiguousLegacyStoreError listing every
 *                        candidate with its hash, size, and mtime so the
 *                        caller can surface an actionable refusal banner
 *                        instead of picking one and transplanting blindly.
 *
 * tiann/hapi#872.
 */
export function findLegacyChatStore(
    cursorSessionId: string,
    home: string,
    sessionWorkspacePath?: string
): LegacyStoreLocation | null {
    // tiann/hapi#872 cold review (#34-N): findLegacyChatStore is exported
    // public API and used as a free function in unit tests + the migrator
    // class. Validate the id at the boundary so an out-of-band caller
    // cannot pass `..` or `/` and have the inner `join(chatsRoot, wsh, id,
    // 'store.db')` resolve to an arbitrary on-disk path. The probe is
    // read-only (`statSync`) so blast radius is small, but the same
    // CURSOR_SESSION_ID_RE preflightSession applies to in-class callers
    // is cheap to also enforce here.
    if (!CURSOR_SESSION_ID_RE.test(cursorSessionId) || cursorSessionId === '.' || cursorSessionId === '..') {
        return null
    }
    const chatsRoot = join(home, '.cursor', 'chats')
    if (!existsSync(chatsRoot)) return null

    // Step 1: canonical-path fast path. Skip readdir entirely if we hit.
    // Do NOT trim: Cursor hashes the raw workspace path bytes.
    // Trimming would produce a different hash for a valid POSIX path
    // whose bytes happen to begin or end with ASCII space, causing a
    // canonical miss and a potential false ambiguity refusal.
    // tiann/hapi#877 bot Minor.
    const canonicalPath = typeof sessionWorkspacePath === 'string' ? sessionWorkspacePath : ''
    if (canonicalPath.length > 0) {
        const canonicalHash = workspaceHashFromPath(canonicalPath)
        const canonicalCandidate = join(chatsRoot, canonicalHash, cursorSessionId, 'store.db')
        try {
            const st = statSync(canonicalCandidate)
            if (st.isFile()) {
                return { workspaceHash: canonicalHash, storeDbPath: canonicalCandidate }
            }
        } catch {
            // canonical drawer absent or unreadable; fall through to scan
        }
    }

    // Step 2: scan every <wsh>/<cursorSessionId>/store.db.
    const candidates = listLegacyChatStoreCandidates(cursorSessionId, home)
    if (candidates.length === 0) return null
    if (candidates.length === 1) {
        const only = candidates[0]
        return { workspaceHash: only.workspaceHash, storeDbPath: only.storeDbPath }
    }
    throw new AmbiguousLegacyStoreError(cursorSessionId, candidates)
}

/**
 * Enumerate every on-disk legacy candidate for a cursorSessionId. Pure scan,
 * never throws. Used by findLegacyChatStore for the readdir fallback and by
 * the migrator for the `migrator:transplanted` diagnostic log so operators
 * can see "1 of N candidates picked" after the fact. tiann/hapi#872.
 */
export function listLegacyChatStoreCandidates(cursorSessionId: string, home: string): LegacyStoreCandidate[] {
    // Guard: same boundary check as findLegacyChatStore.  A future direct
    // caller that skips findLegacyChatStore must not be able to stat paths
    // outside the intended <wsh>/<cursorSessionId>/store.db shape by passing
    // a traversal-like id.  tiann/hapi#877 bot Minor.
    if (!CURSOR_SESSION_ID_RE.test(cursorSessionId) || cursorSessionId === '.' || cursorSessionId === '..') {
        return []
    }
    const chatsRoot = join(home, '.cursor', 'chats')
    if (!existsSync(chatsRoot)) return []
    let entries: string[]
    try {
        entries = readdirSync(chatsRoot)
    } catch {
        return []
    }
    const candidates: LegacyStoreCandidate[] = []
    for (const wsh of entries) {
        const candidate = join(chatsRoot, wsh, cursorSessionId, 'store.db')
        try {
            const st = statSync(candidate)
            if (st.isFile()) {
                candidates.push({
                    workspaceHash: wsh,
                    storeDbPath: candidate,
                    sizeBytes: st.size,
                    mtimeMs: st.mtimeMs
                })
            }
        } catch {
            // not in this wsh; keep scanning
        }
    }
    return candidates
}

/**
 * Read `lastUsedModel` (and chat name) from a legacy/ACP store.db's `meta`
 * record. Returns null if the store cannot be opened or the meta record is
 * missing.
 *
 * NOTE: the meta value is stored as a hex-encoded UTF-8 JSON blob in older
 * cursor-agent versions and as a plain JSON string in newer ones. We try both.
 */
export function readLegacyMetaLastUsedModel(storeDbPath: string): { name?: string; lastUsedModel?: string } | null {
    let metaDb: Database | null = null
    try {
        metaDb = new Database(storeDbPath, { readonly: true })
        const row = metaDb.prepare('SELECT cast(value as TEXT) as v FROM meta LIMIT 1').get() as { v?: string } | undefined
        if (!row?.v) return null
        const decoded = decodeMetaValue(row.v)
        if (!decoded) return null
        return {
            name: typeof decoded.name === 'string' ? decoded.name : undefined,
            lastUsedModel: typeof decoded.lastUsedModel === 'string' && decoded.lastUsedModel.trim().length > 0 ? decoded.lastUsedModel.trim() : undefined
        }
    } catch {
        return null
    } finally {
        try { metaDb?.close() } catch {}
    }
}

/**
 * Read the row count of the `blobs` table from a legacy/ACP cursor store.db.
 * Returns null when the file cannot be opened, the table is missing, or
 * the read otherwise fails - callers should treat null as "no signal" and
 * skip any blob-count-based decisions rather than treating it as a hard
 * zero. tiann/hapi#872.
 */
export function countLegacyStoreBlobs(storeDbPath: string): number | null {
    let db: Database | null = null
    try {
        db = new Database(storeDbPath, { readonly: true })
        const row = db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n?: number } | undefined
        if (!row || typeof row.n !== 'number' || !Number.isFinite(row.n)) return null
        return row.n
    } catch {
        return null
    } finally {
        try { db?.close() } catch {}
    }
}

function decodeMetaValue(value: string): Record<string, unknown> | null {
    // Try JSON first (newer ACP stores)
    if (value.startsWith('{')) {
        try { return JSON.parse(value) as Record<string, unknown> } catch {}
    }
    // Otherwise try hex-encoded UTF-8 JSON (older legacy stores).
    if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
        try {
            const buf = Buffer.from(value, 'hex')
            const text = buf.toString('utf8')
            if (text.startsWith('{')) {
                return JSON.parse(text) as Record<string, unknown>
            }
        } catch {}
    }
    return null
}

/**
 * Pre-flight: return null if the session can be migrated; return a refusal
 * outcome if it cannot. Pure: no side effects.
 */
export function preflightSession(session: Session | undefined, now: () => number, opts: { forceArchiveRunning?: boolean }): CursorMigrateOutcome | null {
    const start = now()
    if (!session) {
        return refusal('(unknown)', 'internal_error', 'session not found', start, now)
    }
    const sessionId = session.id
    const metadata = session.metadata
    if (!metadata || metadata.flavor !== 'cursor') {
        return refusal(sessionId, 'not_cursor_session', 'session.metadata.flavor must be "cursor"', start, now)
    }
    if (metadata.cursorSessionProtocol === 'acp') {
        return refusal(sessionId, 'already_acp', 'session already runs over ACP; nothing to migrate', start, now)
    }
    if (typeof metadata.cursorSessionId !== 'string' || metadata.cursorSessionId.trim().length === 0) {
        return refusal(sessionId, 'no_cursor_session_id', 'session.metadata.cursorSessionId is missing', start, now)
    }
    const trimmed = metadata.cursorSessionId.trim()
    if (!CURSOR_SESSION_ID_RE.test(trimmed) || trimmed === '.' || trimmed === '..') {
        return refusal(sessionId, 'no_cursor_session_id', `cursorSessionId '${trimmed}' fails basename validation`, start, now)
    }
    // Block both lifecycleState==='running' AND session.active (legacy rows
    // may lack lifecycleState but still be active in the cache). Codex
    // review #34 P2.
    const lifecycle = typeof metadata.lifecycleState === 'string' ? metadata.lifecycleState : undefined
    const isActive = lifecycle === 'running' || session.active === true
    if (isActive && !opts.forceArchiveRunning) {
        return refusal(sessionId, 'running_refused', 'session is active; archive first or pass forceArchiveRunning', start, now)
    }
    return null
}

/* ---------- main entry ---------- */

export class CursorLegacyMigrator {
    private readonly opts: Required<Pick<CursorLegacyMigratorOptions, 'lockReleaseTimeoutMs' | 'verifyTimeoutMs' | 'verifyPromptText'>>
    private readonly deps: Required<Pick<CursorLegacyMigratorDeps, 'homeDir' | 'hostName' | 'createProbe' | 'tmpDir' | 'now' | 'awaitLockRelease' | 'isAgentAcpTransportActive' | 'getCurrentSession' | 'logger' | 'acquireAcpActiveLock' | 'checkpointLegacyStore'>>
        & Pick<CursorLegacyMigratorDeps, 'archiveSession' | 'updateSessionAfterMigrate' | 'getHapiMessageCount'>

    constructor(opts: CursorLegacyMigratorOptions, deps: CursorLegacyMigratorDeps) {
        this.opts = {
            lockReleaseTimeoutMs: opts.lockReleaseTimeoutMs ?? DEFAULT_LOCK_RELEASE_TIMEOUT_MS,
            verifyTimeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
            verifyPromptText: opts.verifyPromptText ?? DEFAULT_VERIFY_PROMPT
        }
        this.deps = {
            homeDir: deps.homeDir ?? (() => homedir()),
            hostName: deps.hostName ?? (() => process.env.HAPI_HOSTNAME?.trim() || hostname()),
            createProbe: deps.createProbe ?? ((env, agentLookupHome) => new AcpVerifyProbe({
                env,
                skipLockAcquire: true,
                // tiann/hapi#844 upstream Codex Major: `migrateOne` resolves the
                // legacy store under `metadata.homeDir` (the recorded session-
                // owner home), so the probe MUST also look up `agent` under
                // that same home. Earlier rounds plumbed `agentLookupHome` into
                // the factory default using `this.deps.homeDir()` (the HUB's
                // home), which falls back to the hub user's `~/.local/bin` on
                // service-account deployments where the human installed Cursor
                // under a different account. The caller (`verifyInTempHome`)
                // now passes the resolved `sourceHome` through to keep the
                // store and the binary discovery rooted in the same home.
                agentLookupHome
            })),
            // Default: never refuse based on the global lock. The verify probe
            // is isolated via HAPI_HOME override in verifyInTempHome, so the
            // host's live ACP transports cannot block migration. Operator
            // CLI/REST callers that want the pre-isolation conservative
            // behavior can inject `() => tryAcquireAcpActiveLock(home)`.
            acquireAcpActiveLock: deps.acquireAcpActiveLock ?? (() => ({ release() {} })),
            checkpointLegacyStore: deps.checkpointLegacyStore ?? defaultCheckpointLegacyStore,
            tmpDir: deps.tmpDir ?? (() => tmpdir()),
            now: deps.now ?? (() => Date.now()),
            awaitLockRelease: deps.awaitLockRelease ?? defaultAwaitLockRelease,
            isAgentAcpTransportActive: deps.isAgentAcpTransportActive ?? defaultIsAgentAcpTransportActive,
            // Default: cannot detect a resume — return null so the recheck
            // is a no-op. SyncEngine injects a real impl that reads the
            // session cache. Codex review #34 P1.
            getCurrentSession: deps.getCurrentSession ?? (() => null),
            logger: deps.logger ?? noopLogger(),
            archiveSession: deps.archiveSession,
            updateSessionAfterMigrate: deps.updateSessionAfterMigrate,
            getHapiMessageCount: deps.getHapiMessageCount
        }
    }

    /**
     * Migrate a single legacy cursor session in place. Side-effecting: writes
     * to ~/.cursor/acp-sessions/, conditionally writes hapi.db (via injected
     * updateSessionAfterMigrate), conditionally removes the legacy source.
     */
    async migrateOne(session: Session, opts: CursorLegacyMigratorOptions): Promise<CursorMigrateOutcome> {
        const start = this.deps.now()
        const log = this.deps.logger

        const pre = preflightSession(session, this.deps.now, { forceArchiveRunning: opts.forceArchiveRunning })
        if (pre) return pre

        // Type-narrow the metadata fields we use below.
        const metadata = session.metadata as Metadata
        const cursorSessionId = metadata.cursorSessionId as string
        const cwd = metadata.path

        // ALL preconditions that could refuse must run BEFORE archive
        // and BEFORE any other side effect. Otherwise a bulk run with
        // --force-archive-running could kill a session that we then
        // refuse to migrate (e.g. cross-host, acp_transport_active).
        // Codex review #34 P2 v2.

        // Cross-host check: if the session was recorded on a different
        // machine, its ~/.cursor/chats lives there, not here.
        const recordedHost = typeof metadata.host === 'string' ? metadata.host.trim() : ''
        const localHost = this.deps.hostName().trim()
        if (recordedHost && localHost && recordedHost !== localHost) {
            return refusal(session.id, 'cross_host_session', `session recorded host=${recordedHost} does not match local hub host=${localHost}; cannot migrate a session whose filesystem lives on a different machine`, start, this.deps.now)
        }

        // ACP transport check + reservation. We used to do this as a
        // point-in-time check followed by an internal lock acquire
        // inside verifyInTempHome(). That left a gap: another agent
        // acp could start between this check and the verify probe's
        // spawn, and a --force-archive-running migration would kill the
        // legacy session in that gap before refusing. Codex review
        // #34 P2 v7: acquire the global agent-acp-active lock NOW and
        // hold it across the entire mutation window. The verify probe
        // is told skipLockAcquire=true so it inherits our hold.
        let acpLock: { release(): void } | null = null
        try {
            acpLock = this.deps.acquireAcpActiveLock()
        } catch (err) {
            return refusal(session.id, 'internal_error', `agent-acp-active lock acquisition failed: ${err instanceof Error ? err.message : String(err)}`, start, this.deps.now)
        }
        if (acpLock === null) {
            const holder = this.deps.isAgentAcpTransportActive()
            return refusal(session.id, 'acp_transport_active', `another agent acp transport is registered active (holder pid=${holder.holderPid ?? '?'}); refusing to verify-migrate to avoid SIGTERMing the live ACP session — close active Cursor ACP sessions and retry`, start, this.deps.now)
        }
        try {
            return await this.migrateOneWithLock(session, opts, start, metadata, cursorSessionId, cwd, log)
        } finally {
            acpLock.release()
        }
    }

    private async migrateOneWithLock(
        session: Session,
        opts: CursorLegacyMigratorOptions,
        start: number,
        metadata: Metadata,
        cursorSessionId: string,
        cwd: string,
        log: NonNullable<CursorLegacyMigratorDeps['logger']>
    ): Promise<CursorMigrateOutcome> {

        // Resolve $HOME: prefer the recorded session owner's home from
        // metadata.homeDir (populated by cli/src/agent/sessionFactory.ts)
        // because the hub process may run under a service account whose
        // HOME differs from the human-user account that created the
        // Cursor session. Fall back to the hub's homeDir() when the
        // metadata field is absent (older session records).
        // Codex review #34 P2.
        const recordedHome = typeof metadata.homeDir === 'string' && metadata.homeDir.trim().length > 0
            ? metadata.homeDir.trim()
            : null
        const home = recordedHome ?? this.deps.homeDir()

        // Locate the legacy store.db on disk BEFORE we archive. If the
        // local filesystem has no such file, we have nothing to migrate
        // and there's no reason to kill the session.
        //
        // Pass the session's canonical workspace path (metadata.path) so
        // findLegacyChatStore can jump straight to the md5(path) drawer
        // before falling back to the readdir scan. Without the canonical
        // hint, a cursorSessionId that exists in multiple <workspace-hash>
        // drawers would silently get the first readdir match - the #844
        // regression documented in tiann/hapi#872.
        const canonicalWorkspacePath = typeof cwd === 'string' ? cwd : ''
        // Snapshot the full candidate set BEFORE the canonical fast-path
        // resolves a single drawer. The successful transplant's diagnostic
        // log captures this count, so it must reflect the pre-rm reality
        // (the rm step would otherwise leave the log understating the
        // number of drawers that existed at decision time, undermining
        // the diagnose-from-journalctl-alone goal). tiann/hapi#873 cold
        // review Minor #1.
        const candidatesAtDiscovery = listLegacyChatStoreCandidates(cursorSessionId, home)
        let legacy: LegacyStoreLocation | null
        try {
            legacy = findLegacyChatStore(cursorSessionId, home, canonicalWorkspacePath)
        } catch (err) {
            if (err instanceof AmbiguousLegacyStoreError) {
                const summary = err.candidates
                    .map((c) => `${c.workspaceHash} (size=${c.sizeBytes}, mtimeMs=${c.mtimeMs})`)
                    .join('; ')
                const canonicalHashStr = canonicalWorkspacePath.length > 0
                    ? workspaceHashFromPath(canonicalWorkspacePath)
                    : '(no canonical path on session metadata)'
                log.warn('[migrator] ambiguous legacy store; refusing transplant', {
                    sessionId: session.id,
                    cursorSessionId,
                    canonicalWorkspacePath: canonicalWorkspacePath.length > 0 ? canonicalWorkspacePath : null,
                    canonicalHash: canonicalHashStr,
                    candidates: err.candidates
                })
                return refusal(
                    session.id,
                    'ambiguous_legacy_store',
                    `legacy store ambiguous: cursorSessionId ${cursorSessionId} exists in ${err.candidates.length} workspace-hash drawers and none matched canonical workspace path md5 (${canonicalHashStr}). Candidates: ${summary}. Resolve manually before migration.`,
                    start,
                    this.deps.now
                )
            }
            throw err
        }
        if (!legacy) {
            return refusal(session.id, 'no_legacy_store_on_disk', `~/.cursor/chats/*/${cursorSessionId}/store.db not found under ${home}`, start, this.deps.now)
        }
        // Diagnostic: canonical-path lookup missed but readdir found a
        // single drawer (we still proceed for regression equivalence,
        // but this warrants a log because it implies our md5(path) does
        // not match Cursor's drawer naming for this session - e.g. an
        // operator hit a path-normalization corner case we have not
        // mapped). tiann/hapi#873 cold review Major #2.
        if (canonicalWorkspacePath.length > 0 && legacy.workspaceHash !== workspaceHashFromPath(canonicalWorkspacePath)) {
            log.warn('[migrator] canonical-path drawer missing; falling back to single readdir candidate', {
                sessionId: session.id,
                cursorSessionId,
                canonicalWorkspacePath,
                expectedHash: workspaceHashFromPath(canonicalWorkspacePath),
                pickedHash: legacy.workspaceHash
            })
        }

        // tiann/hapi#872: source-side measurements BEFORE any destructive
        // step. The `migrator:transplanted` log on the success path quotes
        // these source values - capturing them AFTER the rm would either
        // fail (file gone) or read the destination copy by mistake. The
        // candidate-count snapshot above (`candidatesAtDiscovery`) is the
        // matching pre-rm capture for the "N candidates discovered"
        // diagnostic. tiann/hapi#873 cold review.
        const sourceBytesAtDiscovery = (() => {
            try { return statSync(legacy.storeDbPath).size } catch { return -1 }
        })()
        const sourceBlobCountAtDiscovery = countLegacyStoreBlobs(legacy.storeDbPath) ?? -1

        // Size sanity check: even when discovery is unambiguous, the
        // picked legacy store may be a stale sibling that happens to be
        // the only on-disk artifact for this session id (e.g. operator
        // deleted the canonical workspace and a diagnostic location is
        // all that's left). If HAPI already synced a meaningful history
        // for the session and the candidate store has wildly fewer blobs
        // than that history, refuse rather than transplant a shrunken
        // alien snapshot over the live ACP target. Skips entirely when
        // HAPI message count is 0 (brand-new / never-synced session).
        // tiann/hapi#872.
        const sizeMismatch = this.checkSizeSanity(session, cursorSessionId, legacy.storeDbPath, log)
        if (sizeMismatch) {
            log.warn('[migrator] size sanity check refused transplant', {
                sessionId: session.id,
                cursorSessionId,
                ...sizeMismatch.context
            })
            return refusal(session.id, 'size_mismatch', sizeMismatch.message, start, this.deps.now)
        }

        // Pre-flight: refuse if the ACP target dir already exists. Also
        // moved BEFORE archive to avoid killing a session whose target
        // collision would refuse anyway.
        const acpSessionDir = join(home, '.cursor', 'acp-sessions', cursorSessionId)
        if (existsSync(acpSessionDir)) {
            return refusal(session.id, 'target_already_exists', `~/.cursor/acp-sessions/${cursorSessionId}/ already exists; refusing to overwrite`, start, this.deps.now)
        }

        // Handle force-archive on a live runner. We pre-flighted that
        // running/active is allowed only with forceArchiveRunning. Gate
        // the archive RPC on session.active === true: a stale
        // lifecycleState='running' on an inactive cache row means the
        // metadata cleanup write hasn't flushed yet — there is no live
        // runner to archive, and archiveSession() would fail with a
        // no-registered-handler. The metadata flip itself will clean up
        // the stale lifecycle value when it writes cursorSessionProtocol.
        // Codex review #34 P2 v6.
        const wasActive = session.active === true
        if (wasActive) {
            if (!this.deps.archiveSession) {
                return refusal(session.id, 'internal_error', 'forceArchiveRunning requested but archiveSession dependency not configured', start, this.deps.now)
            }
            try {
                log.info('[migrator] archiving running session before migrate', { sessionId: session.id })
                await this.deps.archiveSession(session.id)
            } catch (err) {
                return refusal(session.id, 'archive_failed', err instanceof Error ? err.message : String(err), start, this.deps.now)
            }
        } else if (metadata.lifecycleState === 'running') {
            log.info('[migrator] migrating stale lifecycle=running row without archive RPC (no live runner)', { sessionId: session.id })
        }

        // If we just archived an active session, wait for the legacy
        // runner's writes to settle. The naive signal — sessionCache.active
        // flipping false — is bogus here because archiveSession() calls
        // handleSessionEnd() synchronously, so the cache flag is set to
        // false BEFORE the runner subprocess has exited and released its
        // file descriptors. The hub does not track runner subprocess PIDs
        // we could process.kill(pid, 0), so we cannot directly observe
        // the runner's exit.
        //
        // What we DO have:
        //   (a) SQLite BEGIN IMMEDIATE busy-probe — true while another
        //       connection holds a write transaction
        //   (b) size-stability poll on store.db — true once writes settle
        //   (c) minimum dwell time — fail-safe for the case where the
        //       runner is idle (no write txn) but still mid-shutdown:
        //       (a)+(b) can both pass while the subprocess is still in
        //       SIGTERM cleanup. The dwell guarantees we waited at least
        //       this long after the archive call.
        //
        // Codex review #34 P1 v3: removed the previous awaitSessionInactive
        // step that polled cache.active — it was self-mutated by the
        // archive call so could never block. Replaced with a real minimum
        // dwell inside awaitLockRelease itself.
        if (wasActive) {
            const released = await this.deps.awaitLockRelease(legacy.storeDbPath, this.opts.lockReleaseTimeoutMs)
            if (!released) {
                return refusal(session.id, 'lock_release_timeout', `legacy store.db file lock not released within ${this.opts.lockReleaseTimeoutMs}ms`, start, this.deps.now)
            }
        }

        // Read legacy meta for lastUsedModel (best-effort) BEFORE we mutate anything.
        const metaInfo = readLegacyMetaLastUsedModel(legacy.storeDbPath) ?? {}
        const lastUsedModel = metaInfo.lastUsedModel ?? null

        // Flush the legacy WAL into store.db so a "cp main-file-only" copy
        // is complete. Without this, un-checkpointed transactions live in
        // store.db-wal and would either be stale-in-target or silently lost
        // when the cleanup step removes the WAL sibling. Codex review #34
        // P1: addresses the transplant-WAL-loss case.
        try {
            this.deps.checkpointLegacyStore(legacy.storeDbPath)
        } catch (err) {
            return refusal(session.id, 'internal_error', `wal_checkpoint failed before transplant: ${err instanceof Error ? err.message : String(err)}`, start, this.deps.now)
        }

        // Codex review #34 P2 v8: TRUNCATE-mode checkpoint zeroes the WAL.
        // If we observe WAL bytes BEFORE capturing the baseline fingerprint,
        // a writer landed between checkpoint return and this stat — that
        // writer's frames are NOT in store.db (we copy main-file-only),
        // and accepting them as baseline would let the post-fingerprint
        // match pass and the cleanup delete the legacy WAL with those
        // frames lost. Refuse rather than baseline-poisoned migrate.
        try {
            const walSt = statSync(`${legacy.storeDbPath}-wal`)
            if (walSt.size > 0) {
                return refusal(session.id, 'legacy_store_modified_during_migrate', `store.db-wal grew to ${walSt.size} bytes between checkpoint and fingerprint capture; a writer resumed during the migration window — refusing baseline-poisoned transplant`, start, this.deps.now)
            }
        } catch (err) {
            // WAL absent (most common: TRUNCATE removed it) — fine.
            const code = (err as NodeJS.ErrnoException).code
            if (code !== 'ENOENT') {
                log.warn('[migrator] could not stat store.db-wal post-checkpoint', { sessionId: session.id, err: err instanceof Error ? err.message : String(err) })
            }
        }

        // Capture a fingerprint of the legacy store.db AND its WAL/SHM
        // sidecars post-checkpoint. Codex review #34 P1 v4: the WAL is
        // the place SQLite stages new commits before they merge into the
        // main file. A brief resume can write turns to store.db-wal
        // while leaving store.db's mtime/size unchanged. We must
        // fingerprint the WAL sidecar too — appearance, size change, or
        // mtime change all indicate post-checkpoint writes that our cp
        // missed.
        type FileFp = { exists: true; mtimeMs: number; size: number } | { exists: false }
        const fpOf = (p: string): FileFp => {
            try {
                const st = statSync(p)
                return { exists: true, mtimeMs: st.mtimeMs, size: st.size }
            } catch {
                return { exists: false }
            }
        }
        const fpEqual = (a: FileFp, b: FileFp): boolean => {
            if (a.exists !== b.exists) return false
            if (!a.exists) return true
            // b.exists is also true at this point.
            return (b as { exists: true; mtimeMs: number; size: number }).mtimeMs === a.mtimeMs
                && (b as { exists: true; mtimeMs: number; size: number }).size === a.size
        }
        const preFingerprint = {
            main: fpOf(legacy.storeDbPath),
            wal: fpOf(`${legacy.storeDbPath}-wal`),
            shm: fpOf(`${legacy.storeDbPath}-shm`)
        }
        if (!preFingerprint.main.exists) {
            log.warn('[migrator] could not stat legacy store post-checkpoint; skipping pre/post fingerprint check', { sessionId: session.id })
        }

        // Verify-by-temp-home: build a throwaway $HOME, place a copy of the
        // legacy store.db there, drive initialize + session/load. The
        // session/prompt step (which exercises the agent's response loop) is
        // gated on the !skipVerify flag because it requires a live model
        // and may legitimately fail on policy-restricted sessions. We ALWAYS
        // drive session/load — that's the cheapest reliable proof the
        // transplant is loadable. Codex review #34 P2: skipVerify must not
        // skip session/load.
        let replayNotifications = 0
        const verifyResult = await this.verifyInTempHome(legacy.storeDbPath, cursorSessionId, cwd, { runPrompt: !opts.skipVerify, sourceHome: home })
        if (verifyResult.kind === 'transport_lock_held') {
            // Lost the atomic-lock race against another verify probe.
            // Codex review #34 P2 v2.
            return refusal(session.id, 'acp_transport_active', verifyResult.message, start, this.deps.now)
        }
        if (verifyResult.kind === 'load_failed') {
            return refusal(session.id, 'verify_load_failed', verifyResult.message, start, this.deps.now)
        }
        if (verifyResult.kind === 'prompt_failed') {
            return refusal(session.id, 'verify_prompt_failed', verifyResult.message, start, this.deps.now)
        }
        replayNotifications = verifyResult.replayNotifications

        // Place the real ACP-sessions entry. cp, not mv - reversible. Atomic
        // dir-create (no `recursive: true`) so two concurrent migrate calls
        // for the same session cannot both pass the existsSync check and
        // mkdir, with one then clobbering the other's store. The parent
        // ~/.cursor/acp-sessions exists by precondition (cursor-agent
        // creates it on first run; we create it here if absent).
        // Codex review #34 P2: atomic target creation.
        mkdirSync(join(home, '.cursor', 'acp-sessions'), { recursive: true })
        let acpDirCreated = false
        try {
            try {
                // Codex #34 P2 (round 13): explicit 0o700 mode so the
                // session dir is private regardless of umask. On a multi-
                // user host with a default 022 umask and a non-private
                // ~/.cursor, mkdir without an explicit mode produced 0755
                // — every local user could traverse and read transcripts.
                mkdirSync(acpSessionDir, { recursive: false, mode: 0o700 })
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                if (/EEXIST/.test(msg)) {
                    return refusal(session.id, 'target_already_exists', `~/.cursor/acp-sessions/${cursorSessionId}/ already exists (race with concurrent migrate); refusing to overwrite`, start, this.deps.now)
                }
                throw err
            }
            acpDirCreated = true
            copyFileSync(legacy.storeDbPath, join(acpSessionDir, 'store.db'))
            // Codex #34 P2 (round 13): copyFileSync inherits the source
            // file's mode bits, which historically might be 0o644. Force
            // 0o600 on the transplanted store so transcript contents are
            // owner-only readable.
            try { chmodSync(join(acpSessionDir, 'store.db'), 0o600) } catch {}
            const sidecarTitle = metaInfo.name && metaInfo.name.trim().length > 0
                ? metaInfo.name.trim()
                : undefined
            const sidecar: Record<string, unknown> = {
                schemaVersion: 1,
                cwd
            }
            if (sidecarTitle) sidecar.title = sidecarTitle
            writeFileSync(join(acpSessionDir, 'meta.json'), JSON.stringify(sidecar), { mode: 0o600 })
        } catch (err) {
            if (acpDirCreated) {
                // Only rollback the dir we own (acpDirCreated implies the
                // exclusive mkdir succeeded above).
                tryRm(acpSessionDir)
            }
            return refusal(session.id, 'internal_error', `failed to place ACP session: ${err instanceof Error ? err.message : String(err)}`, start, this.deps.now)
        }

        // Resume-race recheck. Between preflight and now, the session
        // could have been resumed via the existing CLI/web/Telegram paths
        // (especially if --force-archive-running was used: archive returns
        // immediately, so a quick automation could un-archive). The
        // resume path reads cursorSessionProtocol === 'legacy' from
        // hapi.db and spawns a stream-json runner against the legacy
        // store.db — which we are about to remove. Refuse the flip in
        // that case so the running session is not amputated mid-write.
        // Codex review #34 P1.
        //
        // Codex review #34 P2 v5: when WE are the one who just archived
        // the session (wasActive=true), the cleanup metadata write that
        // flips lifecycleState 'running' → 'archived' may still be in
        // flight — handleSessionEnd() runs after killThisHappy() returns.
        // In that window the cache shows active=false (set by archive
        // synchronously) but lifecycleState is still 'running'. That is
        // OUR archive completing, NOT a resume race. Trust the active
        // flag in this case; awaitLockRelease's dwell+busy-probe is the
        // real safety net against an in-flight runner.
        const latest = this.deps.getCurrentSession(session.id, session.namespace)
        if (latest && latest.active === true) {
            tryRm(acpSessionDir)
            return refusal(session.id, 'session_resumed_during_migrate', `session became active during migration (active=true lifecycleState=${latest.lifecycleState ?? 'n/a'}); rolled back ACP placement`, start, this.deps.now)
        }
        if (latest && !wasActive && latest.lifecycleState === 'running') {
            // Lifecycle says running but active=false and we did NOT
            // archive this session ourselves. Something external lifted
            // it back to running between preflight and now (rare but
            // possible if the session was preflight-archived and then
            // a peer un-archived it via the lifecycle API).
            tryRm(acpSessionDir)
            return refusal(session.id, 'session_resumed_during_migrate', `session lifecycle became running during migration (lifecycleState=running, active=false, wasActive=false); rolled back ACP placement`, start, this.deps.now)
        }
        if (latest && latest.cursorSessionProtocol === 'acp') {
            // Someone else migrated this session concurrently. Roll back
            // our placement; the other migration's target is canonical.
            tryRm(acpSessionDir)
            return refusal(session.id, 'already_acp', 'session protocol flipped to acp by a concurrent migration; rolled back', start, this.deps.now)
        }

        // Fingerprint check: an archived legacy session could be resumed
        // AFTER our checkpoint, write turns to store.db OR store.db-wal,
        // then exit before our active recheck above. The active flag
        // would already be false but the legacy files would have diverged
        // from the copy we just placed at the ACP target. Refuse the
        // flip in that case so we don't transplant a stale snapshot.
        // Codex review #34 P1 v3+v4 (now covers WAL/SHM sidecars).
        if (preFingerprint.main.exists) {
            const postFingerprint = {
                main: fpOf(legacy.storeDbPath),
                wal: fpOf(`${legacy.storeDbPath}-wal`),
                shm: fpOf(`${legacy.storeDbPath}-shm`)
            }
            const changed = (
                !fpEqual(preFingerprint.main, postFingerprint.main)
                || !fpEqual(preFingerprint.wal, postFingerprint.wal)
                || !fpEqual(preFingerprint.shm, postFingerprint.shm)
            )
            if (changed) {
                tryRm(acpSessionDir)
                const fmt = (label: string, pre: FileFp, post: FileFp) => `${label}: pre=${JSON.stringify(pre)} post=${JSON.stringify(post)}`
                return refusal(session.id, 'legacy_store_modified_during_migrate', `legacy store changed during migration window — ${fmt('store.db', preFingerprint.main, postFingerprint.main)}, ${fmt('store.db-wal', preFingerprint.wal, postFingerprint.wal)}, ${fmt('store.db-shm', preFingerprint.shm, postFingerprint.shm)}; rolled back ACP placement`, start, this.deps.now)
            }
        }

        // Flip metadata. We rely on a caller-provided updater because the
        // migrator must not import the hub Store directly (keeps the module
        // pure for unit testing).
        if (!this.deps.updateSessionAfterMigrate) {
            tryRm(acpSessionDir)
            return refusal(session.id, 'internal_error', 'updateSessionAfterMigrate dependency not configured', start, this.deps.now)
        }
        const updateResult = this.deps.updateSessionAfterMigrate(session.id, session.namespace, lastUsedModel)
        if (!updateResult.ok) {
            tryRm(acpSessionDir)
            // Distinguish the atomic active-check failure from the
            // metadata-version mismatch case so operators know which
            // recovery path applies. Codex review #34 P1 v2.
            if (updateResult.reason === 'session_active') {
                return refusal(session.id, 'session_resumed_during_migrate', 'session became active inside the metadata flip (atomic check); rolled back ACP placement', start, this.deps.now)
            }
            return refusal(session.id, 'metadata_write_failed', `hapi.db write failed: ${updateResult.reason}`, start, this.deps.now)
        }

        // Remove source unless --keep-source. The rm is the LAST step; if it
        // fails, the migration is still considered successful because the ACP
        // target is intact and metadata is flipped.
        let sourceRemoved = false
        if (!opts.keepSource) {
            try {
                rmSync(legacy.storeDbPath, { force: true })
                // Also drop SQLite sidecars if present (WAL + SHM).
                tryRm(`${legacy.storeDbPath}-wal`)
                tryRm(`${legacy.storeDbPath}-shm`)
                // ONLY rmdir the parent if empty. We never recursively delete
                // unknown files - a future cursor-agent version that drops
                // additional artifacts in the chat dir would otherwise see
                // them silently destroyed.
                try { rmdirSync(dirname(legacy.storeDbPath)) } catch {}
                sourceRemoved = true
                log.info('[migrator] removed legacy source', { sessionId: session.id, path: legacy.storeDbPath })
            } catch (err) {
                log.warn('[migrator] legacy source rm failed (target intact, treating as success)', { sessionId: session.id, error: err instanceof Error ? err.message : String(err) })
            }
        }

        // tiann/hapi#872: diagnostic log on every successful transplant.
        // Uses pre-rm snapshots captured at discovery time so the count
        // and source measurements reflect what was actually on disk, not
        // what's left after the cleanup rm. Future regression of the #844
        // ambiguous-source bug is diagnosable from `journalctl -u hapi-hub`
        // alone, without blob-overlap forensics on the destination store.
        log.info('[migrator] transplanted', {
            sessionId: session.id,
            cursorSessionId,
            workspaceHash: legacy.workspaceHash,
            candidateCount: candidatesAtDiscovery.length,
            sourceBytes: sourceBytesAtDiscovery,
            sourceBlobCount: sourceBlobCountAtDiscovery,
            targetAcpPath: join(acpSessionDir, 'store.db'),
            sourceRemoved,
            canonicalHash: canonicalWorkspacePath.length > 0
                ? workspaceHashFromPath(canonicalWorkspacePath)
                : null
        })

        return {
            ok: true,
            sessionId: session.id,
            acpSessionId: cursorSessionId,
            replayNotifications,
            durationMs: this.deps.now() - start,
            lastUsedModelPreserved: lastUsedModel,
            sourceRemoved
        }
    }

    /**
     * Refuse a transplant when the candidate legacy store carries
     * dramatically fewer blobs than HAPI's known message history for
     * the session - the canonical symptom of the #844 ambiguous-source
     * regression where a stale sibling drawer gets picked up by the
     * readdir scan even when no explicit ambiguity exists (e.g. the
     * canonical drawer was deleted off disk leaving only a diagnostic
     * sibling). Returns null when the check passes; returns a refusal
     * payload otherwise. Skipped entirely when:
     *   - no `getHapiMessageCount` dep is wired (e.g. unit tests, CLI
     *     callers that don't have a store handle)
     *   - HAPI message count is 0 (brand-new / never-synced session)
     *   - candidate blob count cannot be read (treated as fail-open
     *     so a corrupted store still goes through the normal verify path
     *     and surfaces verify_load_failed there)
     * Thresholds are conservative sanity floors, not exact guarantees:
     * messageCount > 100 AND blobCount < messageCount / 4. tiann/hapi#872.
     */
    private checkSizeSanity(
        session: Session,
        cursorSessionId: string,
        legacyStoreDbPath: string,
        log: NonNullable<CursorLegacyMigratorDeps['logger']>
    ): { message: string; context: Record<string, unknown> } | null {
        if (!this.deps.getHapiMessageCount) return null
        let messageCount: number
        try {
            messageCount = this.deps.getHapiMessageCount(session.id, session.namespace)
        } catch (err) {
            log.warn('[migrator] getHapiMessageCount threw; skipping size sanity', {
                sessionId: session.id,
                err: err instanceof Error ? err.message : String(err)
            })
            return null
        }
        if (!Number.isFinite(messageCount) || messageCount <= 100) return null
        const blobCount = countLegacyStoreBlobs(legacyStoreDbPath)
        if (blobCount === null) return null
        const minExpectedBlobs = Math.floor(messageCount / 4)
        if (blobCount >= minExpectedBlobs) return null
        return {
            message: `legacy store size mismatch: HAPI tracks ${messageCount} message(s) for session ${cursorSessionId} but candidate store has only ${blobCount} blob(s) (< messageCount/4 = ${minExpectedBlobs}). Refusing to transplant likely-alien content; resolve manually.`,
            context: { messageCount, blobCount, minExpectedBlobs, legacyStoreDbPath }
        }
    }

    /**
     * Spawn `agent acp` against a temp $HOME, copy auth files, place the
     * legacy store.db at <tmp>/.cursor/acp-sessions/<uuid>/store.db + meta.json,
     * drive initialize + session/load + (default) one tiny session/prompt.
     * Returns a structured outcome; ALWAYS cleans up the temp dir.
     */
    private async verifyInTempHome(
        legacyStoreDbPath: string,
        cursorSessionId: string,
        cwd: string,
        opts: { runPrompt: boolean; sourceHome: string }
    ): Promise<{ kind: 'ok'; replayNotifications: number } | { kind: 'load_failed'; message: string } | { kind: 'prompt_failed'; message: string } | { kind: 'transport_lock_held'; message: string }> {
        const tmpRoot = mkdtempSync(join(this.deps.tmpDir(), 'hapi-acp-verify-'))
        const fakeHome = tmpRoot
        const fakeAcpSessionDir = join(fakeHome, '.cursor', 'acp-sessions', cursorSessionId)
        try {
            mkdirSync(fakeAcpSessionDir, { recursive: true })
            copyFileSync(legacyStoreDbPath, join(fakeAcpSessionDir, 'store.db'))
            writeFileSync(join(fakeAcpSessionDir, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }))

            // Copy auth files from the operator's real ~/.cursor into the temp $HOME.
            // Auth tokens are read by `agent acp` at startup; missing files just
            // mean no auth, which is fine for session/load (no-network) but breaks
            // session/prompt. We try our best; the prompt step degrades gracefully
            // if not authed.
            const realCursor = join(opts.sourceHome, '.cursor')
            const fakeCursor = join(fakeHome, '.cursor')
            for (const f of AUTH_FILES) {
                const src = join(realCursor, f)
                if (existsSync(src)) {
                    try { copyFileSync(src, join(fakeCursor, f)) } catch {}
                }
            }

            // Isolate the verify spawn from the operator's real ~/.cursor
            // tree AND from the host's HAPI_HOME lock space. On POSIX, HOME
            // is the only relevant variable for the ~/.cursor lookup. On
            // Windows, `agent` may resolve the user profile from
            // USERPROFILE, HOMEDRIVE+HOMEPATH instead — so override all
            // three to point at the fake home. Codex review #34 P2:
            // without HOME override the verify could touch the real .cursor
            // tree.
            //
            // HAPI_HOME override (added for the auto-migration flow): the
            // verify probe's child agent-cli registers an `agent-acp-active`
            // lock at `<HAPI_HOME>/locks/agent-acp-active/`. The host's real
            // HAPI_HOME is shared with every other live ACP transport on the
            // machine (peer agents, IDE chats), so the verify probe would
            // collide with them. Pointing the child's HAPI_HOME at the same
            // per-verify temp dir as HOME gives the probe its own private
            // lock space, completely isolated from anything else running.
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                HOME: fakeHome,
                HAPI_HOME: fakeHome,
                NO_COLOR: '1'
            }
            if (process.platform === 'win32') {
                env.USERPROFILE = fakeHome
                // Best-effort HOMEDRIVE / HOMEPATH split. If fakeHome lacks
                // a drive letter (unusual on win32 but possible in tests),
                // leave HOMEDRIVE unset and put the whole path in HOMEPATH.
                const driveMatch = /^[A-Za-z]:/.exec(fakeHome)
                if (driveMatch) {
                    env.HOMEDRIVE = driveMatch[0]
                    env.HOMEPATH = fakeHome.slice(2)
                } else {
                    env.HOMEDRIVE = ''
                    env.HOMEPATH = fakeHome
                }
            }
            const probe = this.deps.createProbe(env, opts.sourceHome)
            const verifyStart = this.deps.now()
            const verifyDeadline = verifyStart + this.opts.verifyTimeoutMs
            try {
                try {
                    probe.start()
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    if (/agent-acp-active lock is held/.test(msg)) {
                        return { kind: 'transport_lock_held', message: msg }
                    }
                    throw err
                }
                const initResp = await probe.initialize(remainingTime(verifyDeadline, this.deps.now))
                if (!initResp.ok) {
                    return { kind: 'load_failed', message: `initialize failed: ${initResp.error.message}` }
                }
                const loadOut = await probe.loadSession(
                    { sessionId: cursorSessionId, cwd, mcpServers: [] },
                    DEFAULT_REPLAY_DRAIN_MS,
                    remainingTime(verifyDeadline, this.deps.now)
                )
                if (!loadOut.response.ok) {
                    return { kind: 'load_failed', message: `session/load failed: ${loadOut.response.error.message}` }
                }

                // Send the verify prompt only when the caller requested it
                // (skipVerify=false). The load above is always run because it
                // is the cheapest reliable proof the transplant is loadable.
                if (opts.runPrompt) {
                    const promptOut = await probe.prompt(
                        { sessionId: cursorSessionId, text: this.opts.verifyPromptText },
                        Math.max(15_000, remainingTime(verifyDeadline, this.deps.now))
                    )
                    if (!promptOut.response.ok) {
                        return { kind: 'prompt_failed', message: `session/prompt failed: ${promptOut.response.error.message}` }
                    }
                }

                return { kind: 'ok', replayNotifications: loadOut.notificationCount }
            } finally {
                await probe.stop()
            }
        } finally {
            tryRm(tmpRoot)
        }
    }
}

function remainingTime(deadline: number, now: () => number): number {
    return Math.max(1_000, deadline - now())
}

function tryRm(path: string): void {
    try {
        rmSync(path, { recursive: true, force: true })
    } catch {
        // best-effort; caller logs
    }
}

/**
 * Open the legacy store and flush the WAL into the main file with
 * `PRAGMA wal_checkpoint(TRUNCATE)`. Idempotent: on non-WAL stores the
 * checkpoint is a no-op (SQLite returns busy=0,log=-1,checkpointed=-1).
 *
 * Codex review #34 P1: a busy=1 result means another connection blocked
 * the checkpoint; copying only store.db would lose WAL pages. We treat
 * busy=1 as an error so the caller surfaces a refusal rather than
 * proceeding with a partial copy. Caller is expected to ensure no other
 * process has the DB open (pre-flight: lifecycleState not 'running';
 * archive-then-wait-for-lock-release for the force flag).
 */
function defaultCheckpointLegacyStore(storeDbPath: string): void {
    const db = new Database(storeDbPath, { readwrite: true })
    try {
        const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number; log?: number; checkpointed?: number } | undefined
        if (row?.busy === 1) {
            throw new Error('wal_checkpoint reported busy=1 - another connection has the legacy store open; refusing to copy partial WAL')
        }
        // For TRUNCATE mode, a fully-merged WAL is signaled by log === 0 AND
        // checkpointed === 0 (or both -1 on non-WAL stores). If log !== -1
        // (so we were in WAL) and log !== checkpointed, some frames were
        // skipped — refuse rather than transplant stale data.
        if (typeof row?.log === 'number' && row.log !== -1 && row.log !== row.checkpointed) {
            throw new Error(`wal_checkpoint did not fully apply: log=${row.log}, checkpointed=${row.checkpointed}`)
        }
    } finally {
        db.close()
    }
}

const DEFAULT_MIN_DWELL_MS = 2_000

async function defaultAwaitLockRelease(storePath: string, timeoutMs: number, minDwellMs: number = DEFAULT_MIN_DWELL_MS): Promise<boolean> {
    // Three-way release check:
    //   1. SQLite BEGIN IMMEDIATE returns BUSY -> another writer
    //   2. file size still changing -> mid-write
    //   3. minimum dwell -> fail-safe for idle-but-not-yet-exited runners
    // The dwell is the only thing protecting against "archive ran, runner
    // is shutting down, no writes in flight, no txn held" — without it
    // the probe + size-stability would both pass instantly and we could
    // copy a store.db whose backing FD is about to be flushed by the
    // exiting subprocess.
    const start = Date.now()
    let lastFileSize = -1
    let stableCount = 0
    const effectiveDwell = Math.min(minDwellMs, Math.max(0, timeoutMs - 250))
    while (Date.now() - start < timeoutMs) {
        const elapsed = Date.now() - start
        const dwellSatisfied = elapsed >= effectiveDwell
        if (dwellSatisfied && !sqliteLockHeldByOtherProcess(storePath) && fileSizeStable()) {
            return true
        }
        await sleep(250)
    }
    return false

    function fileSizeStable(): boolean {
        try {
            const st = statSync(storePath)
            const size = st.size
            if (size === lastFileSize) {
                stableCount += 1
                if (stableCount >= 2) return true
            } else {
                stableCount = 0
                lastFileSize = size
            }
        } catch {
            // File gone = no lock to release.
            return true
        }
        return false
    }
}

/**
 * Read the agent acp single-instance lock under $HAPI_HOME (or the same
 * tmpdir/hapi fallback the CLI guard uses) and report whether a live PID
 * holds it. Mirrors `cli/src/agent/backends/acp/agentCliGuard.ts`
 * (intentionally duplicated — the hub does not depend on the CLI module).
 * Codex review #34 P1.
 */
function defaultIsAgentAcpTransportActive(): { active: boolean; holderPid: number | null } {
    const home = process.env.HAPI_HOME?.trim() || join(tmpdir(), 'hapi')
    const lockDir = join(home, 'locks', 'agent-acp-active')
    const pidPath = join(lockDir, 'pid')
    // Codex review #34 P2 v5: the CLI agent guard creates the lock dir
    // BEFORE writing the pid file (cli/src/agent/backends/acp/agentCliGuard.ts).
    // If we only check the pid file, we report "inactive" during that
    // mid-startup window — and bulk migrations with --force-archive-running
    // would then archive a legacy session before verifyInTempHome() races
    // the same lock and refuses anyway. Treat lock-dir-exists-but-no-pid
    // as ACTIVE so we refuse early, before any side effect.
    const dirExists = existsSync(lockDir)
    if (!dirExists) return { active: false, holderPid: null }
    if (!existsSync(pidPath)) {
        // Lock dir exists, no pid file yet — caller is mid-startup.
        return { active: true, holderPid: null }
    }
    let pid: number
    try {
        const raw = readFileSync(pidPath, 'utf8').trim()
        pid = Number(raw)
        if (!Number.isInteger(pid) || pid <= 0) {
            // Malformed pid file — treat as mid-startup, not stale.
            return { active: true, holderPid: null }
        }
    } catch {
        // Read error — be conservative and treat as active.
        return { active: true, holderPid: null }
    }
    try {
        process.kill(pid, 0)
        return { active: true, holderPid: pid }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // EPERM means the process exists but we can't signal it.
        if (code === 'EPERM') return { active: true, holderPid: pid }
        // Pid file present but pid is dead — genuinely stale, treat as
        // inactive. The probe-side acquireLock will rmSync the stale
        // lock dir on its own first attempt.
        return { active: false, holderPid: null }
    }
}

/**
 * Probe whether SQLite reports a busy/locked store. We open the file
 * readwrite, ask for an IMMEDIATE transaction, then roll back. If another
 * process holds a write lock (legacy launcher running an open ACP
 * connection), SQLite will report SQLITE_BUSY and we return true.
 * Codex review #34 P1: real lock check, not just stat-based stability.
 */
function sqliteLockHeldByOtherProcess(storePath: string): boolean {
    let db: Database | null = null
    try {
        db = new Database(storePath, { readwrite: true })
        db.exec('BEGIN IMMEDIATE')
        db.exec('ROLLBACK')
        return false
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/SQLITE_BUSY|database is locked/i.test(msg)) return true
        // Anything else (corrupted, unreadable) — treat as not-our-busy-lock
        // and let the upstream verify step surface the failure cleanly.
        return false
    } finally {
        try { db?.close() } catch {}
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
