#!/usr/bin/env bun
/**
 * Offline DB compactor: retroactively applies the message content codec
 * (truncate oversized agent tool output + zstd-compress content, see
 * hub/src/store/contentCodec.ts) to an existing hapi.db, then VACUUMs.
 *
 * The source database is only ever opened read-only. All work happens on a
 * snapshot; the result is written to a NEW file which you swap in manually.
 *
 * Usage:
 *   bun run hub/scripts/compact-db.ts [options]
 *
 * Options:
 *   --db=PATH          Source database (default: $HAPI_HOME/hapi.db or ~/.hapi/hapi.db)
 *   --out=PATH         Output path (default: <db>.compacted)
 *   --keep-oversized   Do not truncate oversized agent output, compress only
 *   --force            Overwrite an existing output file
 *   --help             Show this help
 *
 * Swap procedure (after the script succeeds):
 *   1. Stop the hub (and re-run this script if it wrote during the run)
 *   2. mv ~/.hapi/hapi.db ~/.hapi/hapi.db.pre-compact
 *   3. mv ~/.hapi/hapi.db.compacted ~/.hapi/hapi.db
 *   4. rm -f ~/.hapi/hapi.db-wal ~/.hapi/hapi.db-shm   (they belong to the old file)
 *   5. Start the hub; keep the .pre-compact backup until satisfied
 */

import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
    COMPRESS_MIN_CHARS,
    compressContentJson,
    decodeMessageContent,
    truncateOversizedMessageContent
} from '../src/store/contentCodec'

/** Minimum schema version this script understands; also what it stamps, since
 *  compressed BLOB content is a V16 concept (see Store.migrateFromV15ToV16). */
const CODEC_SCHEMA_VERSION = 16

function getDefaultDbPath(): string {
    const dataDir = process.env.HAPI_HOME
        ? process.env.HAPI_HOME.replace(/^~/, homedir())
        : join(homedir(), '.hapi')
    return join(dataDir, 'hapi.db')
}

function parseArgs(argv: string[]) {
    const args = { db: getDefaultDbPath(), out: '', keepOversized: false, force: false, help: false }
    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') args.help = true
        else if (arg === '--keep-oversized') args.keepOversized = true
        else if (arg === '--force') args.force = true
        else if (arg.startsWith('--db=')) args.db = arg.slice('--db='.length).replace(/^~/, homedir())
        else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length).replace(/^~/, homedir())
        else {
            console.error(`Unknown option: ${arg} (see --help)`)
            process.exit(1)
        }
    }
    if (!args.out) args.out = `${args.db}.compacted`
    return args
}

function sqlPathLiteral(path: string): string {
    return `'${path.replace(/'/g, "''")}'`
}

/** Resolve symlinks so an aliased spelling of the source (or its WAL/SHM)
 *  cannot slip past the identity check below. The path may not exist yet, so
 *  fall back to canonicalizing its parent and re-attaching the basename. */
function canonicalize(path: string): string {
    const absolute = resolve(path)
    try {
        return realpathSync(absolute)
    } catch {
        try {
            return join(realpathSync(dirname(absolute)), basename(absolute))
        } catch {
            return absolute
        }
    }
}

function fmtMB(bytes: number): string {
    return `${(bytes / 1048576).toFixed(1)} MB`
}

function contentByteLength(value: string | Uint8Array): number {
    return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
    console.log(`Offline DB compactor: truncates oversized agent output, zstd-compresses
message content and VACUUMs — writing a NEW file, never touching the source.

Usage: bun run hub/scripts/compact-db.ts [options]

Options:
  --db=PATH          Source database (default: $HAPI_HOME/hapi.db or ~/.hapi/hapi.db)
  --out=PATH         Output path (default: <db>.compacted)
  --keep-oversized   Do not truncate oversized agent output, compress only
  --force            Overwrite an existing output file

After it succeeds, follow the printed swap instructions.`)
    process.exit(0)
}

if (!existsSync(args.db)) {
    console.error(`Database not found: ${args.db}`)
    process.exit(1)
}

const workPath = `${args.out}.work`
// The source must never be written. Refuse output paths that alias the source
// database or its WAL/SHM (e.g. --out="$DB" --force would otherwise delete the
// source right here, before the snapshot is taken). Sidecar names must derive
// from both the lexical spelling and the canonical target: with a symlinked
// --db, real.db-wal is not the canonicalized form of link.db-wal, yet deleting
// it would corrupt the real database.
const protectedPaths = new Set<string>()
for (const dbSpelling of new Set([resolve(args.db), canonicalize(args.db)])) {
    for (const sidecar of [dbSpelling, `${dbSpelling}-wal`, `${dbSpelling}-shm`]) {
        protectedPaths.add(canonicalize(sidecar))
    }
}
for (const [label, path] of [['--out', args.out], ['work file', workPath]] as const) {
    if (protectedPaths.has(canonicalize(path))) {
        console.error(`Refusing to use ${path} as ${label}: it aliases the source database files.`)
        process.exit(1)
    }
}

if (existsSync(args.out)) {
    if (!args.force) {
        console.error(`Output already exists: ${args.out} (use --force to overwrite)`)
        process.exit(1)
    }
    rmSync(args.out)
}
rmSync(workPath, { force: true })

const sourceBytes = statSync(args.db).size
console.log(`Source:  ${args.db} (${fmtMB(sourceBytes)})`)
console.log(`Output:  ${args.out}`)
console.log('Note: the source is opened read-only; stop the hub before swapping so no new writes land after this snapshot.')
console.log('')

// 1. Consistent snapshot without touching the source
console.log('Snapshotting source → work copy...')
const src = new Database(args.db, { readonly: true })
src.exec(`VACUUM INTO ${sqlPathLiteral(workPath)}`)
src.close()

// 2. Transform the work copy
const work = new Database(workPath)
work.exec('PRAGMA journal_mode = OFF')
work.exec('PRAGMA synchronous = OFF')

const versionRow = work.prepare('PRAGMA user_version').get() as { user_version: number }
if (versionRow.user_version < CODEC_SCHEMA_VERSION - 1) {
    console.error(`Schema version ${versionRow.user_version} is older than V${CODEC_SCHEMA_VERSION - 1}; start the hub once to migrate, then re-run.`)
    work.close()
    rmSync(workPath)
    process.exit(1)
}
if (versionRow.user_version > CODEC_SCHEMA_VERSION) {
    console.error(`Schema version ${versionRow.user_version} is newer than this script understands (V${CODEC_SCHEMA_VERSION}); update hapi and use its compact script.`)
    work.close()
    rmSync(workPath)
    process.exit(1)
}

const totalRow = work.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
console.log(`Transforming ${totalRow.n} messages (${args.keepOversized ? 'compress only' : 'truncate + compress'})...`)

const selectBatch = work.prepare(
    'SELECT rowid AS rid, content FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 2000'
)
const updateRow = work.prepare('UPDATE messages SET content = ? WHERE rowid = ?')

let scanned = 0
let truncated = 0
let compressed = 0
let bytesBefore = 0
let bytesAfter = 0
let lastRid = 0

while (true) {
    const rows = selectBatch.all(lastRid) as Array<{ rid: number; content: string | Uint8Array }>
    if (rows.length === 0) break
    lastRid = rows[rows.length - 1]!.rid

    work.transaction(() => {
        for (const row of rows) {
            scanned++
            const before = contentByteLength(row.content)
            bytesBefore += before
            const isBlob = typeof row.content !== 'string'
            // Fast skips: small plaintext rows need neither transform; BLOBs
            // are already compressed, so with --keep-oversized nothing is left
            // to do for them either.
            if (typeof row.content === 'string' ? row.content.length < COMPRESS_MIN_CHARS : args.keepOversized) {
                bytesAfter += before
                continue
            }
            const parsed = decodeMessageContent(row.content)
            if (parsed === null) {
                bytesAfter += before
                continue
            }
            const transformed = args.keepOversized ? parsed : truncateOversizedMessageContent(parsed)
            if (isBlob && transformed === parsed) {
                // Compressed BLOBs are decoded above rather than skipped outright:
                // rows from copyMessageToSession or a --keep-oversized run may
                // still carry untruncated agent output.
                bytesAfter += before
                continue
            }
            const json = !isBlob && transformed === parsed ? (row.content as string) : JSON.stringify(transformed)
            const encoded = compressContentJson(json)
            if (!isBlob && transformed === parsed && typeof encoded === 'string') {
                bytesAfter += before
                continue
            }
            updateRow.run(encoded as string | Uint8Array, row.rid)
            if (transformed !== parsed) truncated++
            if (!isBlob && typeof encoded !== 'string') compressed++
            bytesAfter += contentByteLength(encoded)
        }
    })()

    if (scanned % 100_000 < 2000) {
        console.log(`  ${scanned}/${totalRow.n} scanned...`)
    }
}

work.exec(`PRAGMA user_version = ${CODEC_SCHEMA_VERSION}`)

// 3. Reclaim freed pages into the final output
console.log('Vacuuming into final output...')
work.exec(`VACUUM INTO ${sqlPathLiteral(args.out)}`)
work.close()
rmSync(workPath)

// 4. Verify
const out = new Database(args.out, { readonly: true })
const integrity = out.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
const outCount = out.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
out.close()
if (integrity.integrity_check !== 'ok' || outCount.n !== totalRow.n) {
    console.error(`Verification FAILED (integrity: ${integrity.integrity_check}, messages: ${outCount.n}/${totalRow.n}); output left at ${args.out} for inspection.`)
    process.exit(1)
}
chmodSync(args.out, 0o600)

const outBytes = statSync(args.out).size
console.log('')
console.log(`Done. Verified: integrity ok, ${outCount.n} messages.`)
console.log(`  content bytes: ${fmtMB(bytesBefore)} → ${fmtMB(bytesAfter)} (${truncated} truncated, ${compressed} compressed)`)
console.log(`  file size:     ${fmtMB(sourceBytes)} → ${fmtMB(outBytes)}`)
console.log('')
console.log('To swap in the compacted DB:')
console.log('  1. Stop the hub')
console.log(`  2. mv ${args.db} ${args.db}.pre-compact`)
console.log(`  3. mv ${args.out} ${args.db}`)
console.log(`  4. rm -f ${args.db}-wal ${args.db}-shm`)
console.log('  5. Start the hub (keep the .pre-compact backup until satisfied)')
