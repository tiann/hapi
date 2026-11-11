/**
 * Final audit for test-owned processes.
 *
 * The runner integration suite spawns real detached process trees. Even with
 * the per-test registry (see `processRegistry.ts`), an orphan whose runner was
 * already killed, or a child that escaped a crashing test, can survive the
 * suite. This module is the last-resort backstop: it scans the live process
 * table for the run's unique marker (`HAPI_TEST_MARKER=<tmpHome>`, injected by
 * `integrationEnv.ts` into every test child) and force-reaps whatever remains.
 *
 * The marker lives in the process environment, which survives reparenting to
 * PID 1, so orphaned grandchildren are still recognized. Production processes
 * never carry the marker and are never touched.
 */

import { execFileSync } from 'node:child_process'

export interface TestOwnedProcess {
    pid: number
    ppid: number
    rssKb: number
    command: string
}

/**
 * Scans for live processes whose environment dump contains `marker`.
 * Returns an empty array on platforms without `ps axeww` (Windows); THROWS on
 * scan failure (unsupported flags, buffer exhaustion, permission errors) so
 * the audit can never silently report "zero survivors" while detached
 * test-owned processes remain alive.
 *
 * The environment-bearing scan is used ONLY to identify marked PIDs.
 * Diagnostics (the `command` field) are fetched with a separate `ps` call
 * WITHOUT `e`, so inherited credentials in the env dump never reach logs.
 */
export function findTestOwnedProcesses(marker: string): TestOwnedProcess[] {
    if (process.platform === 'win32') return []

    let output: string
    try {
        // BSD-style full dump (`a` all users, `x` include tty-less processes,
        // `e` show the environment after the command, `ww` remove width
        // truncation so the env dump is not cut off). The SysV dashed forms
        // must NOT be used: on macOS `ps eww` is terminal-scoped (and exits 1
        // without a controlling terminal), while `ps -eww` treats `-e` as
        // "all processes" and silently drops the environment — which would
        // make the marker scan report "no survivors" while test-owned
        // processes stay alive. procps-ng 4.x accepts the BSD `a`/`x` forms
        // (only the dashed `-axo` combo is rejected with "must set
        // personality" on some Linux builds), so this invocation is portable
        // across darwin and Linux.
        output = execFileSync('ps', ['axeww', '-eo', 'pid=,ppid=,rss=,command='], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
    } catch (error) {
        throw new Error(
            `[test process audit] failed to inspect process table: ${error instanceof Error ? error.message : String(error)}`
        )
    }

    const matchedPids: number[] = []
    const ppidByPid = new Map<number, number>()
    const rssByPid = new Map<number, number>()
    for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
        if (!match) continue
        if (match[4].includes(marker)) {
            const pid = Number(match[1])
            matchedPids.push(pid)
            ppidByPid.set(pid, Number(match[2]))
            rssByPid.set(pid, Number(match[3]))
        }
    }
    if (matchedPids.length === 0) return []

    // Fetch clean command lines (no environment) for diagnostics.
    const commandByPid = new Map<number, string>()
    try {
        const clean = execFileSync(
            'ps',
            ['-p', matchedPids.join(','), '-o', 'pid=,command='],
            {
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        )
        for (const line of clean.split('\n')) {
            const match = line.match(/^\s*(\d+)\s+(.*)$/)
            if (match) {
                commandByPid.set(Number(match[1]), match[2].trim())
            }
        }
    } catch {
        // Diagnostics are best-effort; never fall back to the env dump.
    }

    return matchedPids.map((pid) => ({
        pid,
        ppid: ppidByPid.get(pid) ?? 0,
        rssKb: rssByPid.get(pid) ?? 0,
        command: (commandByPid.get(pid) ?? '(command unavailable)').slice(0, 500),
    }))
}

/**
 * Force-reaps every process carrying `marker`, waiting a bounded window for
 * them to disappear, and returns whatever still remains.
 *
 * Every process in a test-owned tree carries the marker (env is inherited),
 * so there is no need to tree-walk: each scan finds the whole marked set and
 * SIGKILLs it directly. Kills are fire-and-forget — no per-PID wait — so the
 * 10s deadline strictly bounds this function even with many stuck processes.
 * The loop re-runs on every re-scan so a process that survived its first
 * SIGKILL (e.g. mid-exec, D-state) or spawned after the previous scan is
 * never given a free pass.
 */
export async function reapTestOwnedProcesses(marker: string): Promise<TestOwnedProcess[]> {
    const deadline = Date.now() + 10_000
    let found = findTestOwnedProcesses(marker)
    while (found.length > 0 && Date.now() < deadline) {
        for (const { pid } of found) {
            try {
                process.kill(pid, 'SIGKILL')
            } catch {
                // Already dead or racing exit; re-scan below decides.
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
        found = findTestOwnedProcesses(marker)
    }
    return findTestOwnedProcesses(marker)
}
