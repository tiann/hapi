/**
 * Minimal JSON-RPC stdio client for `agent acp`.
 *
 * Hub-side, internal-only: used by the legacy → ACP migrator's verify step to
 * confirm that a transplanted store.db can actually be opened by `agent acp`
 * before we flip metadata and remove the legacy source.
 *
 * This is intentionally NOT a full ACP client (those live in cli/src/agent/...).
 * It speaks only the three calls verify needs: initialize, session/load, and
 * (optionally) session/prompt. It is decoupled from the launcher loop so it
 * can spawn against a temp $HOME without engaging any of HAPI's per-session
 * machinery.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, delimiter as pathDelimiter } from 'node:path'
import { tmpdir } from 'node:os'

export interface AcpProbeOptions {
    /** Path to the `agent` binary. Default 'agent'. */
    agentBinary?: string
    /** Override env (used to set HOME for isolation). */
    env?: NodeJS.ProcessEnv
    /** Default per-request timeout, ms. */
    timeoutMs?: number
    /**
     * Override the $HAPI_HOME directory used for the agent-acp-active lock.
     * Defaults to `process.env.HAPI_HOME` (with tmpdir/hapi fallback) — same
     * scheme as cli/src/agent/backends/acp/agentCliGuard.ts. Tests can pass a
     * temp dir here to avoid clobbering the operator's real lock.
     */
    hapiHome?: string
    /**
     * When true, the probe will NOT acquire the agent-acp-active lock in
     * start() and will NOT release it in stop(). Caller is responsible
     * for owning the lock for the probe's lifetime. Codex review #34
     * P2 v7: the migrator pre-acquires the lock BEFORE archiving so a
     * concurrent ACP spawn cannot land in the window between preflight
     * and verifyInTempHome.
     */
    skipLockAcquire?: boolean
    /**
     * Recorded operator home dir to use for resolving the `agent` binary
     * on PATH. Used when constructing the fallback PATH augmentation
     * (~/.local/bin and ~/.npm-global/bin). Defaults to `process.env.HOME`.
     *
     * Codex review #34 P2: in deployment shapes where the hub runs as a
     * service account whose `process.env.HOME` differs from the human
     * user who installed Cursor (`metadata.homeDir`), the caller (the
     * migrator) needs to thread its recorded session-owner home through
     * to the verify probe so the binary lookup happens against the right
     * filesystem location. Independent of any HOME override passed via
     * `options.env` (which is for the spawned agent's cache/state
     * isolation, not its binary lookup).
     */
    agentLookupHome?: string
}

/**
 * Handle to a held agent-acp-active lock. Created by
 * tryAcquireAcpActiveLock(); the caller MUST call release() in a
 * finally block.
 */
export interface AcpActiveLockHandle {
    /** Absolute path to the lock directory we own. */
    lockDir: string
    /** Release the lock. Idempotent. */
    release(): void
}

/**
 * Acquire the global agent-acp-active lock at the well-known path
 * `<hapiHome>/locks/agent-acp-active/`. Returns a handle whose
 * release() removes the lock dir; returns null if the lock is held
 * by another live (or mid-startup) process. Throws on
 * non-EEXIST mkdir failures (root-owned HAPI_HOME, read-only fs).
 *
 * Codex review #34 P2 v7: extracted so the legacy migrator can
 * reserve the lock BEFORE archive — closing the gap where another
 * agent acp could start between preflight and verifyInTempHome.
 */
export function tryAcquireAcpActiveLock(hapiHome: string): AcpActiveLockHandle | null {
    const lockDir = join(hapiHome, 'locks', 'agent-acp-active')
    const pidFile = join(lockDir, 'pid')
    const parentDir = join(lockDir, '..')
    try {
        mkdirSync(parentDir, { recursive: true })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!/EEXIST/.test(msg)) {
            throw new Error(`agent-acp-active lock parent could not be created (path=${parentDir}): ${msg}`)
        }
    }

    const tryAcquire = (): boolean => {
        try {
            mkdirSync(lockDir, { recursive: false })
            try {
                writeFileSync(pidFile, String(process.pid))
            } catch {
                // pid write best-effort; release will still rmdir.
            }
            return true
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (!/EEXIST/.test(msg)) {
                throw new Error(`agent-acp-active lock could not be claimed (path=${lockDir}): ${msg}`)
            }
            return false
        }
    }

    if (tryAcquire()) {
        return makeLockHandle(lockDir, pidFile)
    }
    // Lock held — decide if stale and retry once.
    const probe = inspectLockHolder(pidFile)
    if (probe.kind === 'dead') {
        try { rmSync(lockDir, { recursive: true, force: true }) } catch {}
        if (tryAcquire()) {
            return makeLockHandle(lockDir, pidFile)
        }
    }
    return null
}

type LockHolderProbe =
    | { kind: 'live'; pid: number }
    | { kind: 'dead' }
    | { kind: 'starting' }

function inspectLockHolder(pidFile: string): LockHolderProbe {
    if (!existsSync(pidFile)) return { kind: 'starting' }
    let raw: string
    try {
        raw = readFileSync(pidFile, 'utf8').trim()
    } catch {
        return { kind: 'starting' }
    }
    if (raw.length === 0) return { kind: 'starting' }
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) return { kind: 'starting' }
    try {
        process.kill(pid, 0)
        return { kind: 'live', pid }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EPERM') return { kind: 'live', pid }
        return { kind: 'dead' }
    }
}

function makeLockHandle(lockDir: string, pidFile: string): AcpActiveLockHandle {
    let released = false
    return {
        lockDir,
        release() {
            if (released) return
            released = true
            try {
                let shouldRemove = true
                if (existsSync(pidFile)) {
                    try {
                        const raw = readFileSync(pidFile, 'utf8').trim()
                        if (raw.length > 0 && raw !== String(process.pid)) {
                            const otherPid = Number(raw)
                            if (Number.isInteger(otherPid) && otherPid > 0) {
                                shouldRemove = false
                            }
                        }
                    } catch {
                        // read error — we own the dir, remove it.
                    }
                }
                if (shouldRemove) {
                    rmSync(lockDir, { recursive: true, force: true })
                }
            } catch {
                // best-effort
            }
        }
    }
}

export type AcpRpcResponse =
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; error: { code: number; message: string; data?: unknown } }

export type AcpNotification = {
    method: string
    params: Record<string, unknown>
}

/** Subset of session/load response useful to the migrator. */
export interface AcpLoadOutcome {
    response: AcpRpcResponse
    notificationCount: number
    notificationKinds: Record<string, number>
    durationMs: number
}

export interface AcpPromptOutcome {
    response: AcpRpcResponse
    durationMs: number
}

export class AcpVerifyProbe {
    private proc: ChildProcessWithoutNullStreams | null = null
    private nextId = 0
    private buf = ''
    private readonly pending = new Map<number, { resolve: (msg: AcpRpcResponse) => void; timer: NodeJS.Timeout }>()
    private readonly notifications: AcpNotification[] = []
    private stderr = ''
    private readonly defaultTimeoutMs: number
    private readonly stderrLimit = 4096
    private lockHeld = false
    private readonly lockDir: string
    private readonly lockPidFile: string

    constructor(private readonly options: AcpProbeOptions = {}) {
        this.defaultTimeoutMs = options.timeoutMs ?? 20_000
        const home = options.hapiHome ?? process.env.HAPI_HOME?.trim() ?? join(tmpdir(), 'hapi')
        this.lockDir = join(home, 'locks', 'agent-acp-active')
        this.lockPidFile = join(this.lockDir, 'pid')
    }

    start(): void {
        if (this.proc) return
        // Codex review #34 P2: register the agent-acp-active lock BEFORE
        // spawn so concurrent migrations / model-list requests see the
        // probe as a live ACP transport and back off. Without this, two
        // parallel migrations could each pass the pre-spawn check, both
        // spawn agent acp, and the second one's spawn would SIGTERM the
        // first per Cursor's single-instance enforcement (see
        // cli/src/agent/backends/acp/agentCliGuard.ts top comment).
        //
        // Codex review #34 P2 v7: when the caller (typically the legacy
        // migrator) has already acquired the lock at the start of its
        // critical section, skip our internal acquire so we don't fail
        // EEXIST against the caller's own lock. The caller is then
        // responsible for releasing.
        if (!this.options.skipLockAcquire) {
            this.acquireLock()
        }

        // Codex review #34 P2: match cursorAcpRemoteLauncher's spawn shape
        // so the `agent.cmd` shim on Windows is reachable. Without
        // shell:true + windowsHide:true the spawn fails with ENOENT even
        // though normal Cursor ACP sessions work.
        const isWin = process.platform === 'win32'
        // Live dogfood (2026-06-07) on hapi-hub.service surfaced
        // `Executable not found in $PATH: "agent"` — the hub's systemd unit
        // ships a minimal PATH (/usr/local/sbin:/usr/local/bin:/usr/sbin:
        // /usr/bin:/sbin:/bin) and never sees Cursor's standard install
        // location at ~/.local/bin/agent. hapi-runner.service hand-fixes
        // this via Environment=PATH=$HOME/.local/bin:... in its unit file;
        // we replicate that in code so the hub doesn't depend on the
        // operator hand-tuning their systemd dropin.
        //
        // Resolution order for the lookup home:
        //   1. options.agentLookupHome  — caller-supplied (migrator threads
        //      its recorded session-owner homeDir here; covers the service-
        //      account-hub deployment where process.env.HOME and the human
        //      user who installed Cursor differ)
        //   2. process.env.HOME         — hub process's own home (covers the
        //      common single-user deployment)
        //
        // Independently of where the LOOKUP home comes from, options.env
        // may override HOME for the spawned agent's cache/state isolation
        // (HAPI_HOME-style sandboxing in the migrator's verifyInTempHome).
        // The two HOMEs are deliberately separate concerns.
        //
        // PATH precedence: we APPEND the fallback bin dirs after the
        // existing PATH, so any explicit options.env.PATH (e.g. a staging
        // Cursor install or a pinned wrapper) wins. The fallback only
        // kicks in when the existing PATH doesn't already contain `agent`.
        //
        // Platform: use path.delimiter (`;` on win32, `:` elsewhere) so the
        // augmented PATH is valid for cmd.exe when this spawn path
        // delegates to the shell for `agent.cmd`.
        const baseEnv = this.options.env ?? process.env
        const lookupHome = this.options.agentLookupHome ?? process.env.HOME ?? ''
        const cursorBins = lookupHome
            ? [join(lookupHome, '.local', 'bin'), join(lookupHome, '.npm-global', 'bin')]
            : []
        const existingPath = baseEnv.PATH ?? ''
        const augmentedPath = [existingPath, ...cursorBins].filter(Boolean).join(pathDelimiter)
        const spawnEnv = { ...baseEnv, PATH: augmentedPath }
        const proc = spawn(this.options.agentBinary ?? 'agent', ['acp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: spawnEnv,
            shell: isWin,
            windowsHide: isWin
        })
        this.proc = proc

        proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk.toString('utf8')))
        proc.stderr.on('data', (chunk: Buffer) => {
            this.stderr += chunk.toString('utf8')
            if (this.stderr.length > this.stderrLimit) {
                this.stderr = this.stderr.slice(-this.stderrLimit)
            }
        })
        // If the child dies, fail all pending requests so callers see a
        // structured rejection instead of a hang.
        proc.on('error', (err) => this.failPending(err))
        proc.on('exit', (code, signal) => {
            if (this.pending.size > 0) {
                this.failPending(new Error(`agent acp exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`))
            }
        })
    }

    async stop(): Promise<void> {
        const proc = this.proc
        this.proc = null
        if (proc) {
            // Codex review #34 P2 v7: on Windows we spawn through a shell
            // (shell: true in start()) so proc.kill only signals the shell
            // wrapper — the `agent` child can survive. Use taskkill /F /T
            // to kill the process tree. POSIX kill propagates to the
            // process group via SIGTERM as long as the child didn't fork.
            if (process.platform === 'win32' && proc.pid !== undefined) {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    require('node:child_process').execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', windowsHide: true })
                } catch {
                    // best-effort — fall through to SIGTERM as a backup
                    try { proc.kill('SIGTERM') } catch {}
                }
            } else {
                try {
                    proc.kill('SIGTERM')
                } catch {
                    // best-effort
                }
            }
            // Codex review #34 P2 v6: wait for the child to actually exit
            // before releasing the agent-acp-active lock. Sending SIGTERM
            // does not mean the process is dead — agent acp may take a
            // few hundred ms to tear down JSON-RPC and detach stdio. If
            // we release the lock before then, the next session's
            // verifier (or any other CLI guard caller) can acquire the
            // free lock and spawn a second `agent acp` while ours is
            // still live, hitting Cursor's single-instance enforcement
            // and SIGTERMing one or both.
            const alreadyDone = proc.exitCode !== null || proc.signalCode !== null
            if (!alreadyDone) {
                await new Promise<void>((resolve) => {
                    let resolved = false
                    const done = () => {
                        if (resolved) return
                        resolved = true
                        resolve()
                    }
                    proc.once('exit', done)
                    proc.once('close', done)
                    // Hard ceiling so a wedged child cannot hang the
                    // migrator's finally{} block forever. After this
                    // ceiling we fall through to releaseLock and accept
                    // the (now extremely rare) overlap window.
                    setTimeout(done, 5000)
                })
            }
            // Drain any remaining pending requests with a kill error so the caller
            // does not deadlock waiting on a JSON-RPC response that will never arrive.
            this.failPending(new Error('agent acp killed by probe.stop()'))
        }
        // Release the lock LAST (after kill + exit-wait) so concurrent
        // requests still see us as active during the entire teardown
        // window. Codex review #34 P2 / P2 v6.
        //
        // Codex review #34 P2 v7: when skipLockAcquire was set, the
        // caller owns the lock for a longer scope than this probe
        // instance — don't release theirs.
        if (!this.options.skipLockAcquire) {
            this.releaseLock()
        }
    }

    private acquireLock(): void {
        // Ensure the parent dir exists (idempotent), then atomically claim
        // the lock dir itself via mkdirSync(recursive:false). The atomic
        // mkdir fails EEXIST if another lock-holder is already in place
        // — that is the only race-safe primitive here. mkdirSync + write
        // is NOT atomic and would let two concurrent migrations both
        // think they own the lock. Codex review #34 P2 v2.
        const parentDir = join(this.lockDir, '..')
        try {
            mkdirSync(parentDir, { recursive: true })
        } catch (err) {
            // Codex review #34 P2 v7: previously silently swallowed. If
            // we can't even create the parent dir (root-owned HAPI_HOME,
            // read-only fs), we cannot claim a lock. Fail loud so start()
            // refuses rather than running unguarded.
            const msg = err instanceof Error ? err.message : String(err)
            if (!/EEXIST/.test(msg)) {
                throw new Error(`agent-acp-active lock parent could not be created (path=${parentDir}): ${msg}`)
            }
        }

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                mkdirSync(this.lockDir, { recursive: false })
                // Won the race — write our pid IMMEDIATELY (no async work
                // between the mkdir and the write) so other callers see a
                // pidful lock as soon as possible. The CLI guard's
                // clearStaleAcpLockIfNeeded ALSO no longer removes
                // pid-less dirs (Codex review #34 P3 v6), but tightening
                // the window here belt-and-suspenders the protection.
                try {
                    writeFileSync(this.lockPidFile, String(process.pid))
                } catch {
                    // best-effort: pid file is diagnostic, not the
                    // primary lock primitive (the dir is). releaseLock
                    // will still rmdir on our pid-less lock because
                    // lockHeld=true means we own the mkdir. Codex
                    // review #34 P2 v7.
                }
                this.lockHeld = true
                return
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                if (!/EEXIST/.test(msg)) {
                    // Codex review #34 P2 v7: a non-EEXIST mkdir failure
                    // (permission denied, read-only fs, disk full) means
                    // we cannot acquire the lock. Previously we silently
                    // returned with lockHeld=false and start() would
                    // spawn agent acp UNGUARDED. Throw instead so
                    // verifyInTempHome surfaces the refusal cleanly.
                    throw new Error(`agent-acp-active lock could not be claimed (path=${this.lockDir}): ${msg}`)
                }
                // Lock dir exists. Decide whether the holder is stale.
                // Codex review #34 P2 v3: a CLI agent guard that just
                // mkdir'd the lock but has NOT yet written the pid file
                // would otherwise look "stale" to us and we would delete
                // their freshly-created live lock. Treat a missing-pid
                // lock as ACTIVE (probably mid-startup) on the first
                // attempt; only consider it stale if a pid file IS
                // present AND the recorded pid is dead.
                const probe = this.probeLockHolder()
                if (attempt === 0 && probe.kind === 'dead') {
                    try { rmSync(this.lockDir, { recursive: true, force: true }) } catch {}
                    continue
                }
                // Either live, or mid-startup (no pid yet), or we already
                // retried once. Refuse.
                throw new Error(`agent-acp-active lock is held (path=${this.lockDir}, holder=${probe.kind === 'live' ? `pid=${probe.pid}` : probe.kind}); refusing to spawn a second agent acp`)
            }
        }
    }

    /** Inspect the current holder of an existing lock dir. */
    private probeLockHolder(): { kind: 'live'; pid: number } | { kind: 'dead' } | { kind: 'starting' } {
        try {
            if (!existsSync(this.lockPidFile)) {
                // Lock dir exists but pid file not yet written — caller
                // is in the middle of registerActiveAcpTransport(). Treat
                // as live to avoid racing them.
                return { kind: 'starting' }
            }
            const raw = readFileSync(this.lockPidFile, 'utf8').trim()
            const pid = Number(raw)
            if (!Number.isInteger(pid) || pid <= 0) {
                // Malformed pid file — treat as starting (caller may be
                // mid-write) rather than dead.
                return { kind: 'starting' }
            }
            try {
                process.kill(pid, 0)
                return { kind: 'live', pid }
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code
                if (code === 'EPERM') return { kind: 'live', pid }
                return { kind: 'dead' }
            }
        } catch {
            return { kind: 'starting' }
        }
    }

    private releaseLock(): void {
        if (!this.lockHeld) return
        this.lockHeld = false
        // We own the mkdir (lockHeld was set true by the EEXIST-free
        // mkdirSync above). Remove the lock dir in two cases:
        //   (a) pid file is OUR pid (normal happy path), OR
        //   (b) pid file is missing/unparseable — Codex review #34 P2 v7:
        //       we own the dir, our pid-write failed (disk full etc.).
        //       The CLI guard now treats pid-less dirs as "starting"
        //       (active), so leaving this here would wedge the lock
        //       forever. We OWN it; we must clean it up.
        // Skip removal only when the pid file has a DIFFERENT, valid pid
        // — that would mean another holder somehow took over (shouldn't
        // happen but defensive).
        try {
            let shouldRemove = true
            if (existsSync(this.lockPidFile)) {
                try {
                    const raw = readFileSync(this.lockPidFile, 'utf8').trim()
                    if (raw.length > 0 && raw !== String(process.pid)) {
                        const otherPid = Number(raw)
                        if (Number.isInteger(otherPid) && otherPid > 0) {
                            shouldRemove = false
                        }
                    }
                } catch {
                    // read error — we own the dir, remove it.
                }
            }
            if (shouldRemove) {
                rmSync(this.lockDir, { recursive: true, force: true })
            }
        } catch {
            // best-effort
        }
    }

    getStderr(): string {
        return this.stderr
    }

    getNotifications(): AcpNotification[] {
        return [...this.notifications]
    }

    clearNotifications(): void {
        this.notifications.length = 0
    }

    /** Send `initialize` and return the response. */
    initialize(timeoutMs?: number): Promise<AcpRpcResponse> {
        return this.send('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false
            },
            clientInfo: { name: 'hapi-cursor-legacy-migrator-verify', version: '1' }
        }, timeoutMs)
    }

    /** Send `session/load` and capture replay notifications drained over `replayDrainMs`. */
    async loadSession(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }, replayDrainMs: number = 3_000, timeoutMs?: number): Promise<AcpLoadOutcome> {
        const start = Date.now()
        const before = this.notifications.length
        const response = await this.send('session/load', {
            sessionId: params.sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? []
        }, timeoutMs)
        if (!response.ok) {
            return {
                response,
                notificationCount: 0,
                notificationKinds: {},
                durationMs: Date.now() - start
            }
        }
        if (replayDrainMs > 0) {
            await sleep(replayDrainMs)
        }
        const drained = this.notifications.slice(before)
        const notificationKinds: Record<string, number> = {}
        for (const n of drained) {
            const u = (n.params as Record<string, unknown>)?.update as Record<string, unknown> | undefined
            const kind = typeof u?.sessionUpdate === 'string' ? u.sessionUpdate : '_other'
            notificationKinds[kind] = (notificationKinds[kind] ?? 0) + 1
        }
        return {
            response,
            notificationCount: drained.length,
            notificationKinds,
            durationMs: Date.now() - start
        }
    }

    async prompt(params: { sessionId: string; text: string }, timeoutMs: number = 60_000): Promise<AcpPromptOutcome> {
        const start = Date.now()
        const response = await this.send('session/prompt', {
            sessionId: params.sessionId,
            prompt: [{ type: 'text', text: params.text }]
        }, timeoutMs)
        return { response, durationMs: Date.now() - start }
    }

    async setModel(params: { sessionId: string; modelId: string }, timeoutMs?: number): Promise<AcpRpcResponse> {
        return this.send('session/set_model', { sessionId: params.sessionId, modelId: params.modelId }, timeoutMs)
    }

    // ---------------------------------------------------------------------

    private send(method: string, params: unknown, timeoutMs?: number): Promise<AcpRpcResponse> {
        if (!this.proc) {
            return Promise.resolve({ ok: false as const, error: { code: -32603, message: 'agent acp not started' } })
        }
        const id = ++this.nextId
        const t = timeoutMs ?? this.defaultTimeoutMs
        const req = { jsonrpc: '2.0', id, method, params }
        const stdin = this.proc.stdin
        return new Promise<AcpRpcResponse>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                resolve({ ok: false, error: { code: -32603, message: `timeout ${method} after ${t}ms`, data: { stderr_tail: this.stderr.slice(-512) } } })
            }, t)
            this.pending.set(id, { resolve, timer })
            try {
                stdin.write(`${JSON.stringify(req)}\n`)
            } catch (err) {
                clearTimeout(timer)
                this.pending.delete(id)
                resolve({ ok: false, error: { code: -32603, message: `stdin write failed: ${err instanceof Error ? err.message : String(err)}` } })
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
                this.notifications.push({
                    method: msg.method as string,
                    params: msg.params as Record<string, unknown>
                })
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
    return new Promise((resolve) => setTimeout(resolve, ms))
}
