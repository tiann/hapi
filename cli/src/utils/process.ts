import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';

export const isWindows = (): boolean => process.platform === 'win32';

/** Bound hung WMI/tasklist/ps so a wedged spawn cannot darken the runner (#1911 Overseer B3). */
const SPAWN_SYNC_TIMEOUT_MS = 10_000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  // Windows: prefer tasklist. Bun/Node `process.kill(pid, 0)` is unreliable as a
  // liveness probe on win32 and can disagree with the console tree taskkill sees.
  if (isWindows()) {
    try {
      const result = spawn.sync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/NH'],
        { stdio: 'pipe', windowsHide: true, encoding: 'utf8', timeout: SPAWN_SYNC_TIMEOUT_MS }
      );
      if (!result.error && result.status === 0) {
        const out = (result.stdout?.toString() ?? '').trim();
        if (!out || /no tasks/i.test(out)) return false;
        return new RegExp(`(^|\\D)${pid}(\\D|$)`).test(out);
      }
    } catch {
      // fall through to signal-0 probe
    }
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared Win32 generation marker: CIM CreationDate as UTC round-trip ISO.
 * Must match orphan list + recheck — ConvertTo-Json of a raw DateTime emits
 * `/Date(...)/` on Windows PowerShell 5.1 (#1911 bot Major).
 */
export const WINDOWS_CIM_CREATION_DATE_MARKER_EXPR =
  "$_.CreationDate.ToUniversalTime().ToString('o')";

/** PowerShell -Command body for the argv orphan process list (CIM + JSON). */
export function windowsProcessListCimCommand(): string {
  // Fail closed: non-terminating CIM errors must not yield empty stdout with
  // exit 0 (that was misread as "no orphans" → false archive-ok). #1911 B2.
  // Note: Stop on the whole enumeration means one transient per-instance WMI
  // error aborts the scan → still_alive until it clears (availability trap,
  // fail-closed; #1911 Overseer non-blocker).
  return [
    "$ErrorActionPreference='Stop'",
    'trap { exit 1 }',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,'
      + `@{N='CreationDate';E={if ($_.CreationDate) { ${WINDOWS_CIM_CREATION_DATE_MARKER_EXPR} } else { $null }}}`
      + ' | ConvertTo-Json -Compress',
  ].join('\n')
}

/** PowerShell -Command body for a single-PID start-marker probe. */
export function windowsProcessMarkerCimCommand(pid: number): string {
  const expr = WINDOWS_CIM_CREATION_DATE_MARKER_EXPR.replace(/\$_/g, '$p');
  return (
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; `
    + `if ($p -and $p.CreationDate) { ${expr} }`
  );
}

/** Stable marker for one OS PID generation; null means the platform probe failed. */
export function getProcessStartMarker(pid: number): string | null {
  if (!isProcessAlive(pid)) return null;
  if (isWindows()) {
    // Same UTC ISO 'o' string as orphanReap listWindowsProcessesWithCommandLine.
    // Do not print raw DateTime or use WMIC DMTF (format mismatch skips reap).
    const powershell = spawn.sync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      windowsProcessMarkerCimCommand(pid),
    ], { stdio: 'pipe', windowsHide: true, timeout: SPAWN_SYNC_TIMEOUT_MS });
    if (!powershell.error && powershell.status === 0) {
      const marker = powershell.stdout?.toString().trim();
      if (marker) return marker;
    }
    return null;
  }
  const result = spawn.sync('ps', ['-p', String(pid), '-o', 'lstart='], {
    stdio: 'pipe',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout?.toString().trim() || null;
}

// ponytail: ps -p is cheap and avoids PID-reuse false positives after OS upgrades/reboots
function isRunnerCommand(commandLine: string): boolean {
  return /(?:^|\s)runner(?:\s|$)/.test(commandLine) && /(?:^|\s)start-sync(?:\s|$)/.test(commandLine);
}

function getWindowsProcessCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const powershell = spawn.sync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
  ], { stdio: 'pipe', windowsHide: true, timeout: SPAWN_SYNC_TIMEOUT_MS });
  if (!powershell.error && powershell.status === 0) {
    const commandLine = powershell.stdout?.toString() ?? '';
    if (commandLine.trim()) return commandLine;
  }

  const wmic = spawn.sync('wmic', [
    'process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'
  ], { stdio: 'pipe', windowsHide: true, timeout: SPAWN_SYNC_TIMEOUT_MS });
  if (!wmic.error && wmic.status === 0) {
    const commandLine = readWmicCommandLine(wmic.stdout?.toString() ?? '');
    if (commandLine) return commandLine;
  }

  return null;
}

/**
 * `wmic ... get CommandLine` prints the `CommandLine` column header even when
 * the property itself is empty or unreadable, so the raw stdout is never empty
 * on success. Drop the header before deciding whether a command line was read.
 */
function readWmicCommandLine(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => line.trim() === 'CommandLine');
  const value = (headerIndex === -1 ? lines : lines.slice(headerIndex + 1)).join('\n');
  return value.trim() ? value : null;
}

/**
 * `unknown` means the process is alive but its command line could not be read.
 * Callers must not signal or clean up on that answer: the pid may belong to an
 * unrelated process that reused it, and it may equally be a healthy runner.
 */
export type RunnerProcessIdentity = 'runner' | 'foreign' | 'unknown' | 'dead';

export function getHapiRunnerProcessIdentity(pid: number): RunnerProcessIdentity {
  if (!isProcessAlive(pid)) {
    return 'dead';
  }
  const commandLine = isWindows()
    ? getWindowsProcessCommandLine(pid)
    : getPosixProcessCommandLine(pid);
  if (commandLine === null) {
    return isProcessAlive(pid) ? 'unknown' : 'dead';
  }
  return isRunnerCommand(commandLine) ? 'runner' : 'foreign';
}

function getPosixProcessCommandLine(pid: number): string | null {
  const result = spawn.sync('ps', ['-p', String(pid), '-o', 'command='], {
    stdio: 'pipe',
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  const commandLine = result.stdout?.toString() ?? '';
  return commandLine.trim() ? commandLine : null;
}

function killProcessWindows(pid: number, force: boolean): boolean {
  if (!isProcessAlive(pid)) {
    return true;
  }

  const args = ['/T', '/PID', pid.toString()];
  if (force) {
    args.unshift('/F');
  }
  try {
    const result = spawn.sync('taskkill', args, {
      stdio: 'pipe',
      windowsHide: true,
      timeout: SPAWN_SYNC_TIMEOUT_MS,
    });
    if (result.error) {
      return false;
    }

    if (result.status === 0) {
      return true;
    }

    // Process teardown on Windows is racy: by the time taskkill runs, the target
    // may already be gone, which commonly surfaces as non-zero exit codes
    // (including 128 in some shells). Treat this as success if PID is no longer alive.
    return !isProcessAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Collect a win32 process tree (children first, root last) via CIM ParentProcessId.
 * Used to verify taskkill /T actually cleared descendants — exit 0 is "signalled",
 * not "gone" (#1911 B2).
 *
 * Returns `'scan_failed'` when PowerShell errors or returns nothing usable —
 * callers must fail closed (never fall back to root-only verify).
 *
 * Success is a positive sentinel (`OK:<pids>`), not "exit 0 + somehow looks like
 * PIDs". With `-ErrorAction SilentlyContinue`, a CIM failure exited 0 printing
 * only the root — byte-identical to a healthy childless tree (#1911 B1).
 */
export function windowsProcessTreeCimCommand(pid: number): string {
  // Newlines between statements — `.join(' ')` is a parse error on WinPS
  // (`$seen=@{} $bfs=@()`). Do not join with `;` either: `while(...){;` is invalid.
  return [
    "$ErrorActionPreference='Stop'",
    'trap { exit 1 }',
    `$root=${pid}`,
    '$seen=@{}',
    '$bfs=@()',
    '$queue=@($root)',
    'while($queue.Count -gt 0){',
    '  $p=$queue[0]; if($queue.Count -eq 1){$queue=@()}else{$queue=$queue[1..($queue.Count-1)]}',
    '  if($seen.ContainsKey($p)){continue}',
    '  $seen[$p]=$true',
    '  $bfs+=$p',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" |',
    '    ForEach-Object { $queue+=,[int]$_.ProcessId }',
    '}',
    // children-first: reverse BFS so root is last; OK: marks clean completion
    'if($bfs.Count -gt 0){ [array]::Reverse($bfs); Write-Output ("OK:" + ($bfs -join ",")) }',
  ].join('\n')
}

/** Parse tree-scan stdout. Requires the `OK:` success sentinel (#1911 B1). */
export function parseWindowsProcessTreeStdout(
  raw: string,
  rootPid: number
): number[] | 'scan_failed' {
  const text = raw.trim()
  if (!text.startsWith('OK:')) return 'scan_failed'
  const body = text.slice('OK:'.length).trim()
  if (!body) return 'scan_failed'
  const pids = body.split(',').map((s) => Number(s.trim())).filter((p) => Number.isFinite(p) && p > 0)
  if (pids.length === 0 || !pids.includes(rootPid)) return 'scan_failed'
  return pids
}

export function collectWindowsProcessTree(pid: number): number[] | 'scan_failed' {
  const n = typeof pid === 'number' ? pid : Number(pid)
  if (!Number.isFinite(n) || n <= 0) return 'scan_failed'

  const result = spawn.sync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsProcessTreeCimCommand(n),
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: SPAWN_SYNC_TIMEOUT_MS }
  )
  if (result.error || result.status !== 0) {
    return 'scan_failed'
  }
  return parseWindowsProcessTreeStdout((result.stdout ?? '').toString(), n)
}

async function signalAndWaitWindowsRoot(pid: number, force: boolean): Promise<void> {
  if (force) {
    killProcessWindows(pid, true);
    await waitForProcessToDie(pid, true);
    return;
  }
  const softOk = killProcessWindows(pid, false);
  if (!softOk && isProcessAlive(pid)) {
    killProcessWindows(pid, true);
    await waitForProcessToDie(pid, true);
    return;
  }
  await waitForProcessToDie(pid, false);
}

export async function killProcess(pid: number, force: boolean = false): Promise<boolean> {
  const n = typeof pid === 'number' ? pid : Number(pid)
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }

  if (isWindows()) {
    // Soft taskkill (/T without /F) is routinely refused on win32 console trees
    // ("can only be terminated forcefully"). Mirror POSIX SIGTERM→SIGKILL:
    // escalate immediately only when soft kill is *refused*; when soft succeeds
    // but the PID is still draining, honor the grace wait before /F so archive
    // flush can finish.
    // Root-only verify — callers that need full-tree proof use killProcessTreeByPid.
    await signalAndWaitWindowsRoot(n, force);
    return !isProcessAlive(n);
  }

  try {
    process.kill(n, force ? 'SIGKILL' : 'SIGTERM');
    await waitForProcessToDie(n, force);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively collects all descendant PIDs of a process (depth-first).
 * Returns PIDs in child-first order (leaves first, root last), or
 * `'scan_failed'` when pgrep could not be run (so callers fail closed
 * instead of verifying root-only — #1911 Opus / Overseer).
 */
function collectProcessTree(pid: number): number[] | 'scan_failed' {
  const pids: number[] = [];

  const result = spawn.sync('pgrep', ['-P', pid.toString()], {
    encoding: 'utf8',
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  });
  // spawn.sync returns {error} rather than throwing when the binary is missing.
  if (result.error) {
    return 'scan_failed';
  }
  // pgrep: 0 = matches, 1 = no children. null = signalled / aborted → partial
  // stdout is not a trustworthy tree (#1911 Overseer POSIX B1 twin).
  if (result.status !== 0 && result.status !== 1) {
    return 'scan_failed';
  }
  if (result.stdout) {
    const childPids = result.stdout.trim().split('\n').filter(Boolean).map(Number);
    for (const childPid of childPids) {
      if (!Number.isFinite(childPid) || childPid <= 0) continue;
      const nested = collectProcessTree(childPid);
      if (nested === 'scan_failed') return 'scan_failed';
      pids.push(...nested);
    }
  }

  pids.push(pid);
  return pids;
}

/**
 * Kills a process and all its descendants.
 * Signals are sent synchronously (children first) to work in exit handlers,
 * then waits asynchronously for processes to die.
 */
async function killProcessTree(pid: number, force: boolean): Promise<boolean> {
  // Collect all PIDs first (sync) - returns in child-first order
  const pids = collectProcessTree(pid);
  if (pids === 'scan_failed') {
    // Signal the known root anyway (partial kill > zero kill), but never claim
    // stopped without a full-tree verify (#1911 Opus Major / debian-slim no pgrep).
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
    await waitForProcessToDie(pid, force);
    return false;
  }

  // Signal all processes synchronously (children first, then root)
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  for (const p of pids) {
    try {
      process.kill(p, signal);
    } catch {
      // Process may have already exited
    }
  }

  // Wait for processes to die (async) - wait for root last
  for (const p of pids) {
    await waitForProcessToDie(p, force);
  }

  return pids.every((candidate) => !isProcessAlive(candidate));
}

/** Kill a PID and all descendants, verifying the complete tree is gone. */
export async function killProcessTreeByPid(pid: number, force: boolean = false): Promise<boolean> {
  const n = typeof pid === 'number' ? pid : Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false;
  if (isWindows()) {
    // taskkill /T exit 0 means "signalled", not "every descendant is dead".
    // Collect the tree + generation markers first, signal the root with /T,
    // then individually signal any surviving pre-kill PIDs whose generation
    // still matches (PID reuse must not be killed) (#1911 bot Major).
    const treePids = collectWindowsProcessTree(n);
    if (treePids === 'scan_failed') {
      // Still signal the (known) root — scan failure must not mean zero kill —
      // but never claim stopped without a full-tree verify (#1911 Opus Major).
      await signalAndWaitWindowsRoot(n, force);
      return false;
    }
    const markers = new Map<number, string | null>();
    for (const candidate of treePids) {
      markers.set(candidate, getProcessStartMarker(candidate));
    }
    await signalAndWaitWindowsRoot(n, force);
    for (const survivor of treePids) {
      if (survivor === n) continue;
      if (!isProcessAlive(survivor)) continue;
      const expected = markers.get(survivor);
      const current = getProcessStartMarker(survivor);
      // Unverifiable or reused PID — leave alone; final every() fails closed.
      if (!expected || !current || current !== expected) continue;
      await signalAndWaitWindowsRoot(survivor, true);
    }
    return treePids.every((candidate) => !isProcessAlive(candidate));
  }
  return killProcessTree(n, force);
}

/**
 * Waits for a process to die, escalating if the graceful signal didn't work.
 * POSIX: SIGTERM → SIGKILL. Windows: taskkill /T → taskkill /F /T.
 */
async function waitForProcessToDie(pid: number, force: boolean): Promise<void> {
  const maxWait = 2000;
  // Windows isProcessAlive shells out to tasklist; keep the poll coarse so a
  // stop cannot burn the runner event loop for seconds (#1911 Overseer).
  const pollInterval = isWindows() ? 100 : 20;
  let waited = 0;

  while (isProcessAlive(pid) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  // Graceful kill didn't finish — escalate (same structure on both platforms).
  if (!force && isProcessAlive(pid)) {
    try {
      if (isWindows()) {
        killProcessWindows(pid, true);
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      return;
    }
    waited = 0;
    while (isProcessAlive(pid) && waited < 1000) {
      await new Promise(r => setTimeout(r, pollInterval));
      waited += pollInterval;
    }
  }
}

export async function killProcessByChildProcess(
  child: ChildProcess,
  force: boolean = false
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) {
    return false;
  }

  // Both platforms: tree-kill + full-tree verify (win32 must not trust root-only).
  return killProcessTreeByPid(pid, force);
}
