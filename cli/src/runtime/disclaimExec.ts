/**
 * macOS responsibility disclaim for detached HAPI processes.
 *
 * macOS attributes a process's privacy decisions (Local Network, TCC) to its
 * "responsible process", inherited from the spawner. A session spawned by a
 * launchd-managed runner therefore stays tied to that runner's pid. Once the
 * runner is replaced (upgrade, handoff) and that pid is gone, macOS can no
 * longer resolve the responsible app, and every new process in the session tree
 * that connects to a LAN address fails with EHOSTUNREACH.
 *
 * When the spawner may hand its responsibility on (see responsibility.ts), a
 * detached child is started with `HAPI_DISCLAIM_RESPONSIBILITY=<spawner pid>`.
 * The entry hook below honours it only in a direct child of that pid, removes
 * the variable, and re-executes `process.execPath` in place (same pid, stdio,
 * cwd, and otherwise the same environment) with
 * `responsibility_spawnattrs_setdisclaim`, so the child becomes its own
 * responsible process. A binary that predates this hook ignores the variable and
 * starts normally, which keeps rollbacks working; a copy of the variable that
 * leaks further down such a tree is ignored by later binaries because their
 * parent is not the spawner.
 */
export const DISCLAIM_RESPONSIBILITY_ENV = 'HAPI_DISCLAIM_RESPONSIBILITY'
/** Set for the re-executed image when the disclaim degraded, so it can log why. */
export const DISCLAIM_FALLBACK_ENV = 'HAPI_DISCLAIM_FALLBACK'

export interface SpawnExecNative {
    /** Whether the private disclaim symbol was found. */
    canDisclaim: boolean
    /** Removes a variable from the libc environment; true when it is gone. */
    unsetenv(name: string): boolean
    setenv(name: string, value: string): void
    /** Replaces the current process image; returns only on failure (non-zero code). */
    exec(path: string, argv: readonly string[], disclaim: boolean): number
}

export function shouldDisclaimResponsibility(
    platform: NodeJS.Platform,
    detached: boolean | undefined,
    canDisclaimForChildren: () => boolean
): boolean {
    return platform === 'darwin' && detached === true && canDisclaimForChildren()
}

/** The request is addressed to direct children of the spawner only. */
export function isRequestForThisProcess(value: string, ppid: number): boolean {
    return /^\d+$/.test(value) && Number(value) > 1 && Number(value) === ppid
}

/**
 * argv for re-executing this same invocation. Compiled binaries report a virtual
 * `/$bunfs/...` entry as argv[1] that the executable supplies itself; in dev mode
 * argv[1] is the real entry script (Bun has already applied `--cwd`, so the
 * current directory is the one it needs).
 */
export function reexecArgv(argv: readonly string[], argv0: string): string[] {
    const compiled = (argv[1] ?? '').startsWith('/$bunfs/')
    return compiled ? [argv0, ...argv.slice(2)] : [argv0, ...argv.slice(1)]
}

/**
 * Fails open: without the disclaim it execs the same command plainly, and if no
 * exec is possible it returns so the caller continues in-process. Each fallback
 * step writes one line through `log`.
 */
export function runDisclaimExec(
    execPath: string,
    argv: readonly string[],
    loadNative: () => SpawnExecNative,
    log: (line: string) => void
): void {
    let native: SpawnExecNative
    try {
        native = loadNative()
    } catch (error) {
        log(`macOS responsibility disclaim unavailable (${error instanceof Error ? error.message : String(error)}); continuing without it`)
        return
    }
    // The exec'd image must not see the request again, or it would re-exec forever.
    if (!native.unsetenv(DISCLAIM_RESPONSIBILITY_ENV)) {
        log(`macOS responsibility disclaim: could not clear ${DISCLAIM_RESPONSIBILITY_ENV}; continuing without it`)
        return
    }

    let reason: string
    if (native.canDisclaim) {
        const rc = native.exec(execPath, argv, true)
        reason = `disclaimed exec failed (code ${rc})`
    } else {
        reason = 'disclaim symbol not found'
    }
    log(`macOS responsibility disclaim: ${reason}; executing without it`)
    native.setenv(DISCLAIM_FALLBACK_ENV, reason)
    const rc = native.exec(execPath, argv, false)
    log(`macOS responsibility disclaim: exec failed (code ${rc}); continuing in-process without it`)
}

export interface DisclaimEntryOptions {
    env?: NodeJS.ProcessEnv
    argv?: readonly string[]
    argv0?: string
    execPath?: string
    platform?: NodeJS.Platform
    ppid?: number
    loadNative?: () => Promise<() => SpawnExecNative>
    writeStderr?: (line: string) => void
}

async function loadDarwinNative(): Promise<() => SpawnExecNative> {
    const { loadDarwinSpawnExec } = await import('./darwinSpawnExec')
    return loadDarwinSpawnExec
}

/**
 * Entry hook; runs before the CLI module graph loads so the re-exec happens
 * before any side effects (log files, sockets, timers). Returns when this process
 * should continue as the CLI; it never throws.
 */
export async function handleDisclaimExecEntry(options: DisclaimEntryOptions = {}): Promise<void> {
    const env = options.env ?? process.env
    const requested = env[DISCLAIM_RESPONSIBILITY_ENV]
    if (requested === undefined) {
        return
    }
    // Never hand the request on to this process's own children.
    delete env[DISCLAIM_RESPONSIBILITY_ENV]
    if ((options.platform ?? process.platform) !== 'darwin'
        || !isRequestForThisProcess(requested, options.ppid ?? process.ppid)) {
        return
    }

    const writeStderr = options.writeStderr ?? ((line: string) => process.stderr.write(`[hapi] ${line}\n`))
    const notes: string[] = []
    const log = (line: string) => {
        notes.push(line)
        writeStderr(line)
    }
    // Fail open: whatever goes wrong, this process continues as the CLI.
    try {
        let loadNative: () => SpawnExecNative
        try {
            loadNative = await (options.loadNative ?? loadDarwinNative)()
        } catch (error) {
            loadNative = () => {
                throw error
            }
        }
        runDisclaimExec(
            options.execPath ?? process.execPath,
            reexecArgv(options.argv ?? process.argv, options.argv0 ?? process.argv0),
            loadNative,
            log
        )
    } catch (error) {
        log(`macOS responsibility disclaim failed (${error instanceof Error ? error.message : String(error)}); continuing in-process without it`)
    }
    env[DISCLAIM_FALLBACK_ENV] = notes.join('; ')
}

/** Reads and clears the fallback note left by the entry hook, if any. */
export function takeDisclaimFallbackNote(env: NodeJS.ProcessEnv = process.env): string | null {
    const note = env[DISCLAIM_FALLBACK_ENV]
    if (note === undefined) {
        return null
    }
    delete env[DISCLAIM_FALLBACK_ENV]
    return note
}
