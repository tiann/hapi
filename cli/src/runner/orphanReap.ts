/**
 * Argv-based discovery of runner-spawned driver CLI processes that are no
 * longer present in the runner's in-memory / resume-process maps.
 *
 * Detached children (PPID=1 after KillMode=process runner bounce) can survive
 * with no tracking entry. `stopSession` must still be able to reap them when
 * the hub archives by HAPI session id — matching `--started-by runner` plus
 * the session id on argv (`--existing-session-id`, `--hapi-session-id`, or
 * adjacent token).
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
): Promise<number[]> {
    try {
        const processes = await listProcesses()
        return selectOrphanPidsForSession(processes, sessionId)
    } catch {
        return []
    }
}
