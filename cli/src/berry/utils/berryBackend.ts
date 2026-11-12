import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { AcpSdkBackend } from '@/agent/backends/acp'
import { logger } from '@/ui/logger'
import { resolveHapiHomeDir } from '@/configuration'

type BerryAcpEnvironment = Record<string, string | undefined>

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
}

function parseArgsJson(raw: string): string[] {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        throw new Error('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
    }
    if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
        throw new Error('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
    }
    return value
}

/** Default ACP entrypoint: the `berry` CLI exposes ACP as the `acp` subcommand. */
export const BERRY_DEFAULT_ACP_COMMAND = 'berry'
export const BERRY_DEFAULT_ACP_ARGS = ['acp']

export function resolveBerryAcpCommand(env: BerryAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    const override = env.HAPI_BERRY_ACP_COMMAND?.trim()
    const command = override || BERRY_DEFAULT_ACP_COMMAND
    if (env.HAPI_BERRY_ACP_ARGS_JSON?.trim()) {
        return { command, args: parseArgsJson(env.HAPI_BERRY_ACP_ARGS_JSON.trim()) }
    }
    // An explicitly configured server keeps bare `[]` args: custom wrappers
    // must not silently receive the official CLI's `acp` subcommand.
    if (override) return { command, args: [] }
    return { command, args: BERRY_DEFAULT_ACP_ARGS }
}

/**
 * Dedicated data dir for berry agents spawned by HAPI, isolated from the
 * user's interactive berry (`~/.berry-agent` by default).
 *
 * Berry persists TWO sticky things inside its dataDir: `tool-policy.json`
 * (allow_always permission answers are remembered permanently) and
 * `sessions.db` (every session it ever created). Sharing the interactive
 * dataDir with HAPI-spawned agents would let a sticky allow granted in a
 * HAPI session auto-approve tools in the user's terminal berry (and vice
 * versa) and pollute the interactive session list with HAPI rows. Keying
 * the directory by the HAPI row id additionally scopes sticky grants to
 * the HAPI session that made them, while staying stable across backend
 * respawns and runner restarts (the row id outlives both, so
 * `session/load` always finds the session in the same sessions.db).
 *
 * The isolation intentionally does NOT strand the user's provider setup
 * or installed skills: {@link ensureBerryDataDir} seeds a freshly created
 * dir with the interactive dir's provider configuration (custom
 * providers + stored API keys, snapshotted consistently) and its skills
 * tree — everything berry resolves strictly relative to its data dir.
 */
export function resolveBerryDataDir(
    sessionId?: string | null,
    env: BerryAcpEnvironment = process.env
): string {
    const base = join(resolveHapiHomeDir(env), 'berry-data')
    return join(base, sessionId && sessionId.length > 0 ? sessionId : 'default')
}

/**
 * The interactive berry data dir berry itself defaults to when
 * `BERRY_AGENT_DATA_DIR` is unset (berry `persist/paths.ts`:
 * `$HOME/.berry-agent`).
 */
export function resolveInteractiveBerryDataDir(env: BerryAcpEnvironment = process.env): string {
    const home = env.HOME ?? env.USERPROFILE ?? homedir()
    return join(home, '.berry-agent')
}

const BERRY_SETTINGS_BASENAME = 'settings.json'
const BERRY_CUSTOM_PROVIDERS_KEY = 'customProviders'
const BERRY_SESSIONS_DB_BASENAME = 'sessions.db'
const BERRY_SKILLS_DIR_BASENAME = 'skills'

function warnSeedSkipped(what: string, error: unknown): void {
    logger.warn(
        `[berry] data-dir seed skipped (${what}): ${error instanceof Error ? error.message : String(error)}`
    )
}

function copyCredentialFile(sourceDir: string, dataDir: string, basename: string): void {
    const source = join(sourceDir, basename)
    const target = join(dataDir, basename)
    if (!existsSync(source) || existsSync(target)) return
    const staging = join(dataDir, `${basename}.hapi-seed-${process.pid}`)
    try {
        copyFileSync(source, staging)
        renameSync(staging, target)
    } catch (error) {
        warnSeedSkipped(basename, error)
        try {
            unlinkSync(staging)
        } catch {
            // Best effort: a stale staging file is inert to berry.
        }
    }
}

/* ------------------------------------------------------------------ *
 * Consistent sessions.db snapshot                                    *
 * ------------------------------------------------------------------ */

/**
 * Structural slice of a sqlite connection used by the snapshot ladder.
 * Both bun:sqlite's `Database` and node:sqlite's `DatabaseSync` fit.
 */
export interface SqliteSnapshotConnection {
    exec(sql: string): unknown
    /** Single-row reader for `PRAGMA`/aggregate probes (e.g. wal_checkpoint). */
    readOne(sql: string): Record<string, unknown> | undefined
    /** All-rows reader (used by the seed tests to inspect a snapshotted store). */
    readAll(sql: string): unknown[]
    close(): void
}

type SqliteSnapshotOpener = (path: string, mode: 'readonly' | 'readwrite') => SqliteSnapshotConnection

interface RawSqliteStatement {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
}

interface RawSqliteConnection {
    exec(sql: string): unknown
    query?(sql: string): RawSqliteStatement
    prepare?(sql: string): RawSqliteStatement
    close(): void
}

/** Adapter normalizing bun:sqlite (`query`) and node:sqlite (`prepare`). */
function adaptSqliteConnection(db: RawSqliteConnection): SqliteSnapshotConnection {
    const statement = db.query ?? db.prepare
    return {
        exec: (sql) => db.exec(sql),
        readOne: (sql) => {
            if (!statement) return undefined
            const row = statement.call(db, sql).get()
            return row !== null && typeof row === 'object' ? row as Record<string, unknown> : undefined
        },
        readAll: (sql) => (statement ? statement.call(db, sql).all() : []),
        close: () => db.close()
    }
}

let cachedSqliteOpener: SqliteSnapshotOpener | null | undefined

/**
 * Synchronously load a sqlite binding for the snapshot ladder:
 * `bun:sqlite` first (the runtime the hapi CLI ships on), then
 * `node:sqlite` (test rigs run this code under Node's vitest). Returns
 * null when neither exists — the caller then SKIPS the database seed
 * instead of falling back to a racy db+WAL pair copy.
 *
 * Exported for the test rig, which uses the same loader to build real
 * (WAL-mode) interactive-store fixtures regardless of the runtime.
 */
export function loadSqliteOpener(): SqliteSnapshotOpener | null {
    if (cachedSqliteOpener !== undefined) return cachedSqliteOpener
    const requireModule = createRequire(import.meta.url)
    let opener: SqliteSnapshotOpener | null = null
    try {
        const { Database } = requireModule('bun:sqlite') as {
            Database: new (path: string, options?: { readonly?: boolean }) => RawSqliteConnection
        }
        opener = (path, mode) => adaptSqliteConnection(
            mode === 'readonly' ? new Database(path, { readonly: true }) : new Database(path)
        )
    } catch {
        try {
            const { DatabaseSync } = requireModule('node:sqlite') as {
                DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => RawSqliteConnection
            }
            opener = (path, mode) => adaptSqliteConnection(
                mode === 'readonly'
                    ? new DatabaseSync(path, { readOnly: true })
                    : new DatabaseSync(path)
            )
        } catch {
            opener = null
        }
    }
    cachedSqliteOpener = opener
    return opener
}

/** Test-only override of the cached sqlite opener (undefined restores default). */
export function overrideSqliteOpenerForTests(opener: SqliteSnapshotOpener | null | undefined): void {
    cachedSqliteOpener = opener
}

/** SQL string literal (single quotes doubled per SQL rules). */
function sqlStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`
}

/**
 * One `VACUUM INTO` attempt. VACUUM INTO reads a consistent snapshot of
 * the source (same semantics as the online backup API: safe even while
 * another process commits) and writes a single self-contained database
 * file — no WAL sidecar needs to ride along, so there is no db/WAL
 * pairing to get wrong. Refuses to overwrite, so a stale staging file is
 * removed first. A `readonly` open never mutates the source's db/WAL
 * bytes (a reader-managed `-shm` may appear, as with any sqlite reader);
 * the `readwrite` leg exists because some hot-WAL shapes (a crashed
 * writer left no `-shm`) refuse read-only opens — opening read-write
 * then only rebuilds the WAL index (berry runs the store in WAL mode,
 * where recovery writes no pages; a legacy rollback journal would be
 * rolled back, exactly what the next real berry open does anyway).
 */
function tryVacuumIntoSnapshot(
    opener: SqliteSnapshotOpener,
    source: string,
    staging: string,
    mode: 'readonly' | 'readwrite'
): boolean {
    try {
        unlinkSync(staging)
    } catch {
        // No stale staging: fine.
    }
    let db: SqliteSnapshotConnection | null = null
    try {
        db = opener(source, mode)
        db.exec(`VACUUM INTO ${sqlStringLiteral(staging)}`)
        return true
    } catch {
        return false
    } finally {
        if (db) {
            try {
                db.close()
            } catch {
                // Already closed on error paths.
            }
        }
    }
}

/**
 * Checkpoint fallback when VACUUM INTO is unavailable: flush the source's
 * WAL into the main file (`wal_checkpoint(TRUNCATE)` — physically
 * mutating but logically neutral, what sqlite itself does constantly),
 * then copy the single self-contained file. Refuses when the checkpoint
 * reports busy or a partial apply (a writer blocked it): copying the db
 * alone would then silently lose that writer's committed pages.
 */
function tryCheckpointedCopy(
    opener: SqliteSnapshotOpener,
    source: string,
    staging: string
): boolean {
    let db: SqliteSnapshotConnection | null = null
    try {
        unlinkSync(staging)
        db = opener(source, 'readwrite')
        const row = db.readOne('PRAGMA wal_checkpoint(TRUNCATE)')
        if (row?.busy === 1) return false
        if (typeof row?.log === 'number' && row.log !== -1 && row.log !== row.checkpointed) {
            return false
        }
        copyFileSync(source, staging)
        return true
    } catch {
        return false
    } finally {
        if (db) {
            try {
                db.close()
            } catch {
                // Already closed on error paths.
            }
        }
    }
}

/**
 * Seed the isolated dir's `sessions.db` from the interactive store as a
 * CONSISTENT single-file snapshot. Copying `sessions.db` and its WAL
 * sidecar as two separate files (the pre-snapshot behavior) can pair a
 * database with frames committed against a different database state: a
 * checkpoint running between the two copies leaves WAL frames that pass
 * SQLite's structural checks but replay onto stale pages — a chimera
 * store that can resurrect or drop credential rows. The snapshot ladder
 * avoids the pairing entirely; any failure degrades to skipping the
 * database seed (berry still boots on an empty dir; custom providers and
 * `secret.key` still migrate) rather than risking an inconsistent copy.
 */
function seedSessionsStoreSnapshot(sourceDir: string, dataDir: string): void {
    const source = join(sourceDir, BERRY_SESSIONS_DB_BASENAME)
    const target = join(dataDir, BERRY_SESSIONS_DB_BASENAME)
    if (!existsSync(source) || existsSync(target)) return
    const staging = join(dataDir, `${BERRY_SESSIONS_DB_BASENAME}.hapi-seed-${process.pid}`)
    const opener = loadSqliteOpener()
    if (opener) {
        const snapshotted = tryVacuumIntoSnapshot(opener, source, staging, 'readonly')
            || tryVacuumIntoSnapshot(opener, source, staging, 'readwrite')
            || tryCheckpointedCopy(opener, source, staging)
        if (!snapshotted) {
            try {
                unlinkSync(staging)
            } catch {
                // Best effort: a stale staging file is inert to berry.
            }
            warnSeedSkipped(
                BERRY_SESSIONS_DB_BASENAME,
                new Error('consistent snapshot unavailable (VACUUM INTO and wal_checkpoint both refused)')
            )
            return
        }
        // Berry enforces 0600 on its store files; meet it so the seeded
        // copy does not trigger its permission self-repair warnings.
        try {
            chmodSync(staging, 0o600)
        } catch {
            // Best effort: berry repairs the mode itself at boot.
        }
        try {
            renameSync(staging, target)
        } catch (error) {
            warnSeedSkipped(BERRY_SESSIONS_DB_BASENAME, error)
            try {
                unlinkSync(staging)
            } catch {
                // Best effort: a stale staging file is inert to berry.
            }
        }
        return
    }
    warnSeedSkipped(
        BERRY_SESSIONS_DB_BASENAME,
        new Error('no sqlite module available (bun:sqlite / node:sqlite); skipping rather than copying a racy db+WAL pair')
    )
}

/**
 * Seed the isolated dir's skills root from the interactive profile.
 *
 * Berry's skill discovery builds its standard layers from the data dir
 * (`createStandardLayers` user layer = `<dataDir>/skills`), so isolating
 * `BERRY_AGENT_DATA_DIR` alone makes every skill the user installed in
 * `~/.berry-agent/skills` invisible to HAPI sessions. On first creation
 * of the isolated dir the tree is copied in — same semantics as the
 * credential seed: copy-on-create (idempotent, never overwrites anything
 * berry wrote), failure degrades to an empty skills root with a warning.
 *
 * A copy, deliberately not a symlink: the interactive skills root stays
 * authoritative for the user's terminal berry, and a symlinked root
 * would leak any future write berry makes through the isolated dir back
 * into the interactive profile — exactly the cross-contamination the
 * isolation exists to prevent.
 */
function seedSkillsTree(sourceDir: string, dataDir: string): void {
    const source = join(sourceDir, BERRY_SKILLS_DIR_BASENAME)
    const target = join(dataDir, BERRY_SKILLS_DIR_BASENAME)
    if (!existsSync(source) || existsSync(target)) return
    const staging = join(dataDir, `${BERRY_SKILLS_DIR_BASENAME}.hapi-seed-${process.pid}`)
    try {
        cpSync(source, staging, { recursive: true })
        renameSync(staging, target)
    } catch (error) {
        warnSeedSkipped(BERRY_SKILLS_DIR_BASENAME, error)
        try {
            rmSync(staging, { recursive: true, force: true })
        } catch {
            // Best effort: a stale staging directory is inert to berry.
        }
    }
}

function seedProviderSettings(sourceDir: string, dataDir: string): void {
    const source = join(sourceDir, BERRY_SETTINGS_BASENAME)
    const target = join(dataDir, BERRY_SETTINGS_BASENAME)
    if (!existsSync(source) || existsSync(target)) return
    try {
        const parsed: unknown = JSON.parse(readFileSync(source, 'utf8'))
        const customProviders = (parsed as Record<string, unknown> | null)?.[BERRY_CUSTOM_PROVIDERS_KEY]
        if (
            customProviders === undefined || customProviders === null
            || typeof customProviders !== 'object' || Array.isArray(customProviders)
            || Object.keys(customProviders).length === 0
        ) {
            return
        }
        // Only the provider-config key rides over. Berry's settings file
        // also carries its own sandbox/approval defaults for the user's
        // interactive setup; those must not change how HAPI-spawned
        // sessions gate tools.
        const staging = join(dataDir, `${BERRY_SETTINGS_BASENAME}.hapi-seed-${process.pid}`)
        writeFileSync(
            staging,
            `${JSON.stringify({ [BERRY_CUSTOM_PROVIDERS_KEY]: customProviders }, null, 2)}\n`,
            'utf8'
        )
        renameSync(staging, target)
    } catch (error) {
        warnSeedSkipped(BERRY_SETTINGS_BASENAME, error)
    }
}

/**
 * Create the isolated berry data dir and, on FIRST creation only, seed it
 * with the user's provider configuration and skills from the interactive
 * data dir (see {@link resolveInteractiveBerryDataDir}).
 *
 * Without the seed, upgrading to isolated dirs drops every configured
 * provider: berry resolves `settings.json` custom providers, the
 * credentials store (`sessions.db` + `secret.key`), and its user skills
 * root (`<dataDir>/skills`) strictly relative to the data dir, so a
 * fresh directory means "no custom providers, no stored API keys, no
 * installed skills". The seed is a one-time copy-on-create — it never
 * runs again for a directory that already exists (idempotent across
 * respawns and runner restarts, and it never overwrites anything berry
 * wrote), never copies `tool-policy.json` (sticky permission grants are
 * exactly what the isolation exists to contain), takes the credentials
 * store as a consistent single-file snapshot (see
 * {@link seedSessionsStoreSnapshot}), and any failure degrades to the
 * previous behavior (empty dir; berry still boots) with a warning.
 */
export function ensureBerryDataDir(dataDir: string, env: BerryAcpEnvironment = process.env): void {
    const created = !existsSync(dataDir)
    // Berry manages the contents; HAPI only guarantees the directory
    // exists before the child first resolves its dataDir. Idempotent
    // across respawns.
    mkdirSync(dataDir, { recursive: true })
    if (!created) return
    const sourceDir = resolveInteractiveBerryDataDir(env)
    if (sourceDir === dataDir) return
    seedSessionsStoreSnapshot(sourceDir, dataDir)
    copyCredentialFile(sourceDir, dataDir, 'secret.key')
    seedSkillsTree(sourceDir, dataDir)
    seedProviderSettings(sourceDir, dataDir)
}

/**
 * Spawn-time env overlay for the berry ACP child. Berry reads both levers
 * ONLY at process spawn (there is no runtime RPC for either):
 * - `BERRY_AGENT_MODEL` — the model lever (id format `provider/model-id`);
 * - `BERRY_AGENT_DATA_DIR` — the isolated data dir (see
 *   {@link resolveBerryDataDir}).
 *
 * A machine-level value already present in the env wins, mirroring
 * `dshPermissionModeEnvOverlay`'s respect for explicit operator env: an
 * operator pinning `BERRY_AGENT_MODEL` on the machine profile keeps
 * control regardless of the session's model preference.
 */
export function berrySpawnEnvOverlay(
    opts: { model?: string; dataDir?: string },
    env: BerryAcpEnvironment = process.env
): Record<string, string> {
    const overlay: Record<string, string> = {}
    if (opts.model && !env.BERRY_AGENT_MODEL) {
        overlay.BERRY_AGENT_MODEL = opts.model
    }
    if (opts.dataDir && !env.BERRY_AGENT_DATA_DIR) {
        overlay.BERRY_AGENT_DATA_DIR = opts.dataDir
    }
    return overlay
}

export function createBerryBackend(
    env: NodeJS.ProcessEnv = process.env,
    opts: { model?: string; dataDir?: string } = {}
): AcpSdkBackend {
    const { command, args } = resolveBerryAcpCommand(env)
    const overlay = berrySpawnEnvOverlay(opts, env)
    if (overlay.BERRY_AGENT_DATA_DIR) {
        ensureBerryDataDir(overlay.BERRY_AGENT_DATA_DIR, env)
    }
    return new AcpSdkBackend({
        command,
        args,
        env: filterEnv({ ...env, ...overlay }),
        flavor: 'berry',
        // Berry's agent_message_chunk stream is a pure DELTA stream: the
        // default overlap dedupe treats repeated tokens (a later "0" after
        // "300") as an already-buffered suffix and drops them, corrupting
        // the transcript (grok streams the same way).
        textChunkMode: 'delta'
    })
}
