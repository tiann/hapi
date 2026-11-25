/**
 * The npm launcher (`bin/hapi.cjs`) passes its own pid so the binary can tell
 * whether launchd started it through the launcher (see responsibility.ts).
 *
 * This module imports nothing: the CLI entry reads the value before any module
 * with side effects loads, so `hapi --help` still works when HAPI_HOME cannot be
 * created.
 */

/** Set by the npm launcher to its own pid; read once at startup and never passed on. */
export const LAUNCHER_PID_ENV = 'HAPI_LAUNCHER_PID'

let launcherPid: number | null = null

function parsePid(value: string | undefined): number | null {
    if (!value || !/^\d+$/.test(value)) {
        return null
    }
    const pid = Number(value)
    return pid > 1 ? pid : null
}

/** Reads and removes the launcher pid, so no child of this process inherits it. */
export function captureLauncherPid(env: NodeJS.ProcessEnv = process.env): void {
    launcherPid = parsePid(env[LAUNCHER_PID_ENV])
    delete env[LAUNCHER_PID_ENV]
}

export function getLauncherPid(): number | null {
    return launcherPid
}
