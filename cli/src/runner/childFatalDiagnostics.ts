import { NOFILE_BUMP_THRESHOLD, getNofileSoftLimit } from '@/utils/spawnHappyCLI';

export interface ChildFatalContext {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderrTail: string;
    /**
     * Injected for tests; defaults to probing the runner's inherited
     * RLIMIT_NOFILE soft limit (cached after the first probe).
     */
    nofileSoftLimit?: number;
    compiledMode?: boolean;
}

// Bun-compiled binaries that die during runtime init — before any JS runs —
// exit with code 1 and print a single unclassifiable-fatal stderr line. The
// canonical trigger is a low inherited RLIMIT_NOFILE soft limit (launchd and
// other service managers default it to 2560/10240), but the marker line is
// Bun's generic errno placeholder, so the limit is reported rather than
// assumed.
const BUN_PREINIT_FATAL_MARKER = 'An unknown error occurred';

/**
 * Diagnose the "child exited before webhook, no logs anywhere" failure class.
 * Returns null when the exit signature does not match Bun's pre-init fatal
 * crash, so regular CLI errors and signal deaths keep their plain message.
 */
export function describeChildFatalContext(context: ChildFatalContext): string | null {
    if (context.exitCode !== 1 || context.signal !== null) {
        return null;
    }
    if (!context.stderrTail.includes(BUN_PREINIT_FATAL_MARKER)) {
        return null;
    }

    const softLimit = context.nofileSoftLimit ?? getNofileSoftLimit();

    if (Number.isFinite(softLimit) && softLimit < NOFILE_BUMP_THRESHOLD) {
        return context.compiledMode === false
            ? `This matches Bun's pre-init fatal crash (the process died before any JS ran). ` +
                `The runner's RLIMIT_NOFILE soft limit is ${softLimit}; low limits only kill ` +
                `compiled binaries and this runner runs in dev mode, so also consider other ` +
                `pre-init causes such as other resource limits or a corrupted executable.`
            : `This matches Bun's pre-init fatal crash (the process died before any JS ran). ` +
                `The runner's RLIMIT_NOFILE soft limit is ${softLimit}, which compiled HAPI ` +
                `binaries do not survive; children inherit it from the runner's process ` +
                `lineage (e.g. launchd or systemd). Raise the limit for the runner process ` +
                `(wrap its launch in 'ulimit -n 1048576' or configure the service manager) ` +
                `and restart the runner.`;
    }

    return Number.isFinite(softLimit)
        ? `This matches Bun's pre-init fatal crash (the process died before any JS ran, so the ` +
            `stderr above is all it left). The runner's RLIMIT_NOFILE soft limit is ${softLimit}, ` +
            `so the classic low-fd-limit cause is unlikely here.`
        : `This matches Bun's pre-init fatal crash (the process died before any JS ran, so the ` +
            `stderr above is all it left). The runner's RLIMIT_NOFILE soft limit could not be ` +
            `probed, so a low fd limit cannot be ruled out.`;
}
