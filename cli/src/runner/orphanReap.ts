/**
 * Argv-based discovery of runner-spawned driver CLI processes that are no
 * longer present in the runner's in-memory / resume-process maps.
 *
 * Detached children (PPID=1 after KillMode=process runner bounce) can survive
 * with no tracking entry. `stopSession` must still be able to reap them when
 * the hub archives by HAPI session id — matching `--started-by runner` plus
 * an explicit `--existing-session-id` / `--hapi-session-id` flag.
 */

import psList from 'ps-list'

export type ProcessSnapshot = {
    pid: number
    cmd?: string
    name?: string
}

/** True when cmd looks like a HAPI driver CLI (binary or bun/node src/index.ts). */
export function isHapiDriverCliCommand(cmd: string, name = ''): boolean {
    const isHappyBinary = name === 'hapi' || name === 'hapi.exe' || /\bhapi(\.exe)?\b/.test(cmd)
    const isDevMode = cmd.includes('src/index.ts')
    return (
        isHappyBinary
        || isDevMode
        || name.includes('happy')
        || (name === 'node' && cmd.includes('happy-cli'))
        || cmd.includes('happy-coder')
    )
}

/**
 * Token-aware match: session id must appear as its own argv token (or after
 * `--existing-session-id=` / `--hapi-session-id=`), and the process must claim
 * `--started-by runner` (or `--started-by=runner`).
 */
export function commandMatchesRunnerSpawnedSession(cmd: string, sessionId: string): boolean {
    if (!sessionId || !cmd.includes('--started-by')) return false
    if (!/(?:^|\s)--started-by(?:\s+|=)runner(?:\s|$)/.test(cmd)) return false

    const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Require an explicit HAPI id flag. Do not match bare `--resume <native-id>`
    // — that is the agent session, not the HAPI row id.
    return new RegExp(
        `(?:^|\\s)(?:--existing-session-id|--hapi-session-id)(?:\\s+|=)${escaped}(?:\\s|$)`
    ).test(cmd)
}

export function selectOrphanPidsForSession(
    processes: ProcessSnapshot[],
    sessionId: string,
    selfPid: number = process.pid
): number[] {
    const pids: number[] = []
    for (const proc of processes) {
        if (proc.pid === selfPid) continue
        const cmd = proc.cmd || ''
        const name = proc.name || ''
        if (!isHapiDriverCliCommand(cmd, name)) continue
        if (!commandMatchesRunnerSpawnedSession(cmd, sessionId)) continue
        pids.push(proc.pid)
    }
    return pids
}

export async function findRunnerSpawnedOrphanPids(
    sessionId: string,
    listProcesses: () => Promise<ProcessSnapshot[]> = () => psList()
): Promise<number[] | 'scan_failed'> {
    try {
        const processes = await listProcesses()
        return selectOrphanPidsForSession(processes, sessionId)
    } catch {
        return 'scan_failed'
    }
}

/**
 * Tree-kill every argv-matched orphan for `sessionId`.
 * Returns null when none were found (caller continues to other stop paths).
 * Returns still_alive when the process scan fails — empty is not proof gone.
 */
export async function reapRunnerSpawnedOrphans(
    sessionId: string,
    deps: {
        findOrphans?: (sessionId: string) => Promise<number[] | 'scan_failed'>
        killTree?: (pid: number) => Promise<boolean>
    } = {}
): Promise<'stopped' | 'still_alive' | null> {
    const findOrphans = deps.findOrphans ?? findRunnerSpawnedOrphanPids
    const killTree = deps.killTree ?? (async (pid: number) => {
        const { killProcessTreeByPid } = await import('@/utils/process')
        return killProcessTreeByPid(pid)
    })

    const orphanPids = await findOrphans(sessionId)
    if (orphanPids === 'scan_failed') return 'still_alive'
    if (orphanPids.length === 0) return null

    // killProcessTreeByPid returns false if any collected descendant survives,
    // even when the stamped root PID has already exited. Trust that result —
    // do not downgrade to stopped based on root liveness alone (#1910).
    for (const orphanPid of orphanPids) {
        if (!(await killTree(orphanPid))) {
            return 'still_alive'
        }
    }
    return 'stopped'
}
