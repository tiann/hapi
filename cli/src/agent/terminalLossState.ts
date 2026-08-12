import { logger } from '@/ui/logger'

// Process-global flag. One hapi (claude flavor)
// process controls exactly one controlling terminal, so a module singleton is
// sufficient — no need to thread this through Session/loop constructors.
// Set once by the SIGHUP handler in runnerLifecycle.ts and never cleared:
// once the terminal is gone for this process it is gone for good.
let terminalLost = false
let outputGuardInstalled = false
// Tracks which explicit stream objects already have the guard attached, so
// repeated installTerminalOutputGuard({ stdout, stderr, ... }) calls with the
// same stream objects (e.g. re-entrant SIGHUP handling, or a caller that
// installs the guard defensively before every use) don't stack a second
// 'error' listener per stream. `outputGuardInstalled` above only covers the
// implicit (no-args, real process.stdout/stderr) case and has different
// semantics — it must not be reused here.
let guardedStreams = new WeakSet<object>()

export function markTerminalLost(): void {
    terminalLost = true
}

export function isTerminalLost(): boolean {
    return terminalLost
}

/**
 * Test-only reset. Production code has no legitimate reason to un-set the
 * flag (a lost terminal never comes back for this process).
 */
export function __resetTerminalLossStateForTests(): void {
    terminalLost = false
    outputGuardInstalled = false
    guardedStreams = new WeakSet<object>()
}

type WritableErrorStream = {
    on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/**
 * After the controlling terminal disappears (SIGHUP), any write to
 * stdout/stderr — including from readline/ink components that have not yet
 * torn down — can raise EPIPE/EIO once the terminal's other end is gone. An
 * unhandled 'error' event on a stream throws (routed via
 * uncaughtException, which would archive-and-exit the session), which is
 * exactly the crash we're trying to survive. Installing a listener here
 * swallows the expected disconnect errors and logs anything unexpected to
 * the file logger instead of the (now-gone) terminal.
 */
export function installTerminalOutputGuard(streams?: {
    stdout: WritableErrorStream
    stderr: WritableErrorStream
    stdin?: WritableErrorStream
}): void {
    if (!streams && outputGuardInstalled) {
        return
    }
    if (!streams) {
        outputGuardInstalled = true
    }

    // stdin needs the same guard as stdout/stderr. spawnWithTerminalGuard and
    // RemoteLauncherBase both
    // call process.stdin.resume()/setRawMode() against a dead tty once the
    // terminal is lost; the resulting 'error' event on process.stdin is just
    // as capable of reaching uncaughtException (→ markCrash → archive+exit)
    // as an unguarded stdout/stderr write is.
    const targets = streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }

    const guard = (label: string, stream: WritableErrorStream) => {
        if (guardedStreams.has(stream)) {
            return
        }
        guardedStreams.add(stream)

        stream.on('error', (error: NodeJS.ErrnoException) => {
            if (error && (error.code === 'EPIPE' || error.code === 'EIO')) {
                return
            }
            logger.debug(`[terminalLoss] unexpected ${label} stream error`, error)
        })
    }

    guard('stdout', targets.stdout)
    guard('stderr', targets.stderr)
    if (targets.stdin) {
        guard('stdin', targets.stdin)
    }
}
