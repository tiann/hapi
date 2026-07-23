/**
 * Hub-side importer for cursor chats discovered on the local
 * `~/.cursor/{chats,acp-sessions}` filesystem.
 *
 * Companion module to the cursor flavor of the multi-agent import picker
 * (`hub/src/web/routes/cursorImport.ts`). The legacy → ACP transplant
 * primitive shipped upstream in `tiann/hapi#844`
 * (`hub/src/cursor/cursorLegacyMigrator.ts`), but that primitive operates on
 * an existing HAPI session row that already references the cursor uuid.
 * For the IMPORT flow there is no pre-existing HAPI row yet — and the
 * spec's strict refusal contract forbids creating one until the
 * verify-probe has passed. This module therefore reuses the verify-probe
 * + transplant pattern in standalone form, mirroring the per-chat code
 * path of `scripts/audit-cursor-acp-verify.ts` (which is committed at
 * branch HEAD and ran 391/391 = 100% pass on the maintainer's
 * real-world chat library before this code shipped).
 *
 * Refusal contract (strict ACP-only):
 *   - The cursor flavor is STRICTLY ACP-only. Verify must pass before
 *     any HAPI row is created. No fallback to stream-json, ever.
 *   - Refusal cases (mirrored in `CursorImportRefusalReason`):
 *       verify_load_failed, missing_on_disk_store, target_already_exists,
 *       already_imported, agent_binary_not_found, verify_timeout,
 *       corrupted_store, ambiguous_legacy_store, internal_error
 *   - On refusal: legacy `store.db` is untouched, no HAPI row is created,
 *     structured error returned to the caller.
 *
 * Discovery covers two on-disk shapes:
 *   - legacy: `~/.cursor/chats/<workspaceHash>/<uuid>/store.db`
 *   - acp:    `~/.cursor/acp-sessions/<uuid>/{store.db, meta.json}`
 *
 * Imports of `legacy` rows transplant to the ACP location via the same
 * cp + meta.json + verify dance the migrator uses. Imports of `acp` rows
 * are no-ops on disk — just a HAPI row pointing at the existing dir.
 */

import { Database } from 'bun:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs'
import { homedir, hostname, platform, tmpdir } from 'node:os'
import { join } from 'node:path'

import { AcpVerifyProbe, type AcpProbeOptions } from './acpVerifyProbe'
import { listLegacyChatStoreCandidates, readLegacyMetaLastUsedModel, checkpointLegacySqliteStore } from './cursorLegacyMigrator'
import type {
    CursorImportableSessionSummary,
    CursorImportRefusalReason,
    CursorImportRowOutcome,
    CursorImportSourceFormat
} from '../web/routes/_agentImport/types'
import type { Store } from '../store'
import type { SyncEngine } from '../sync/syncEngine'

// UUID-ish basename validation: same rule the migrator uses to refuse
// path-traversal in `<wsh>/<cursorSessionId>/store.db`. Importer-facing
// uuids must pass this gate too. See `cursorLegacyMigrator`
// CURSOR_SESSION_ID_RE.
const CURSOR_SESSION_ID_RE = /^[A-Za-z0-9_.-]+$/

const AUTH_FILES = ['cli-config.json', 'agent-cli-state.json', 'acp-config.json']
const DEFAULT_INIT_TIMEOUT_MS = 20_000
const DEFAULT_LOAD_TIMEOUT_MS = 30_000
const DEFAULT_REPLAY_DRAIN_MS = 1_500
const DEFAULT_VERIFY_TIMEOUT_MS = 60_000

const DEFAULT_LIST_LIMIT = 500

export interface CursorImporterDeps {
    /** Resolve the operator's HOME dir. Override in tests. */
    homeDir?: () => string
    /** Recorded hostname (recorded into HAPI session metadata.host). */
    hostName?: () => string
    /** Where to allocate the verify staging temp dir. Default: os.tmpdir(). */
    tmpDir?: () => string
    /** Time source for telemetry. Default: Date.now. */
    now?: () => number
    /**
     * Spawn factory for the verify probe. Override in tests to inject a
     * mock. The second arg is the operator's $HOME so the probe can
     * resolve `agent` under `<home>/.local/bin` even on service-account
     * hub deployments. Mirrors the migrator's `createProbe` factory.
     */
    createProbe?: (env: NodeJS.ProcessEnv, agentLookupHome: string) => AcpVerifyProbe
    /** Override the verify per-RPC + total timeouts. */
    verifyTimeoutMs?: number
    /** Logger sink. Default: silent. */
    logger?: {
        debug: (msg: string, ctx?: unknown) => void
        info: (msg: string, ctx?: unknown) => void
        warn: (msg: string, ctx?: unknown) => void
        error: (msg: string, ctx?: unknown) => void
    }
}

function noopLogger(): NonNullable<CursorImporterDeps['logger']> {
    return { debug() {}, info() {}, warn() {}, error() {} }
}

function reverseLookupWorkspacePath(workspaceHash: string, candidatePaths: string[]): string | null {
    // Cursor's drawer hash is `md5(workspacePath)`. We do not have a
    // reverse map; the dialog accepts the operator-provided path on
    // import for the canonical-drawer check. At discovery time we leave
    // workspacePath null for legacy chats whose meta record does not
    // carry one (older cursor-agent versions).
    for (const path of candidatePaths) {
        if (createHash('md5').update(path).digest('hex') === workspaceHash) {
            return path
        }
    }
    return null
}

function readAcpMetaJson(metaPath: string): { schemaVersion?: number; cwd?: string; title?: string } | null {
    try {
        const raw = readFileSync(metaPath, 'utf-8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        return {
            schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : undefined,
            cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
            title: typeof parsed.title === 'string' ? parsed.title : undefined
        }
    } catch {
        return null
    }
}

function sanityCheckStore(storeDbPath: string): { ok: true } | { ok: false; message: string } {
    let db: Database | null = null
    try {
        db = new Database(storeDbPath, { readonly: true })
        db.query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()
        return { ok: true }
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
        try { db?.close() } catch {}
    }
}

function summarizeSession(args: {
    uuid: string
    storeDbPath: string
    sourceFormat: CursorImportSourceFormat
    workspacePath: string | null
    title: string | null
    sizeBytes: number
    mtimeMs: number
    alreadyImportedHapiSessionId: string | null
}): CursorImportableSessionSummary {
    const fallbackTitle = args.title ?? `cursor:${args.uuid.slice(0, 8)}`
    return {
        id: args.uuid,
        title: fallbackTitle,
        firstUserMessage: null,
        workspacePath: args.workspacePath,
        storeDbPath: args.storeDbPath,
        sourceFormat: args.sourceFormat,
        modifiedAt: args.mtimeMs,
        sizeBytes: args.sizeBytes,
        alreadyImportedHapiSessionId: args.alreadyImportedHapiSessionId
    }
}

function readMetaTitleSafe(storeDbPath: string): string | null {
    const meta = readLegacyMetaLastUsedModel(storeDbPath)
    return meta?.name?.trim() ? meta.name.trim() : null
}

function buildAlreadyImportedIndex(store: Store, namespace: string): Map<string, string> {
    // Map cursorSessionId -> hapiSessionId for every existing cursor-flavored
    // session row in this namespace. Used to flag rows the dialog should
    // render as "already imported" (read-only chip).
    const map = new Map<string, string>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = session.metadata as Record<string, unknown> | null
        if (!metadata) continue
        if (metadata.flavor !== 'cursor') continue
        const csid = metadata.cursorSessionId
        if (typeof csid === 'string' && csid.length > 0) {
            map.set(csid, session.id)
        }
    }
    return map
}

/**
 * Gather workspace paths already known to this namespace so legacy
 * `<md5(path)>` drawers can reverse-lookup a real cwd at discovery time.
 */
export function collectCandidateWorkspacePaths(store: Store, namespace: string): string[] {
    const paths = new Set<string>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = session.metadata as Record<string, unknown> | null
        if (!metadata) continue
        if (typeof metadata.path === 'string' && metadata.path.trim()) {
            paths.add(metadata.path.trim())
        }
        const worktree = metadata.worktree
        if (worktree && typeof worktree === 'object' && !Array.isArray(worktree)) {
            const basePath = (worktree as Record<string, unknown>).basePath
            if (typeof basePath === 'string' && basePath.trim()) {
                paths.add(basePath.trim())
            }
        }
    }
    return Array.from(paths)
}

/**
 * Discover importable cursor sessions from both the legacy and ACP
 * on-disk locations. Returns a deduped, mtime-sorted list capped at
 * `limit` entries. ACP entries take precedence over legacy entries for
 * the same uuid (a successful prior migration should not surface the
 * legacy store as a separate import candidate).
 */
export function listImportableCursorSessions(options: {
    store: Store
    namespace: string
    home: string
    limit?: number
    candidateWorkspacePaths?: string[]
}): CursorImportableSessionSummary[] {
    const home = options.home
    const limit = options.limit ?? DEFAULT_LIST_LIMIT
    const alreadyImportedById = buildAlreadyImportedIndex(options.store, options.namespace)
    const candidateWorkspacePaths = [
        ...(options.candidateWorkspacePaths ?? []),
        ...collectCandidateWorkspacePaths(options.store, options.namespace)
    ]
    const byUuid = new Map<string, CursorImportableSessionSummary>()

    // ACP entries first.
    const acpRoot = join(home, '.cursor', 'acp-sessions')
    if (existsSync(acpRoot)) {
        let entries: string[] = []
        try {
            entries = readdirSync(acpRoot)
        } catch {
            entries = []
        }
        for (const uuid of entries) {
            if (!CURSOR_SESSION_ID_RE.test(uuid) || uuid === '.' || uuid === '..') continue
            const sessionDir = join(acpRoot, uuid)
            const storeDbPath = join(sessionDir, 'store.db')
            const metaPath = join(sessionDir, 'meta.json')
            let stStore
            try {
                stStore = statSync(storeDbPath)
                if (!stStore.isFile()) continue
            } catch {
                continue
            }
            const meta = readAcpMetaJson(metaPath)
            const title = meta?.title ?? readMetaTitleSafe(storeDbPath)
            const workspacePath = meta?.cwd ?? null
            byUuid.set(uuid, summarizeSession({
                uuid,
                storeDbPath,
                sourceFormat: 'acp',
                workspacePath,
                title,
                sizeBytes: stStore.size,
                mtimeMs: stStore.mtimeMs,
                alreadyImportedHapiSessionId: alreadyImportedById.get(uuid) ?? null
            }))
        }
    }

    // Legacy entries — only when an ACP entry for the same uuid is absent.
    const chatsRoot = join(home, '.cursor', 'chats')
    if (existsSync(chatsRoot)) {
        let wshEntries: string[] = []
        try {
            wshEntries = readdirSync(chatsRoot)
        } catch {
            wshEntries = []
        }
        for (const wsh of wshEntries) {
            const wshDir = join(chatsRoot, wsh)
            let wshStat
            try {
                wshStat = statSync(wshDir)
            } catch {
                continue
            }
            if (!wshStat.isDirectory()) continue
            let uuidEntries: string[] = []
            try {
                uuidEntries = readdirSync(wshDir)
            } catch {
                continue
            }
            for (const uuid of uuidEntries) {
                if (!CURSOR_SESSION_ID_RE.test(uuid) || uuid === '.' || uuid === '..') continue
                if (byUuid.has(uuid)) continue // ACP entry already covers this uuid
                const storeDbPath = join(wshDir, uuid, 'store.db')
                let st
                try {
                    st = statSync(storeDbPath)
                    if (!st.isFile()) continue
                } catch {
                    continue
                }
                const title = readMetaTitleSafe(storeDbPath)
                const workspacePath = reverseLookupWorkspacePath(wsh, candidateWorkspacePaths)
                byUuid.set(uuid, summarizeSession({
                    uuid,
                    storeDbPath,
                    sourceFormat: 'legacy',
                    workspacePath,
                    title,
                    sizeBytes: st.size,
                    mtimeMs: st.mtimeMs,
                    alreadyImportedHapiSessionId: alreadyImportedById.get(uuid) ?? null
                }))
            }
        }
    }

    // Import requires a resolvable workspace path (resume needs metadata.path).
    // Hide pathless rows so the dialog never offers a guaranteed refusal.
    return Array.from(byUuid.values())
        .filter((session) => Boolean(session.workspacePath?.trim()))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, limit)
}

function buildImportedSessionMetadata(args: {
    uuid: string
    workspacePath: string | null
    title: string
    hostName: string
}): Record<string, unknown> {
    const now = Date.now()
    return {
        // MetadataSchema (shared/src/schemas.ts) requires path + host.
        path: args.workspacePath ?? '',
        host: args.hostName,
        os: platform(),
        name: args.title,
        summary: { text: args.title, updatedAt: now },
        flavor: 'cursor',
        cursorSessionId: args.uuid,
        // STRICT REFUSAL CONTRACT: any HAPI row created by this path is ACP
        // from birth. Verify-probe must have passed before we reach this
        // code; the cursorAcpRemoteLauncher (already shipped upstream) reads
        // this protocol value to decide which backend to spawn on resume.
        cursorSessionProtocol: 'acp',
        lifecycleState: 'imported',
        lifecycleStateSince: now
    }
}

function rmtreeSafe(path: string): void {
    try {
        rmSync(path, { recursive: true, force: true })
    } catch {
        // best-effort
    }
}

/**
 * Verify a cursor `store.db` is loadable by `agent acp` in an isolated
 * `$HOME`. Mirrors the audit harness shape (scripts/audit-cursor-acp-verify.ts)
 * and the migrator's `verifyInTempHome`. Returns a structured outcome
 * — never throws unless the probe spawn fails in a non-recoverable way.
 */
async function verifyCursorStore(args: {
    uuid: string
    storeDbPath: string
    cwd: string
    sourceHome: string
    deps: CursorImporterDeps
}): Promise<{ kind: 'ok' } | { kind: 'init_failed'; message: string } | { kind: 'load_failed'; message: string } | { kind: 'timeout'; message: string } | { kind: 'spawn_failed'; message: string }> {
    const tmpDir = args.deps.tmpDir ?? (() => tmpdir())
    const verifyTimeoutMs = args.deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    const tmpRoot = mkdtempSync(join(tmpDir(), `hapi-cursor-import-verify-${args.uuid.slice(0, 8)}-`))
    const fakeAcpSessionDir = join(tmpRoot, '.cursor', 'acp-sessions', args.uuid)
    try {
        mkdirSync(fakeAcpSessionDir, { recursive: true })
        copyFileSync(args.storeDbPath, join(fakeAcpSessionDir, 'store.db'))
        writeFileSync(
            join(fakeAcpSessionDir, 'meta.json'),
            JSON.stringify({ schemaVersion: 1, cwd: tmpRoot })
        )
        // Best-effort copy auth files so session/load has credentials to
        // resolve any prior `session/set_model` echo; session/load itself
        // does not need auth, but stderr is quieter when present.
        const realCursor = join(args.sourceHome, '.cursor')
        const fakeCursor = join(tmpRoot, '.cursor')
        for (const f of AUTH_FILES) {
            const src = join(realCursor, f)
            if (existsSync(src)) {
                try { copyFileSync(src, join(fakeCursor, f)) } catch {}
            }
        }

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: tmpRoot,
            HAPI_HOME: tmpRoot,
            NO_COLOR: '1'
        }
        if (process.platform === 'win32') {
            env.USERPROFILE = tmpRoot
            const driveMatch = /^[A-Za-z]:/.exec(tmpRoot)
            if (driveMatch) {
                env.HOMEDRIVE = driveMatch[0]
                env.HOMEPATH = tmpRoot.slice(2)
            } else {
                env.HOMEDRIVE = ''
                env.HOMEPATH = tmpRoot
            }
        }

        const probeFactory = args.deps.createProbe ?? ((env: NodeJS.ProcessEnv, agentLookupHome: string): AcpVerifyProbe => {
            const opts: AcpProbeOptions = {
                env,
                hapiHome: tmpRoot,
                agentLookupHome,
                timeoutMs: DEFAULT_INIT_TIMEOUT_MS
            }
            return new AcpVerifyProbe(opts)
        })
        const probe = probeFactory(env, args.sourceHome)

        try {
            try {
                probe.start()
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                return { kind: 'spawn_failed', message: msg }
            }
            const deadline = Date.now() + verifyTimeoutMs
            const initTimeout = Math.max(1_000, Math.min(DEFAULT_INIT_TIMEOUT_MS, deadline - Date.now()))
            const initResp = await probe.initialize(initTimeout)
            if (!initResp.ok) {
                const msg = initResp.error.message
                if (/^timeout /.test(msg)) return { kind: 'timeout', message: msg }
                return { kind: 'init_failed', message: msg }
            }
            const loadTimeout = Math.max(1_000, Math.min(DEFAULT_LOAD_TIMEOUT_MS, deadline - Date.now()))
            const loadOut = await probe.loadSession(
                { sessionId: args.uuid, cwd: args.cwd, mcpServers: [] },
                DEFAULT_REPLAY_DRAIN_MS,
                loadTimeout
            )
            if (!loadOut.response.ok) {
                const msg = loadOut.response.error.message
                if (/^timeout /.test(msg)) return { kind: 'timeout', message: msg }
                return { kind: 'load_failed', message: msg }
            }
            return { kind: 'ok' }
        } finally {
            await probe.stop()
        }
    } finally {
        rmtreeSafe(tmpRoot)
    }
}

function findAgentBinary(home: string): string | null {
    const candidates = [
        join(home, '.local', 'bin', 'agent'),
        join(home, '.npm-global', 'bin', 'agent')
    ]
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
    }
    // Fallback: PATH lookup is handled inside AcpVerifyProbe.start; we
    // only refuse here if both common install dirs miss AND the PATH
    // also lacks a hit. The probe's own ENOENT becomes spawn_failed and
    // we translate that to agent_binary_not_found at the call site.
    const pathEnv = process.env.PATH ?? ''
    const dirs = pathEnv.split(process.platform === 'win32' ? ';' : ':')
    for (const dir of dirs) {
        if (!dir) continue
        const candidate = join(dir, process.platform === 'win32' ? 'agent.exe' : 'agent')
        if (existsSync(candidate)) return candidate
    }
    return null
}

/**
 * Import a single cursor session. Strict ACP-only refusal: any failure
 * before the HAPI row is written returns a structured outcome with no
 * mutation of disk state outside the per-verify temp dir.
 */
export async function importCursorSession(options: {
    uuid: string
    workspacePath?: string | null
    store: Store
    namespace: string
    home: string
    getSyncEngine?: () => SyncEngine | null
    deps?: CursorImporterDeps
}): Promise<CursorImportRowOutcome> {
    const deps = options.deps ?? {}
    const now = deps.now ?? (() => Date.now())
    const hostNameFn = deps.hostName ?? (() => process.env.HAPI_HOSTNAME?.trim() || hostname())
    const log = deps.logger ?? noopLogger()
    const start = now()

    const failure = (reason: CursorImportRefusalReason, message: string): CursorImportRowOutcome => ({
        ok: false,
        uuid: options.uuid,
        reason,
        message,
        durationMs: now() - start
    })

    if (!CURSOR_SESSION_ID_RE.test(options.uuid) || options.uuid === '.' || options.uuid === '..') {
        return failure('missing_on_disk_store', `cursor uuid '${options.uuid}' fails basename validation`)
    }

    // Pre-flight: refuse if a HAPI row in this namespace already references this uuid.
    const existing = buildAlreadyImportedIndex(options.store, options.namespace)
    const alreadyHapi = existing.get(options.uuid)
    if (alreadyHapi) {
        return failure('already_imported', `cursor session ${options.uuid} is already imported as Hapi session ${alreadyHapi}`)
    }

    // Probe disk for source format. Prefer ACP over legacy when both exist
    // (a prior successful migration removes the legacy source, but a
    // --keep-source migration leaves both — treat the ACP entry as canonical).
    const acpSessionDir = join(options.home, '.cursor', 'acp-sessions', options.uuid)
    const acpStorePath = join(acpSessionDir, 'store.db')
    const acpMetaPath = join(acpSessionDir, 'meta.json')
    let sourceFormat: CursorImportSourceFormat
    let sourceStorePath: string
    let resolvedWorkspacePath: string | null = options.workspacePath ?? null
    if (existsSync(acpStorePath)) {
        sourceFormat = 'acp'
        sourceStorePath = acpStorePath
        if (!resolvedWorkspacePath) {
            const meta = readAcpMetaJson(acpMetaPath)
            resolvedWorkspacePath = meta?.cwd ?? null
        }
    } else {
        const legacy = listLegacyChatStoreCandidates(options.uuid, options.home)
        if (legacy.length === 0) {
            return failure('missing_on_disk_store', `~/.cursor/{chats,acp-sessions} contains no store.db for uuid ${options.uuid} (looked under ${options.home})`)
        }
        if (legacy.length > 1 && !resolvedWorkspacePath) {
            const summary = legacy.map((c) => `${c.workspaceHash} (size=${c.sizeBytes}, mtimeMs=${c.mtimeMs})`).join('; ')
            return failure('ambiguous_legacy_store', `cursor session ${options.uuid} exists in ${legacy.length} workspace-hash drawers; resolve by providing workspacePath. Candidates: ${summary}`)
        }
        if (legacy.length === 1) {
            sourceFormat = 'legacy'
            sourceStorePath = legacy[0].storeDbPath
        } else {
            const canonicalHash = createHash('md5').update(resolvedWorkspacePath!).digest('hex')
            const picked = legacy.find((c) => c.workspaceHash === canonicalHash)
            if (!picked) {
                const summary = legacy.map((c) => `${c.workspaceHash} (size=${c.sizeBytes}, mtimeMs=${c.mtimeMs})`).join('; ')
                return failure('ambiguous_legacy_store', `cursor session ${options.uuid}: provided workspacePath did not resolve to any of the on-disk drawers. Candidates: ${summary}`)
            }
            sourceFormat = 'legacy'
            sourceStorePath = picked.storeDbPath
        }
    }

    if (!resolvedWorkspacePath?.trim()) {
        // ACP meta.json may omit cwd; legacy drawers need an explicit path. Empty
        // metadata.path makes resolveLocalResumeTarget return resume_unavailable.
        return failure(
            'ambiguous_legacy_store',
            `Cursor import (${sourceFormat}) requires workspacePath so the imported HAPI session can be resumed`
        )
    }

    // Cheap sanity: store.db opens as SQLite + has at least one table.
    // Avoids spending a verify spawn on a corrupted/truncated file.
    const sanity = sanityCheckStore(sourceStorePath)
    if (!sanity.ok) {
        return failure('corrupted_store', `cursor session ${options.uuid}: ${sanity.message}`)
    }

    // For legacy: refuse if the ACP target dir already exists (race or partial prior import).
    if (sourceFormat === 'legacy' && existsSync(acpSessionDir)) {
        return failure('target_already_exists', `~/.cursor/acp-sessions/${options.uuid}/ already exists; refusing to overwrite`)
    }

    // Pre-flight: refuse early if the `agent` binary is not findable. The
    // probe would otherwise spawn_failed with ENOENT; this hint is
    // cleaner for the operator's "fix your PATH" toast.
    if (!findAgentBinary(options.home)) {
        const pathHint = process.env.PATH ?? ''
        return failure('agent_binary_not_found', `\`agent\` binary not found under ${options.home}/.local/bin, ${options.home}/.npm-global/bin, or PATH (${pathHint.length > 0 ? pathHint : '<empty>'})`)
    }

    // Verify-probe against an isolated $HOME. STRICT REFUSAL CONTRACT:
    // any non-ok outcome aborts before creating a HAPI row.
    const verifyCwd = resolvedWorkspacePath && resolvedWorkspacePath.length > 0
        ? resolvedWorkspacePath
        : options.home
    const verifyOut = await verifyCursorStore({
        uuid: options.uuid,
        storeDbPath: sourceStorePath,
        cwd: verifyCwd,
        sourceHome: options.home,
        deps
    })
    if (verifyOut.kind === 'spawn_failed') {
        // ENOENT here is the agent_binary_not_found case; non-ENOENT is
        // internal_error because the binary existed in pre-flight but
        // could not be spawned.
        if (/ENOENT|not found|could not be spawned/i.test(verifyOut.message)) {
            return failure('agent_binary_not_found', verifyOut.message)
        }
        return failure('internal_error', `verify-probe spawn failed: ${verifyOut.message}`)
    }
    if (verifyOut.kind === 'init_failed') {
        return failure('verify_load_failed', `agent acp initialize failed: ${verifyOut.message}`)
    }
    if (verifyOut.kind === 'load_failed') {
        return failure('verify_load_failed', `agent acp session/load failed: ${verifyOut.message}`)
    }
    if (verifyOut.kind === 'timeout') {
        return failure('verify_timeout', verifyOut.message)
    }

    // Verify passed. For legacy sessions, transplant store.db → ACP dir.
    // Mirrors the migrator's atomic-mkdir + 0o700 mode + 0o600 store.db
    // mode (see cursorLegacyMigrator.migrateOneWithLock) — these
    // permissions matter on multi-user hosts where ~/.cursor is not
    // owner-private.
    if (sourceFormat === 'legacy') {
        try {
            try {
                checkpointLegacySqliteStore(sourceStorePath)
            } catch (err) {
                return failure(
                    'internal_error',
                    `wal_checkpoint failed before import: ${err instanceof Error ? err.message : String(err)}`
                )
            }
            try {
                const walSt = statSync(`${sourceStorePath}-wal`)
                if (walSt.size > 0) {
                    return failure(
                        'internal_error',
                        'store.db-wal grew between checkpoint and copy; retry after Cursor exits'
                    )
                }
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code
                if (code !== 'ENOENT') {
                    return failure(
                        'internal_error',
                        `could not stat store.db-wal post-checkpoint: ${err instanceof Error ? err.message : String(err)}`
                    )
                }
            }

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
                if (!a.exists && !b.exists) return true
                if (!a.exists || !b.exists) return false
                return a.mtimeMs === b.mtimeMs && a.size === b.size
            }
            const fingerprint = () => ({
                main: fpOf(sourceStorePath),
                wal: fpOf(`${sourceStorePath}-wal`),
                shm: fpOf(`${sourceStorePath}-shm`)
            })
            const before = fingerprint()

            mkdirSync(join(options.home, '.cursor', 'acp-sessions'), { recursive: true })
            try {
                mkdirSync(acpSessionDir, { recursive: false, mode: 0o700 })
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                if (/EEXIST/.test(msg)) {
                    return failure('target_already_exists', `~/.cursor/acp-sessions/${options.uuid}/ already exists (race with concurrent import); refusing to overwrite`)
                }
                throw err
            }
            copyFileSync(sourceStorePath, join(acpSessionDir, 'store.db'))
            const after = fingerprint()
            if (
                !fpEqual(before.main, after.main)
                || !fpEqual(before.wal, after.wal)
                || !fpEqual(before.shm, after.shm)
            ) {
                rmtreeSafe(acpSessionDir)
                return failure(
                    'internal_error',
                    'legacy store changed during import; retry after Cursor exits'
                )
            }
            try { chmodSync(join(acpSessionDir, 'store.db'), 0o600) } catch {}
            const titleFromMeta = readMetaTitleSafe(sourceStorePath)
            const sidecar: Record<string, unknown> = {
                schemaVersion: 1,
                cwd: resolvedWorkspacePath ?? options.home
            }
            if (titleFromMeta) sidecar.title = titleFromMeta
            writeFileSync(join(acpSessionDir, 'meta.json'), JSON.stringify(sidecar), { mode: 0o600 })
            log.info('[cursor-import] transplanted legacy store to ACP location', {
                uuid: options.uuid,
                acpStorePath: join(acpSessionDir, 'store.db')
            })
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            // Rollback our partial dir.
            rmtreeSafe(acpSessionDir)
            return failure('internal_error', `failed to place ACP session dir: ${msg}`)
        }
    }

    // Create the HAPI session row. The strict-ACP contract is now satisfied
    // (verify passed AND, for legacy, transplant succeeded), so this row
    // is ACP from birth — no stream-json HAPI row was ever a possibility.
    const title = readMetaTitleSafe(join(acpSessionDir, 'store.db')) ?? readMetaTitleSafe(sourceStorePath) ?? `cursor:${options.uuid.slice(0, 8)}`
    const metadata = buildImportedSessionMetadata({
        uuid: options.uuid,
        workspacePath: resolvedWorkspacePath,
        title,
        hostName: hostNameFn()
    })
    let hapiSessionId: string
    try {
        const engine = options.getSyncEngine?.() ?? null
        const created = engine?.getOrCreateSession(randomUUID(), metadata, {}, options.namespace)
            ?? options.store.sessions.getOrCreateSession(randomUUID(), metadata, {}, options.namespace)
        hapiSessionId = created.id
        log.info('[cursor-import] created Hapi session for cursor uuid', {
            uuid: options.uuid,
            hapiSessionId,
            sourceFormat
        })
    } catch (err) {
        // Roll back the transplant if we did one but the HAPI row write failed.
        if (sourceFormat === 'legacy') {
            rmtreeSafe(acpSessionDir)
        }
        return failure('internal_error', `failed to create Hapi session row: ${err instanceof Error ? err.message : String(err)}`)
    }

    return {
        ok: true,
        uuid: options.uuid,
        hapiSessionId,
        sourceFormat,
        durationMs: now() - start
    }
}

/**
 * Batch-import wrapper: each row's outcome is independent — one failing
 * does not abort the batch. Mirrors the codex importer's
 * `importSelectedCodexSessions` shape so the dialog can render per-row
 * results uniformly.
 */
export async function importSelectedCursorSessions(options: {
    uuids?: string[]
    selections?: Array<{ uuid: string; workspacePath?: string | null }>
    workspacePath?: string | null
    store: Store
    namespace: string
    home: string
    getSyncEngine?: () => SyncEngine | null
    deps?: CursorImporterDeps
}): Promise<{ results: CursorImportRowOutcome[]; importedCount: number }> {
    const selections = options.selections?.length
        ? options.selections
        : (options.uuids ?? []).map((uuid) => ({
            uuid,
            workspacePath: options.workspacePath
        }))

    const results: CursorImportRowOutcome[] = []
    for (const selection of selections) {
        const outcome = await importCursorSession({
            uuid: selection.uuid,
            workspacePath: selection.workspacePath ?? options.workspacePath,
            store: options.store,
            namespace: options.namespace,
            home: options.home,
            getSyncEngine: options.getSyncEngine,
            deps: options.deps
        })
        results.push(outcome)
    }
    const importedCount = results.filter((r) => r.ok).length
    return { results, importedCount }
}
