/**
 * Cursor session import discovery + prepare for machine RPC.
 * Hub must not scan its own ~/.cursor; runner owns on-disk cursor state.
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
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
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrepareCursorImportRpcResponse } from '@hapi/protocol/apiTypes'
import { AcpVerifyProbe, type AcpProbeOptions } from '@/cursor/acpVerifyProbe'

const CURSOR_SESSION_ID_RE = /^[A-Za-z0-9_.-]+$/
const AUTH_FILES = ['cli-config.json', 'agent-cli-state.json', 'acp-config.json']
const DEFAULT_INIT_TIMEOUT_MS = 20_000
const DEFAULT_LOAD_TIMEOUT_MS = 30_000
const DEFAULT_REPLAY_DRAIN_MS = 1_500
const DEFAULT_VERIFY_TIMEOUT_MS = 60_000
const DEFAULT_LIST_LIMIT = 500

export type CursorImportSourceFormat = 'legacy' | 'acp'

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

export interface LegacyStoreCandidate {
    workspaceHash: string
    storeDbPath: string
    sizeBytes: number
    mtimeMs: number
}

export interface CursorImportableSessionSummary {
    id: string
    title: string
    firstUserMessage?: string | null
    workspacePath?: string | null
    storeDbPath: string
    sourceFormat: CursorImportSourceFormat
    modifiedAt: number
    sizeBytes: number
    alreadyImportedHapiSessionId?: string | null
}

export interface CursorImportSessionsDeps {
    homeDir?: () => string
    hostName?: () => string
    tmpDir?: () => string
    now?: () => number
    createProbe?: (env: NodeJS.ProcessEnv, agentLookupHome: string) => AcpVerifyProbe
    verifyTimeoutMs?: number
    logger?: {
        debug: (msg: string, ctx?: unknown) => void
        info: (msg: string, ctx?: unknown) => void
        warn: (msg: string, ctx?: unknown) => void
        error: (msg: string, ctx?: unknown) => void
    }
}

function noopLogger(): NonNullable<CursorImportSessionsDeps['logger']> {
    return { debug() {}, info() {}, warn() {}, error() {} }
}

function decodeMetaValue(value: string): Record<string, unknown> | null {
    if (value.startsWith('{')) {
        try { return JSON.parse(value) as Record<string, unknown> } catch {}
    }
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

export function listLegacyChatStoreCandidates(cursorSessionId: string, home: string): LegacyStoreCandidate[] {
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
            lastUsedModel: typeof decoded.lastUsedModel === 'string' && decoded.lastUsedModel.trim().length > 0
                ? decoded.lastUsedModel.trim()
                : undefined
        }
    } catch {
        return null
    } finally {
        try { metaDb?.close() } catch {}
    }
}

export function checkpointLegacySqliteStore(storeDbPath: string): void {
    const db = new Database(storeDbPath, { readwrite: true })
    try {
        const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number; log?: number; checkpointed?: number } | undefined
        if (row?.busy === 1) {
            throw new Error('wal_checkpoint reported busy=1 - another connection has the legacy store open; refusing to copy partial WAL')
        }
        if (typeof row?.log === 'number' && row.log !== -1 && row.log !== row.checkpointed) {
            throw new Error(`wal_checkpoint did not fully apply: log=${row.log}, checkpointed=${row.checkpointed}`)
        }
    } finally {
        db.close()
    }
}

function reverseLookupWorkspacePath(workspaceHash: string, candidatePaths: string[]): string | null {
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

function readMetaTitleSafe(storeDbPath: string): string | null {
    const meta = readLegacyMetaLastUsedModel(storeDbPath)
    return meta?.name?.trim() ? meta.name.trim() : null
}

function summarizeSession(args: {
    uuid: string
    storeDbPath: string
    sourceFormat: CursorImportSourceFormat
    workspacePath: string | null
    title: string | null
    sizeBytes: number
    mtimeMs: number
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
        alreadyImportedHapiSessionId: null
    }
}

export function listCursorImportableSessionsOnDisk(options: {
    home: string
    candidateWorkspacePaths?: string[]
    limit?: number
}): CursorImportableSessionSummary[] {
    const home = options.home
    const limit = options.limit ?? DEFAULT_LIST_LIMIT
    const candidateWorkspacePaths = options.candidateWorkspacePaths ?? []
    const byUuid = new Map<string, CursorImportableSessionSummary>()

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
                mtimeMs: stStore.mtimeMs
            }))
        }
    }

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
                if (byUuid.has(uuid)) continue
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
                    mtimeMs: st.mtimeMs
                }))
            }
        }
    }

    return Array.from(byUuid.values())
        .filter((session) => Boolean(session.workspacePath?.trim()))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, limit)
}

function rmtreeSafe(path: string): void {
    try {
        rmSync(path, { recursive: true, force: true })
    } catch {
        // best-effort
    }
}

async function verifyCursorStore(args: {
    uuid: string
    storeDbPath: string
    cwd: string
    sourceHome: string
    deps: CursorImportSessionsDeps
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
            JSON.stringify({ schemaVersion: 1, cwd: args.cwd })
        )
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

        const probeFactory = args.deps.createProbe ?? ((probeEnv: NodeJS.ProcessEnv, agentLookupHome: string): AcpVerifyProbe => {
            const opts: AcpProbeOptions = {
                env: probeEnv,
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
    const pathEnv = process.env.PATH ?? ''
    const dirs = pathEnv.split(process.platform === 'win32' ? ';' : ':')
    for (const dir of dirs) {
        if (!dir) continue
        const candidate = join(dir, process.platform === 'win32' ? 'agent.exe' : 'agent')
        if (existsSync(candidate)) return candidate
    }
    return null
}

type SqliteStoreFileFp = { exists: true; mtimeMs: number; size: number } | { exists: false }

function fpOfSqliteSibling(p: string): SqliteStoreFileFp {
    try {
        const st = statSync(p)
        return { exists: true, mtimeMs: st.mtimeMs, size: st.size }
    } catch {
        return { exists: false }
    }
}

function fpEqualSqliteSibling(a: SqliteStoreFileFp, b: SqliteStoreFileFp): boolean {
    if (!a.exists && !b.exists) return true
    if (!a.exists || !b.exists) return false
    return a.mtimeMs === b.mtimeMs && a.size === b.size
}

function fingerprintSqliteStoreFamily(storeDbPath: string): {
    main: SqliteStoreFileFp
    wal: SqliteStoreFileFp
    shm: SqliteStoreFileFp
} {
    return {
        main: fpOfSqliteSibling(storeDbPath),
        wal: fpOfSqliteSibling(`${storeDbPath}-wal`),
        shm: fpOfSqliteSibling(`${storeDbPath}-shm`)
    }
}

function prepareLegacyStoreForImport(storeDbPath: string): { ok: true; fingerprint: ReturnType<typeof fingerprintSqliteStoreFamily> } | { ok: false; message: string } {
    try {
        checkpointLegacySqliteStore(storeDbPath)
    } catch (err) {
        return {
            ok: false,
            message: `wal_checkpoint failed before import: ${err instanceof Error ? err.message : String(err)}`
        }
    }
    try {
        const walSt = statSync(`${storeDbPath}-wal`)
        if (walSt.size > 0) {
            return {
                ok: false,
                message: 'store.db-wal grew between checkpoint and copy; retry after Cursor exits'
            }
        }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
            return {
                ok: false,
                message: `could not stat store.db-wal post-checkpoint: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    }
    return { ok: true, fingerprint: fingerprintSqliteStoreFamily(storeDbPath) }
}

export async function prepareCursorImportOnDisk(options: {
    uuid: string
    workspacePath?: string | null
    home: string
    deps?: CursorImportSessionsDeps
}): Promise<PrepareCursorImportRpcResponse> {
    const deps = options.deps ?? {}
    const now = deps.now ?? (() => Date.now())
    const hostNameFn = deps.hostName ?? (() => process.env.HAPI_HOSTNAME?.trim() || hostname())
    const log = deps.logger ?? noopLogger()
    const start = now()

    const failure = (reason: CursorImportRefusalReason, message: string): PrepareCursorImportRpcResponse => ({
        success: false,
        uuid: options.uuid,
        reason,
        message,
        durationMs: now() - start
    })

    if (!CURSOR_SESSION_ID_RE.test(options.uuid) || options.uuid === '.' || options.uuid === '..') {
        return failure('missing_on_disk_store', `cursor uuid '${options.uuid}' fails basename validation`)
    }

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
        return failure(
            'ambiguous_legacy_store',
            `Cursor import (${sourceFormat}) requires workspacePath so the imported HAPI session can be resumed`
        )
    }

    const sanity = sanityCheckStore(sourceStorePath)
    if (!sanity.ok) {
        return failure('corrupted_store', `cursor session ${options.uuid}: ${sanity.message}`)
    }

    if (sourceFormat === 'legacy' && existsSync(acpSessionDir)) {
        return failure('target_already_exists', `~/.cursor/acp-sessions/${options.uuid}/ already exists; refusing to overwrite`)
    }

    if (!findAgentBinary(options.home)) {
        const pathHint = process.env.PATH ?? ''
        return failure('agent_binary_not_found', `\`agent\` binary not found under ${options.home}/.local/bin, ${options.home}/.npm-global/bin, or PATH (${pathHint.length > 0 ? pathHint : '<empty>'})`)
    }

    let legacyBaseline: ReturnType<typeof fingerprintSqliteStoreFamily> | null = null
    if (sourceFormat === 'legacy') {
        const prepared = prepareLegacyStoreForImport(sourceStorePath)
        if (!prepared.ok) {
            return failure('internal_error', prepared.message)
        }
        legacyBaseline = prepared.fingerprint
    }

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

    if (sourceFormat === 'legacy') {
        try {
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
            const after = fingerprintSqliteStoreFamily(sourceStorePath)
            if (
                !legacyBaseline
                || !fpEqualSqliteSibling(legacyBaseline.main, after.main)
                || !fpEqualSqliteSibling(legacyBaseline.wal, after.wal)
                || !fpEqualSqliteSibling(legacyBaseline.shm, after.shm)
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
            rmtreeSafe(acpSessionDir)
            return failure('internal_error', `failed to place ACP session dir: ${msg}`)
        }
    }

    const title = readMetaTitleSafe(join(acpSessionDir, 'store.db')) ?? readMetaTitleSafe(sourceStorePath) ?? `cursor:${options.uuid.slice(0, 8)}`
    return {
        success: true,
        uuid: options.uuid,
        sourceFormat,
        workspacePath: resolvedWorkspacePath,
        title,
        hostName: hostNameFn(),
        durationMs: now() - start
    }
}
