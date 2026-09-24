/**
 * Argv-based discovery of runner-spawned driver CLI processes that are no
 * longer present in the runner's in-memory / resume-process maps.
 *
 * Detached children (PPID=1 after KillMode=process runner bounce) can survive
 * with no tracking entry. `stopSession` must still be able to reap them when
 * the hub archives by HAPI session id — matching `--started-by runner` plus
 * an explicit `--existing-session-id` / `--hapi-session-id` flag.
 *
 * Windows: do not use ps-list. Its fastlist vendor binary is often missing from
 * single-exe bundles and never returns CommandLine — argv matching needs CIM.
 */

import spawn from 'cross-spawn'
import psList from 'ps-list'
import { getProcessStartMarker, isProcessAlive } from '@/utils/process'

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
    const self = Number(selfPid)
    for (const proc of processes) {
        // Coerce: some listers return string PIDs; Number.isFinite("123") is false.
        const pid = typeof proc.pid === 'number' ? proc.pid : Number(proc.pid)
        if (!Number.isFinite(pid) || pid <= 0) continue
        if (pid === self) continue
        const cmd = proc.cmd || ''
        const name = proc.name || ''
        if (!isHapiDriverCliCommand(cmd, name)) continue
        if (!commandMatchesRunnerSpawnedSession(cmd, sessionId)) continue
        pids.push(pid)
    }
    return pids
}

/** Win32 process list with CommandLine for argv orphan matching. */
export function listWindowsProcessesWithCommandLine(): ProcessSnapshot[] {
    const result = spawn.sync(
        'powershell',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
    if (result.error || result.status !== 0) {
        throw result.error ?? new Error(`powershell Win32_Process exit ${result.status}`)
    }
    const raw = (result.stdout ?? '').trim()
    if (!raw) return []
    const parsed = JSON.parse(raw) as
        | Array<{ ProcessId?: number; Name?: string; CommandLine?: string }>
        | { ProcessId?: number; Name?: string; CommandLine?: string }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
        .map((row) => ({
            pid: Number(row.ProcessId),
            name: row.Name ?? '',
            cmd: row.CommandLine ?? '',
        }))
        .filter((proc) => Number.isFinite(proc.pid) && proc.pid > 0)
}

export async function listProcessesForOrphanScan(): Promise<ProcessSnapshot[]> {
    if (process.platform === 'win32') {
        return listWindowsProcessesWithCommandLine()
    }
    const list = await psList()
    return list.map((proc) => ({
        pid: proc.pid,
        cmd: proc.cmd,
        name: proc.name,
    }))
}

export async function findRunnerSpawnedOrphanPids(
    sessionId: string,
    listProcesses: () => Promise<ProcessSnapshot[]> = listProcessesForOrphanScan
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
 *
 * PID-reuse guard (same pattern as tracked/adopted kill paths): capture
 * `getProcessStartMarker` immediately after the argv match list is known, then
 * re-check immediately before each `killTree`. Skip the kill when the marker
 * changed or cannot be read for a still-live PID.
 */
export async function reapRunnerSpawnedOrphans(
    sessionId: string,
    deps: {
        findOrphans?: (sessionId: string) => Promise<number[] | 'scan_failed'>
        killTree?: (pid: number) => Promise<boolean>
        getStartMarker?: (pid: number) => string | null
        isAlive?: (pid: number) => boolean
    } = {}
): Promise<'stopped' | 'still_alive' | null> {
    const findOrphans = deps.findOrphans ?? findRunnerSpawnedOrphanPids
    const killTree = deps.killTree ?? (async (pid: number) => {
        const { killProcessTreeByPid } = await import('@/utils/process')
        return killProcessTreeByPid(pid)
    })
    const getStartMarker = deps.getStartMarker ?? getProcessStartMarker
    const isAlive = deps.isAlive ?? isProcessAlive

    const orphanPids = await findOrphans(sessionId)
    if (orphanPids === 'scan_failed') return 'still_alive'
    if (orphanPids.length === 0) return null

    // Capture generation identity as soon as the argv match list is known —
    // before any await that widens the scan→kill gap under PID churn.
    const targets = orphanPids.map((pid) => ({
        pid,
        expectedMarker: getStartMarker(pid),
    }))

    // killProcessTreeByPid returns false if any collected descendant survives,
    // even when the stamped root PID has already exited. Trust that result —
    // do not downgrade to stopped based on root liveness alone (#1910).
    let resolved = 0
    for (const { pid: orphanPid, expectedMarker } of targets) {
        if (expectedMarker === null) {
            // No generation identity. If the PID is already dead the orphan is
            // gone; if still alive, refuse to tree-kill without a marker.
            if (!isAlive(orphanPid)) {
                resolved++
                continue
            }
            return 'still_alive'
        }

        const currentMarker = getStartMarker(orphanPid)
        if (currentMarker === null || currentMarker !== expectedMarker) {
            // Generation changed (PID reuse) or vanished — never kill whatever
            // process now holds this PID. The matched orphan generation is gone.
            resolved++
            continue
        }

        if (!(await killTree(orphanPid))) {
            return 'still_alive'
        }
        resolved++
    }
    return resolved === targets.length ? 'stopped' : 'still_alive'
}
