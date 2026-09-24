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
import { getProcessStartMarker, isProcessAlive, windowsProcessListCimCommand } from '@/utils/process'

export type ProcessSnapshot = {
    pid: number
    cmd?: string
    name?: string
    /**
     * Generation identity from the *same* listing that produced argv match.
     * POSIX: `ps` lstart (LC_ALL=C TZ=UTC) — same format as getProcessStartMarker.
     * Windows: Win32_Process.CreationDate as UTC ISO 'o' — same as getProcessStartMarker.
     */
    startMarker?: string | null
}

export type OrphanTarget = {
    pid: number
    /** Marker captured in the argv-match snapshot (not a later probe). */
    startMarker: string | null
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

export function selectOrphanTargetsForSession(
    processes: ProcessSnapshot[],
    sessionId: string,
    selfPid: number = process.pid
): OrphanTarget[] {
    const targets: OrphanTarget[] = []
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
        targets.push({
            pid,
            startMarker: proc.startMarker === undefined ? null : proc.startMarker,
        })
    }
    return targets
}

/** @deprecated Prefer selectOrphanTargetsForSession (keeps same-snapshot markers). */
export function selectOrphanPidsForSession(
    processes: ProcessSnapshot[],
    sessionId: string,
    selfPid: number = process.pid
): number[] {
    return selectOrphanTargetsForSession(processes, sessionId, selfPid).map((t) => t.pid)
}

/**
 * POSIX orphan listing: one `ps` snapshot with pid + lstart + args.
 * Uses the same LC_ALL/TZ as getProcessStartMarker so re-check compares equal.
 */
export function listPosixProcessesWithStartMarker(): ProcessSnapshot[] {
    const result = spawn.sync(
        'ps',
        ['awwxo', 'pid=,lstart=,args='],
        {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
            maxBuffer: 64 * 1024 * 1024,
            timeout: 10_000,
        }
    )
    if (result.error || result.status !== 0) {
        // status === null means the ps child was signal-killed; stdout is
        // truncated and must not be parsed as a complete process table
        // (#1911 Overseer B1 — twin of process.ts collectProcessTree).
        throw result.error ?? new Error(
            result.status === null ? 'ps aborted (signal)' : `ps exit ${result.status}`
        )
    }
    const stdout = (result.stdout ?? '').toString()
    const snapshots: ProcessSnapshot[] = []
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // pid, then lstart "Day Mon DD HH:MM:SS YYYY" (5 tokens), then args
        const match = trimmed.match(
            /^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
        )
        if (!match) continue
        const pid = Number(match[1])
        if (!Number.isFinite(pid) || pid <= 0) continue
        snapshots.push({
            pid,
            startMarker: match[2],
            cmd: match[3] ?? '',
            name: '',
        })
    }
    return snapshots
}

/**
 * Shared Win32 generation marker helpers live in `@/utils/process` so list +
 * single-PID probe stay format-identical. Re-export for orphanReap tests.
 */
export {
    WINDOWS_CIM_CREATION_DATE_MARKER_EXPR,
    windowsProcessListCimCommand,
    windowsProcessMarkerCimCommand,
} from '@/utils/process'

/** Win32 process list with CommandLine + CreationDate for argv orphan matching. */
export function listWindowsProcessesWithCommandLine(): ProcessSnapshot[] {
    const result = spawn.sync(
        'powershell',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            windowsProcessListCimCommand(),
        ],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }
    )
    if (result.error || result.status !== 0) {
        throw result.error ?? new Error(`powershell Win32_Process exit ${result.status}`)
    }
    const raw = (result.stdout ?? '').trim()
    // Empty stdout is a failed scan, not "no processes" — a live Windows host
    // always has System/Idle. Match process.ts collectWindowsProcessTree
    // fail-closed semantics so orphan reap does not claim archive-ok (#1911).
    if (!raw) {
        throw new Error('powershell Win32_Process returned empty stdout')
    }
    const parsed = JSON.parse(raw) as
        | Array<{ ProcessId?: number; Name?: string; CommandLine?: string; CreationDate?: string }>
        | { ProcessId?: number; Name?: string; CommandLine?: string; CreationDate?: string }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
        .map((row) => ({
            pid: Number(row.ProcessId),
            name: row.Name ?? '',
            cmd: row.CommandLine ?? '',
            startMarker: typeof row.CreationDate === 'string' && row.CreationDate.length > 0
                ? row.CreationDate
                : null,
        }))
        .filter((proc) => Number.isFinite(proc.pid) && proc.pid > 0)
}

export async function listProcessesForOrphanScan(): Promise<ProcessSnapshot[]> {
    if (process.platform === 'win32') {
        return listWindowsProcessesWithCommandLine()
    }
    return listPosixProcessesWithStartMarker()
}

export async function findRunnerSpawnedOrphanTargets(
    sessionId: string,
    listProcesses: () => Promise<ProcessSnapshot[]> = listProcessesForOrphanScan
): Promise<OrphanTarget[] | 'scan_failed'> {
    try {
        const processes = await listProcesses()
        return selectOrphanTargetsForSession(processes, sessionId)
    } catch {
        return 'scan_failed'
    }
}

/**
 * Production stopSession orphan discovery: argv match + same-snapshot markers,
 * then optional PID skip (shared wrappers / sibling roots). Callers must use
 * this (or an equivalent findTargets that keeps startMarker) — never strip to
 * bare PIDs via findRunnerSpawnedOrphanPids / findOrphans (#1911 Overseer).
 */
export async function findStopSessionOrphanTargets(
    sessionId: string,
    shouldSkipPid: (sessionId: string, pid: number) => boolean,
    listProcesses: () => Promise<ProcessSnapshot[]> = listProcessesForOrphanScan
): Promise<OrphanTarget[] | 'scan_failed'> {
    const found = await findRunnerSpawnedOrphanTargets(sessionId, listProcesses)
    if (found === 'scan_failed') return found
    return found.filter((t) => !shouldSkipPid(sessionId, t.pid))
}

export async function findRunnerSpawnedOrphanPids(
    sessionId: string,
    listProcesses: () => Promise<ProcessSnapshot[]> = listProcessesForOrphanScan
): Promise<number[] | 'scan_failed'> {
    const targets = await findRunnerSpawnedOrphanTargets(sessionId, listProcesses)
    if (targets === 'scan_failed') return 'scan_failed'
    return targets.map((t) => t.pid)
}

/**
 * Tree-kill every argv-matched orphan for `sessionId`.
 * Returns null when none were found (caller continues to other stop paths).
 * Returns still_alive when the process scan fails — empty is not proof gone.
 *
 * PID-reuse guard: expectedMarker comes from the *same* snapshot as the argv
 * match (not a later getProcessStartMarker call). Re-check immediately before
 * each killTree; skip when the marker changed or cannot be read for a live PID.
 *
 * When one target is unconfirmed, continue attempting the rest — return
 * still_alive if any remain ambiguous (#1911 bot Minor).
 */
export async function reapRunnerSpawnedOrphans(
    sessionId: string,
    deps: {
        findTargets?: (sessionId: string) => Promise<OrphanTarget[] | 'scan_failed'>
        /** @deprecated Prefer findTargets (includes same-snapshot markers). */
        findOrphans?: (sessionId: string) => Promise<number[] | 'scan_failed'>
        killTree?: (pid: number) => Promise<boolean>
        getStartMarker?: (pid: number) => string | null
        isAlive?: (pid: number) => boolean
    } = {}
): Promise<'stopped' | 'still_alive' | null> {
    const killTree = deps.killTree ?? (async (pid: number) => {
        const { killProcessTreeByPid } = await import('@/utils/process')
        return killProcessTreeByPid(pid)
    })
    const getStartMarker = deps.getStartMarker ?? getProcessStartMarker
    const isAlive = deps.isAlive ?? isProcessAlive

    let targets: OrphanTarget[]
    if (deps.findTargets) {
        const found = await deps.findTargets(sessionId)
        if (found === 'scan_failed') return 'still_alive'
        targets = found
    } else if (deps.findOrphans) {
        // Legacy: pids only — capture markers in a separate probe (tests / older callers).
        const orphanPids = await deps.findOrphans(sessionId)
        if (orphanPids === 'scan_failed') return 'still_alive'
        targets = orphanPids.map((pid) => ({
            pid,
            startMarker: getStartMarker(pid),
        }))
    } else {
        const found = await findRunnerSpawnedOrphanTargets(sessionId)
        if (found === 'scan_failed') return 'still_alive'
        targets = found
    }

    if (targets.length === 0) return null

    // killProcessTreeByPid returns false if any collected descendant survives,
    // even when the stamped root PID has already exited. Trust that result —
    // do not downgrade to stopped based on root liveness alone (#1910 / #1911 B2).
    let anyUnconfirmed = false
    let resolved = 0
    for (const { pid: orphanPid, startMarker: expectedMarker } of targets) {
        if (expectedMarker === null) {
            // No generation identity from the match snapshot. If the PID is
            // already dead the orphan is gone; if still alive, skip kill and
            // continue other targets (do not abort the whole sweep).
            if (!isAlive(orphanPid)) {
                resolved++
                continue
            }
            anyUnconfirmed = true
            continue
        }

        const currentMarker = getStartMarker(orphanPid)
        if (currentMarker === null) {
            // Probe failed mid-flight. Null is not proof of PID reuse (psutil
            // lesson: unknown create_time ≠ recycled). Skip kill; if still
            // alive, mark unconfirmed and continue.
            if (!isAlive(orphanPid)) {
                resolved++
                continue
            }
            anyUnconfirmed = true
            continue
        }
        if (currentMarker !== expectedMarker) {
            // Generation changed (PID reuse) — never kill whatever process now
            // holds this PID. The matched orphan generation is gone.
            resolved++
            continue
        }

        if (!(await killTree(orphanPid))) {
            anyUnconfirmed = true
            continue
        }
        resolved++
    }

    if (anyUnconfirmed) return 'still_alive'
    return resolved === targets.length ? 'stopped' : 'still_alive'
}
