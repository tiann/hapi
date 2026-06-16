#!/usr/bin/env bun
/**
 * Cursor ACP-verify audit (pre-PR gate for the upstream Cursor import PR).
 *
 * For every legacy Cursor chat at ~/.cursor/chats/<wsh>/<uuid>/store.db, this
 * tool stages an isolated $HOME/$HAPI_HOME, copies the store to its ACP
 * location, synthesizes meta.json, and drives `agent acp` through
 * `initialize` + `session/load`. Each verify uses its own temp HOME so
 * multiple verifies can run in parallel without colliding on the
 * agent-acp-active lock or polluting ~/.cursor.
 *
 * The pass-rate decides whether the strict "ACP or unimportable" UX of the
 * upstream Cursor import PR is viable. See:
 *   docs/plans/2026-06-08-upstream-cursor-import-acp-only.md (Pre-PR audit)
 *   docs/plans/2026-06-08-cursor-import-peer-briefing.md     (gate logic)
 *
 * Usage:
 *   bun scripts/audit-cursor-acp-verify.ts                # full run, default CSV
 *   bun scripts/audit-cursor-acp-verify.ts --limit 5      # smoke
 *   bun scripts/audit-cursor-acp-verify.ts --concurrency 4 --csv /path/out.csv
 *   bun scripts/audit-cursor-acp-verify.ts --uuid <id>    # single chat
 *
 * Outcomes (mirrors the migrator's refusal contract):
 *   ok                     - initialize + session/load both succeeded
 *   verify_init_failed     - initialize RPC failed
 *   verify_load_failed     - session/load RPC failed
 *   verify_timeout         - any RPC timed out
 *   spawn_failed           - agent binary missing / spawn errored
 *   corrupted_store        - sqlite open / sanity check failed
 *   probe_crash            - probe exited mid-RPC
 *
 * Output CSV columns:
 *   wsh,uuid,store_size_bytes,store_mtime_iso,result,duration_ms,error_tail
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
    appendFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, delimiter as pathDelimiter } from 'node:path'
import { Database } from 'bun:sqlite'

const AUTH_FILES = ['cli-config.json', 'agent-cli-state.json', 'acp-config.json']
const DEFAULT_INIT_TIMEOUT_MS = 20_000
const DEFAULT_LOAD_TIMEOUT_MS = 30_000
const REPLAY_DRAIN_MS = 1_500

// ---------------------------- arg parsing ----------------------------

interface AuditArgs {
    limit: number | null
    concurrency: number
    csvPath: string
    onlyUuid: string | null
    runPrompt: boolean
    chatsRoot: string
    verbose: boolean
}

function parseArgs(argv: string[]): AuditArgs {
    const args: AuditArgs = {
        limit: null,
        concurrency: 1,
        csvPath: '/home/heavygee/coding/hapi/docs/plans/2026-06-08-cursor-acp-verify-audit.csv',
        onlyUuid: null,
        runPrompt: false,
        chatsRoot: join(homedir(), '.cursor', 'chats'),
        verbose: false
    }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const next = () => argv[++i]
        if (a === '--limit') args.limit = Number(next())
        else if (a === '--concurrency') args.concurrency = Math.max(1, Number(next()))
        else if (a === '--csv') args.csvPath = next()
        else if (a === '--uuid') args.onlyUuid = next()
        else if (a === '--prompt') args.runPrompt = true
        else if (a === '--chats-root') args.chatsRoot = next()
        else if (a === '--verbose' || a === '-v') args.verbose = true
        else if (a === '--help' || a === '-h') {
            console.log(`audit-cursor-acp-verify - run agent acp verify against every legacy chat

Options:
  --limit N           cap chats audited (smoke test)
  --concurrency N     parallel verifies (default 1)
  --csv PATH          output CSV path
  --uuid ID           audit a single chat
  --prompt            also run a tiny session/prompt (token cost)
  --chats-root PATH   override ~/.cursor/chats
  --verbose           per-chat progress to stderr`)
            process.exit(0)
        }
    }
    return args
}

// ---------------------------- discovery ----------------------------

interface ChatRecord {
    wsh: string
    uuid: string
    storeDbPath: string
    sizeBytes: number
    mtimeIso: string
}

function discoverChats(root: string): ChatRecord[] {
    const out: ChatRecord[] = []
    if (!existsSync(root)) return out
    for (const wsh of readdirSync(root)) {
        const wshDir = join(root, wsh)
        let wshStat
        try {
            wshStat = statSync(wshDir)
        } catch {
            continue
        }
        if (!wshStat.isDirectory()) continue
        let entries: string[]
        try {
            entries = readdirSync(wshDir)
        } catch {
            continue
        }
        for (const uuid of entries) {
            const dbPath = join(wshDir, uuid, 'store.db')
            try {
                const s = statSync(dbPath)
                if (!s.isFile()) continue
                out.push({
                    wsh,
                    uuid,
                    storeDbPath: dbPath,
                    sizeBytes: s.size,
                    mtimeIso: s.mtime.toISOString()
                })
            } catch {
                // missing store.db, skip
            }
        }
    }
    out.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1))
    return out
}

// ---------------------------- store sanity ----------------------------

function storeSanityCheck(storeDbPath: string): { ok: true } | { ok: false; message: string } {
    try {
        const db = new Database(storeDbPath, { readonly: true })
        try {
            db.query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()
            return { ok: true }
        } finally {
            db.close()
        }
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
}

// ---------------------------- minimal ACP probe ----------------------------

type RpcResponse =
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; error: { code: number; message: string; data?: unknown } }

interface RpcNotification {
    method: string
    params: Record<string, unknown>
}

class MinimalAcpProbe {
    private proc: ChildProcessWithoutNullStreams | null = null
    private nextId = 0
    private buf = ''
    private readonly pending = new Map<number, { resolve: (msg: RpcResponse) => void; timer: ReturnType<typeof setTimeout> }>()
    private readonly notifications: RpcNotification[] = []
    private stderr = ''
    private exited = false

    constructor(private readonly env: NodeJS.ProcessEnv, private readonly agentLookupHome: string) {}

    start(): void {
        const lookupHome = this.agentLookupHome || process.env.HOME || ''
        const cursorBins = lookupHome
            ? [join(lookupHome, '.local', 'bin'), join(lookupHome, '.npm-global', 'bin')]
            : []
        const existingPath = this.env.PATH ?? ''
        const augmentedPath = [existingPath, ...cursorBins].filter(Boolean).join(pathDelimiter)
        const spawnEnv = { ...this.env, PATH: augmentedPath }
        const proc = spawn('agent', ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv })
        this.proc = proc
        proc.stdout.on('data', (b: Buffer) => this.handleStdout(b.toString('utf8')))
        proc.stderr.on('data', (b: Buffer) => {
            this.stderr += b.toString('utf8')
            if (this.stderr.length > 4096) this.stderr = this.stderr.slice(-4096)
        })
        proc.on('error', (err) => this.failPending(err))
        proc.on('exit', () => {
            this.exited = true
            if (this.pending.size > 0) this.failPending(new Error('agent acp exited mid-RPC'))
        })
    }

    async stop(): Promise<void> {
        const p = this.proc
        this.proc = null
        if (!p) return
        try {
            p.kill('SIGTERM')
        } catch {}
        if (!this.exited) {
            await new Promise<void>((resolve) => {
                let done = false
                const fin = () => {
                    if (done) return
                    done = true
                    resolve()
                }
                p.once('exit', fin)
                p.once('close', fin)
                setTimeout(fin, 5000)
            })
        }
        this.failPending(new Error('agent acp killed by stop()'))
    }

    getStderrTail(n = 256): string {
        return this.stderr.slice(-n).replace(/\s+/g, ' ').trim()
    }

    initialize(timeoutMs = DEFAULT_INIT_TIMEOUT_MS): Promise<RpcResponse> {
        return this.send(
            'initialize',
            {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: 'hapi-cursor-acp-verify-audit', version: '1' }
            },
            timeoutMs
        )
    }

    async loadSession(
        params: { sessionId: string; cwd: string },
        timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
        replayDrainMs = REPLAY_DRAIN_MS
    ): Promise<{ response: RpcResponse; notificationCount: number; durationMs: number }> {
        const t0 = Date.now()
        const before = this.notifications.length
        const response = await this.send(
            'session/load',
            { sessionId: params.sessionId, cwd: params.cwd, mcpServers: [] },
            timeoutMs
        )
        if (!response.ok) {
            return { response, notificationCount: 0, durationMs: Date.now() - t0 }
        }
        if (replayDrainMs > 0) await sleep(replayDrainMs)
        return {
            response,
            notificationCount: this.notifications.length - before,
            durationMs: Date.now() - t0
        }
    }

    private send(method: string, params: unknown, timeoutMs: number): Promise<RpcResponse> {
        if (!this.proc || this.exited) {
            return Promise.resolve({ ok: false, error: { code: -32603, message: 'agent acp not running' } })
        }
        const id = ++this.nextId
        const stdin = this.proc.stdin
        const req = { jsonrpc: '2.0', id, method, params }
        return new Promise<RpcResponse>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                resolve({
                    ok: false,
                    error: { code: -32603, message: `timeout ${method} after ${timeoutMs}ms`, data: { stderr_tail: this.getStderrTail(512) } }
                })
            }, timeoutMs)
            this.pending.set(id, { resolve, timer })
            try {
                stdin.write(`${JSON.stringify(req)}\n`)
            } catch (err) {
                clearTimeout(timer)
                this.pending.delete(id)
                resolve({
                    ok: false,
                    error: { code: -32603, message: `stdin write failed: ${err instanceof Error ? err.message : String(err)}` }
                })
            }
        })
    }

    private handleStdout(chunk: string): void {
        this.buf += chunk
        let idx: number
        while ((idx = this.buf.indexOf('\n')) !== -1) {
            const line = this.buf.slice(0, idx).trim()
            this.buf = this.buf.slice(idx + 1)
            if (!line) continue
            let msg: Record<string, unknown>
            try {
                msg = JSON.parse(line) as Record<string, unknown>
            } catch {
                continue
            }
            const id = msg.id
            if (typeof id === 'number' && this.pending.has(id)) {
                const entry = this.pending.get(id)!
                this.pending.delete(id)
                clearTimeout(entry.timer)
                if (msg.error && typeof msg.error === 'object') {
                    const err = msg.error as Record<string, unknown>
                    entry.resolve({
                        ok: false,
                        error: {
                            code: typeof err.code === 'number' ? err.code : -32603,
                            message: typeof err.message === 'string' ? err.message : 'agent acp error',
                            data: err.data
                        }
                    })
                } else if (msg.result && typeof msg.result === 'object') {
                    entry.resolve({ ok: true, result: msg.result as Record<string, unknown> })
                } else {
                    entry.resolve({ ok: false, error: { code: -32603, message: 'malformed agent acp response' } })
                }
            } else if (typeof msg.method === 'string' && msg.params && typeof msg.params === 'object') {
                this.notifications.push({ method: msg.method as string, params: msg.params as Record<string, unknown> })
            }
        }
    }

    private failPending(err: Error): void {
        for (const [id, entry] of this.pending.entries()) {
            clearTimeout(entry.timer)
            entry.resolve({ ok: false, error: { code: -32603, message: err.message } })
            this.pending.delete(id)
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------- per-chat verify ----------------------------

interface AuditOutcome {
    result:
        | 'ok'
        | 'verify_init_failed'
        | 'verify_load_failed'
        | 'verify_timeout'
        | 'spawn_failed'
        | 'corrupted_store'
        | 'probe_crash'
    durationMs: number
    errorTail: string
}

async function auditOne(chat: ChatRecord, args: AuditArgs): Promise<AuditOutcome> {
    const t0 = Date.now()
    const sanity = storeSanityCheck(chat.storeDbPath)
    if (!sanity.ok) {
        return { result: 'corrupted_store', durationMs: Date.now() - t0, errorTail: shorten(sanity.message) }
    }

    const tmpRoot = mkdtempSync(join(tmpdir(), `hapi-acp-audit-${chat.uuid.slice(0, 8)}-`))
    const fakeAcpSessionDir = join(tmpRoot, '.cursor', 'acp-sessions', chat.uuid)
    try {
        mkdirSync(fakeAcpSessionDir, { recursive: true })
        copyFileSync(chat.storeDbPath, join(fakeAcpSessionDir, 'store.db'))
        writeFileSync(
            join(fakeAcpSessionDir, 'meta.json'),
            JSON.stringify({ schemaVersion: 1, cwd: tmpRoot })
        )
        const realCursor = join(homedir(), '.cursor')
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
        const probe = new MinimalAcpProbe(env, homedir())
        try {
            try {
                probe.start()
            } catch (err) {
                return {
                    result: 'spawn_failed',
                    durationMs: Date.now() - t0,
                    errorTail: shorten(err instanceof Error ? err.message : String(err))
                }
            }
            const initResp = await probe.initialize()
            if (!initResp.ok) {
                const isTimeout = /^timeout /.test(initResp.error.message)
                return {
                    result: isTimeout ? 'verify_timeout' : 'verify_init_failed',
                    durationMs: Date.now() - t0,
                    errorTail: shorten(`${initResp.error.message} | stderr=${probe.getStderrTail(256)}`)
                }
            }
            const load = await probe.loadSession({ sessionId: chat.uuid, cwd: tmpRoot })
            if (!load.response.ok) {
                const isTimeout = /^timeout /.test(load.response.error.message)
                return {
                    result: isTimeout ? 'verify_timeout' : 'verify_load_failed',
                    durationMs: Date.now() - t0,
                    errorTail: shorten(`${load.response.error.message} | stderr=${probe.getStderrTail(256)}`)
                }
            }
            return { result: 'ok', durationMs: Date.now() - t0, errorTail: '' }
        } finally {
            await probe.stop()
        }
    } catch (err) {
        return {
            result: 'probe_crash',
            durationMs: Date.now() - t0,
            errorTail: shorten(err instanceof Error ? err.message : String(err))
        }
    } finally {
        try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
    }
}

function shorten(s: string): string {
    return s.replace(/\s+/g, ' ').slice(0, 400)
}

function csvEscape(s: string): string {
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
}

// ---------------------------- main ----------------------------

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    let chats = discoverChats(args.chatsRoot)
    if (args.onlyUuid) chats = chats.filter((c) => c.uuid === args.onlyUuid)
    if (args.limit) chats = chats.slice(0, args.limit)
    if (chats.length === 0) {
        console.error('no chats discovered; nothing to audit')
        process.exit(2)
    }

    mkdirSync(join(args.csvPath, '..'), { recursive: true })
    writeFileSync(args.csvPath, 'wsh,uuid,store_size_bytes,store_mtime_iso,result,duration_ms,error_tail\n')

    const summary: Record<string, number> = {}
    const startedAt = Date.now()
    let done = 0

    const queue = [...chats]
    const inflight: Promise<void>[] = []
    const next = (): Promise<void> | null => {
        const c = queue.shift()
        if (!c) return null
        return (async () => {
            const outcome = await auditOne(c, args)
            summary[outcome.result] = (summary[outcome.result] ?? 0) + 1
            const row = [
                c.wsh,
                c.uuid,
                String(c.sizeBytes),
                c.mtimeIso,
                outcome.result,
                String(outcome.durationMs),
                csvEscape(outcome.errorTail)
            ].join(',')
            appendFileSync(args.csvPath, row + '\n')
            done += 1
            if (args.verbose || done % 20 === 0 || done === chats.length) {
                const pct = Math.round((done / chats.length) * 100)
                const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
                console.error(
                    `[${done}/${chats.length} ${pct}%] ${elapsedSec}s elapsed | ${outcome.result.padEnd(20)} ${c.uuid} (${formatBytes(c.sizeBytes)}, ${outcome.durationMs}ms)`
                )
            }
        })()
    }
    for (let i = 0; i < args.concurrency; i++) {
        const p = next()
        if (p) inflight.push(p.then(async function loop(): Promise<void> {
            const n = next()
            if (n) await n.then(loop)
        }))
    }
    await Promise.all(inflight)

    const total = chats.length
    const okCount = summary.ok ?? 0
    const passRate = total > 0 ? (okCount / total) * 100 : 0
    console.error('\n=== AUDIT SUMMARY ===')
    console.error(`total: ${total}`)
    for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
        console.error(`  ${k.padEnd(22)} ${v}  (${((v / total) * 100).toFixed(1)}%)`)
    }
    console.error(`PASS RATE: ${passRate.toFixed(1)}%`)
    console.error(`elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s`)
    console.error(`csv: ${args.csvPath}`)

    process.exit(passRate >= 90 ? 0 : 1)
}

function formatBytes(b: number): string {
    if (b < 1024) return `${b}B`
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
    return `${(b / 1024 / 1024).toFixed(1)}MB`
}

main().catch((err) => {
    console.error('audit fatal:', err)
    process.exit(2)
})
