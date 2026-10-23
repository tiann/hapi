import { execFile } from 'node:child_process'

export type WindowsProcessEntry = { parentPid: number; marker: string | null; name: string; commandLine: string }
export type WindowsProcessTable = Map<number, WindowsProcessEntry>

// One complete CIM snapshot supplies ancestry AND generation markers. Launching
// PowerShell/tasklist for each member made a small tree take over a minute.
export function windowsProcessTableCommand(pids?: number[], includeCommandLine = false): string {
    if (pids?.length && !includeCommandLine) {
        // Verification needs only PID + generation, not another WMI table.
        // CIM truncates Windows FILETIME to microseconds; keep its existing
        // marker format so both sources identify the same process generation.
        return [
            "$ErrorActionPreference='Stop'", 'trap { exit 1 }', '$rows=@(',
            `foreach($processId in @(${pids.join(',')})){`,
            '  $p=$null',
            '  try { $p=[System.Diagnostics.Process]::GetProcessById($processId) }',
            '  catch [System.ArgumentException] { continue }',
            '  try {',
            '    try { $marker=$p.StartTime.ToUniversalTime().ToString("yyyy-MM-dd\'T\'HH:mm:ss.ffffff\'0Z\'") }',
            '    catch { if($p.HasExited){continue}; throw }',
            '    [pscustomobject]@{ProcessId=$processId;ParentProcessId=0;CreationDate=$marker}',
            '  } finally { if($p){$p.Dispose()} }',
            '}', ')', '@{complete=$true;processes=$rows} | ConvertTo-Json -Depth 4 -Compress',
        ].join('\n')
    }
    const properties = `ProcessId,ParentProcessId,CreationDate${includeCommandLine ? ',Name,CommandLine' : ''}`
    const filter = pids?.length ? ` -Filter "${pids.map(pid => `ProcessId = ${pid}`).join(' OR ')}"` : ''
    return [
        "$ErrorActionPreference='Stop'",
        'trap { exit 1 }',
        `$rows=@(Get-CimInstance Win32_Process -Property ${properties}${filter} | Select-Object ProcessId,ParentProcessId,Name,CommandLine,`,
        "  @{N='CreationDate';E={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }}})",
        '@{complete=$true;processes=$rows} | ConvertTo-Json -Depth 4 -Compress',
    ].join('\n')
}
export const WINDOWS_PROCESS_TABLE_COMMAND = windowsProcessTableCommand()

function execute(file: string, args: string[], timeout: number): Promise<string | null> {
    if (timeout <= 0) return Promise.resolve(null)
    return new Promise(resolve => {
        execFile(file, args, {
            encoding: 'utf8', windowsHide: true, timeout: Math.ceil(timeout),
            killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
        }, (error, stdout) => resolve(error ? null : stdout))
    })
}

export async function readWindowsProcessTable(timeout = 15_000, pids?: number[], includeCommandLine = false): Promise<WindowsProcessTable | null> {
    if (pids?.some(pid => !Number.isInteger(pid) || pid < 0)) return null
    const output = await execute('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowsProcessTableCommand(pids, includeCommandLine)], timeout)
    if (output === null) return null
    try {
        const parsed = JSON.parse(output)
        if (parsed?.complete !== true || !Array.isArray(parsed.processes) || (!pids?.length && !parsed.processes.length)) return null
        const table: WindowsProcessTable = new Map()
        for (const entry of parsed.processes) {
            if (!entry || !Number.isInteger(entry.ProcessId) || entry.ProcessId < 0
                || !Number.isInteger(entry.ParentProcessId) || entry.ParentProcessId < 0
                || (entry.CreationDate !== null && typeof entry.CreationDate !== 'string')
                || table.has(entry.ProcessId)) return null
            table.set(entry.ProcessId, { parentPid: entry.ParentProcessId, marker: entry.CreationDate || null,
                name: typeof entry.Name === 'string' ? entry.Name : '',
                commandLine: typeof entry.CommandLine === 'string' ? entry.CommandLine : '',
            })
        }
        return table
    } catch { return null }
}

/** A failed probe conservatively keeps ownership; it must never authorize a kill. */
export function windowsGenerationMayBeAlive(table: WindowsProcessTable | null, pid: number, marker?: string): boolean {
    if (table === null) return true
    const entry = table.get(pid)
    return Boolean(entry && (!entry.marker || !marker || entry.marker === marker))
}

export type WindowsStopReport = { confirmed: boolean; phase: string; elapsedMs: number; snapshots: number }
export async function stopWindowsProcessTree(rootPid: number, force: boolean, report?: (result: WindowsStopReport) => void): Promise<boolean> {
    // Includes command startup, queries, signalling and verification, independent
    // of tree size. Each async child is killed when its remaining budget expires.
    const started = performance.now()
    const deadline = started + 45_000
    let phase = 'initial-snapshot', snapshots = 1
    const finish = (confirmed: boolean) => {
        report?.({ confirmed, phase, elapsedMs: Math.round(performance.now() - started), snapshots })
        return confirmed
    }
    const remaining = () => Math.max(0, deadline - performance.now())
    const initial = await readWindowsProcessTable(Math.min(15_000, remaining()))
    if (!initial) return finish(false)
    const members = new Map<number, string | null>()
    const queue = [rootPid]
    while (queue.length) {
        const pid = queue.shift()!
        if (members.has(pid)) continue
        members.set(pid, initial.get(pid)?.marker ?? null)
        for (const [child, entry] of initial) if (child !== pid && entry.parentPid === pid) queue.push(child)
    }

    const unresolved = new Map(members)
    const snapshot = () => {
        phase = 'verification-snapshot'; snapshots++
        return readWindowsProcessTable(Math.min(10_000, remaining()), [...unresolved.keys()])
    }
    const refresh = (table: WindowsProcessTable) => {
        for (const [pid, marker] of unresolved) {
            const current = table.get(pid)
            // A different known generation proves the ORIGINAL process exited.
            // Once resolved, PID reuse cannot reintroduce it into this tree.
            if (!current || (marker && current.marker && marker !== current.marker)) unresolved.delete(pid)
        }
    }
    const signal = async (pid: number, hard: boolean, tree: boolean) => {
        phase = 'signal'
        return execute('taskkill', [
            ...(hard ? ['/F'] : []), ...(tree ? ['/T'] : []), '/PID', String(pid),
        ], Math.min(5_000, remaining()))
    }
    refresh(initial)
    if (!unresolved.size) return finish(true)

    // Recheck the root's generation immediately before tree-wide signalling.
    let current = await snapshot()
    if (!current) return finish(false)
    refresh(current)
    const rootMarker = members.get(rootPid)
    if (unresolved.has(rootPid) && rootMarker && current.get(rootPid)?.marker === rootMarker) {
        const softAccepted = await signal(rootPid, force, true)
        if (!force && softAccepted !== null) {
            const graceDeadline = Math.min(deadline, performance.now() + 2_000)
            while (unresolved.size && performance.now() < graceDeadline) {
                current = await snapshot()
                if (!current) return finish(false)
                refresh(current)
                if (unresolved.size && performance.now() < graceDeadline) {
                    await new Promise(resolve => setTimeout(resolve, Math.min(100, graceDeadline - performance.now())))
                }
            }
        }
    }

    // /T may miss detached descendants. Recheck each survivor using a COMPLETE
    // snapshot, then signal only its captured generation (without another /T).
    for (const pid of [...unresolved.keys()].reverse()) {
        if (!unresolved.size) return finish(true)
        if (!remaining()) return finish(false)
        current = await snapshot()
        if (!current) return finish(false)
        refresh(current)
        if (!unresolved.size) return finish(true)
        const expected = unresolved.get(pid)
        if (!expected || current.get(pid)?.marker !== expected) continue
        await signal(pid, true, false)
    }
    while (remaining()) {
        current = await snapshot()
        if (!current) return finish(false)
        refresh(current)
        if (!unresolved.size) return finish(true)
        await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining())))
    }
    return finish(false)
}
