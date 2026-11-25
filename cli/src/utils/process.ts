import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { readFileSync } from 'node:fs';
import { monotonicTimeMs } from '@/utils/time';
import { stopWindowsProcessTree, type WindowsStopReport } from './windowsProcessStop';
import { windowsSystemTool } from './windowsSystemTools';

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
        windowsSystemTool('tasklist'),
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

/** Linux boot and thread identity are independent of a potentially reused PID. */
export function normalizeBootId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

export function getSystemBootId(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return normalizeBootId(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
  } catch {
    return null;
  }
}

export function getProcessThreadGroupId(pid: number): number | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^Tgid:[ \t]+([0-9]+)[ \t]*$/m.exec(status);
    const tgid = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(tgid) && tgid > 0 ? tgid : null;
  } catch {
    return null;
  }
}

/** POSIX process-group id (pgid); null when unavailable. Used to cover mid-Stop forks (#2021). */
export function getProcessGroupId(pid: number): number | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    // Fields after comm: state(3) ppid(4) pgrp(5) → index 2 after the split.
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const pgrp = Number(fields[2]);
    return Number.isSafeInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

/** Stable marker for one OS PID generation; null means the platform probe failed. */
export function getProcessStartMarker(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isWindows()) {
    // CIM already answers whether this PID has a readable generation. A
    // preceding tasklist adds a process launch without strengthening identity.
    // Same UTC ISO 'o' string as orphanReap listWindowsProcessesWithCommandLine.
    // Do not print raw DateTime or use WMIC DMTF (format mismatch skips reap).
    const powershell = spawn.sync(windowsSystemTool('powershell'), [
      '-NoProfile', '-NonInteractive', '-Command',
      windowsProcessMarkerCimCommand(pid),
    ], { stdio: 'pipe', windowsHide: true, timeout: SPAWN_SYNC_TIMEOUT_MS });
    if (!powershell.error && powershell.status === 0) {
      const marker = powershell.stdout?.toString().trim();
      if (marker) return marker;
    }
    return null;
  }
  if (!isProcessAlive(pid)) return null;
  const result = spawn.sync('ps', ['-p', String(pid), '-o', 'lstart='], {
    stdio: 'pipe',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout?.toString().trim() || null;
}

/** A fresh complete listing. Null means unavailable, never proof of absence. */
export function readWindowsProcessStartMarkers(): ReadonlyMap<number, string | null> | null {
  if (!isWindows()) return null;
  try {
    const command = [
      "$ErrorActionPreference='Stop'",
      'trap { exit 1 }',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,'
        + `@{N='CreationDate';E={if ($_.CreationDate) { ${WINDOWS_CIM_CREATION_DATE_MARKER_EXPR} } else { $null }}}`
        + ' | ConvertTo-Json -Compress',
    ].join('\n');
    const result = spawn.sync(windowsSystemTool('powershell'), ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: SPAWN_SYNC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024
    });
    if (result.error || result.status !== 0) return null;
    const parsed: unknown = JSON.parse(result.stdout?.toString() ?? '');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const markers = new Map<number, string | null>();
    for (const value of rows) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const row = value as Record<string, unknown>;
      if (typeof row.ProcessId !== 'number' || !Number.isInteger(row.ProcessId)
        || row.ProcessId < 0 || markers.has(row.ProcessId)) return null;
      markers.set(row.ProcessId, typeof row.CreationDate === 'string' && row.CreationDate.length > 0
        ? row.CreationDate : null);
    }
    // This caller remains alive for the whole query. Missing it makes the
    // listing unverifiable; do not infer that any other PID has exited.
    return markers.has(process.pid) ? markers : null;
  } catch { return null; }
}

// ponytail: ps -p is cheap and avoids PID-reuse false positives after OS upgrades/reboots
function isRunnerCommand(commandLine: string): boolean {
  return /(?:^|\s)runner(?:\s|$)/.test(commandLine) && /(?:^|\s)start-sync(?:\s|$)/.test(commandLine);
}

function getWindowsProcessCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const powershell = spawn.sync(windowsSystemTool('powershell'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
  ], { stdio: 'pipe', windowsHide: true, timeout: SPAWN_SYNC_TIMEOUT_MS });
  if (!powershell.error && powershell.status === 0) {
    const commandLine = powershell.stdout?.toString() ?? '';
    if (commandLine.trim()) return commandLine;
  }

  const wmic = spawn.sync(windowsSystemTool('wmic'), [
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

function killProcessWindows(pid: number, force: boolean, deadlineMs?: number): boolean {
  if (!isProcessAlive(pid)) {
    return true;
  }
  if (!signalAllowed(deadlineMs)) return false;

  const args = ['/T', '/PID', pid.toString()];
  if (force) {
    args.unshift('/F');
  }
  try {
    const result = spawn.sync(windowsSystemTool('taskkill'), args, {
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
    `$root=[long]${pid}`,
    // One complete enumeration keeps cost independent of tree depth. Build
    // parent links from the same observation, rather than querying each parent.
    '$processes=@(Get-CimInstance Win32_Process)',
    'if($processes.Count -eq 0 -or -not ($processes | Where-Object ProcessId -eq $PID)){ throw "Incomplete process snapshot" }',
    '$children=@{}',
    'foreach($process in $processes){',
    '  $parent=[long]$process.ParentProcessId',
    '  if(-not $children.ContainsKey($parent)){ $children[$parent]=[System.Collections.Generic.List[long]]::new() }',
    '  $children[$parent].Add([long]$process.ProcessId)',
    '}',
    '$seen=@{}',
    '$bfs=@()',
    '$queue=@($root)',
    'while($queue.Count -gt 0){',
    '  $p=$queue[0]; if($queue.Count -eq 1){$queue=@()}else{$queue=$queue[1..($queue.Count-1)]}',
    '  if($seen.ContainsKey($p)){continue}',
    '  $seen[$p]=$true',
    '  $bfs+=$p',
    '  if($children.ContainsKey($p)){ foreach($child in $children[$p]){ $queue+=,$child } }',
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
    windowsSystemTool('powershell'),
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

function signalAllowed(deadlineMs?: number): boolean {
  return deadlineMs === undefined || monotonicTimeMs() < deadlineMs;
}

async function signalAndWaitWindowsRoot(pid: number, force: boolean, deadlineMs?: number): Promise<void> {
  if (!signalAllowed(deadlineMs)) return;
  if (force) {
    killProcessWindows(pid, true, deadlineMs);
    await waitForProcessToDie(pid, true, deadlineMs);
    return;
  }
  const softOk = killProcessWindows(pid, false, deadlineMs);
  if (!softOk && isProcessAlive(pid) && signalAllowed(deadlineMs)) {
    killProcessWindows(pid, true, deadlineMs);
    await waitForProcessToDie(pid, true, deadlineMs);
    return;
  }
  await waitForProcessToDie(pid, false, deadlineMs);
}

export async function killProcess(pid: number, force: boolean = false, deadlineMs?: number): Promise<boolean> {
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
    await signalAndWaitWindowsRoot(n, force, deadlineMs);
    return !isProcessAlive(n);
  }

  try {
    if (!signalAllowed(deadlineMs)) return !isProcessAlive(n);
    process.kill(n, force ? 'SIGKILL' : 'SIGTERM');
    await waitForProcessToDie(n, force, deadlineMs);
    return deadlineMs === undefined || !isProcessAlive(n);
  } catch {
    return false;
  }
}

/** Generation-bound identity for one member of a retained process tree (#2021). */
export type RetainedProcessIdentity = {
  pid: number;
  startMarker: string | null;
  bootId: string | null;
  tgid: number | null;
  /** Process group id at snapshot time — covers forks during teardown (#2021). */
  pgid: number | null;
};

/**
 * Snapshot the live process tree under `rootPid` with generation markers.
 * Returns `null` when the scan is incomplete — callers must keep Stop unresolved (#2021).
 */
export function snapshotProcessTreeIdentities(rootPid: number): RetainedProcessIdentity[] | null {
  const n = typeof rootPid === 'number' ? rootPid : Number(rootPid);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pids = isWindows() ? collectWindowsProcessTree(n) : collectProcessTree(n);
  if (pids === 'scan_failed') return null;
  const bootId = getSystemBootId();
  return pids.map((pid) => ({
    pid,
    startMarker: getProcessStartMarker(pid),
    bootId,
    tgid: getProcessThreadGroupId(pid),
    pgid: getProcessGroupId(pid),
  }));
}

/**
 * Three-way generation probe for a retained PID (#2021 tip Major):
 * - `match` — confirmed same generation (safe to signal)
 * - `gone` — confirmed absent or replaced
 * - `unknown` — probe failed / insufficient markers — do not signal, keep Stop unresolved
 *
 * Boot ID + TGID alone cannot distinguish PID reuse within one boot, so a live
 * PID without a matching start-marker is `unknown`, never a confirmed match.
 */
export type RetainedIdentityStatus = 'match' | 'gone' | 'unknown';

export function classifyRetainedIdentity(identity: RetainedProcessIdentity): RetainedIdentityStatus {
  if (!isProcessAlive(identity.pid)) return 'gone';
  if (identity.startMarker) {
    const marker = getProcessStartMarker(identity.pid);
    if (marker === null) return 'unknown';
    return marker === identity.startMarker ? 'match' : 'gone';
  }
  // Alive without a start-marker: cannot confirm generation (boot+tgid is not enough).
  return 'unknown';
}

/** True when settlement must treat this identity as still blocking (match or unknown). */
export function retainedIdentityStillAlive(identity: RetainedProcessIdentity): boolean {
  return classifyRetainedIdentity(identity) !== 'gone';
}

/**
 * Signal one retained identity with a generation recheck before every signal,
 * including SIGKILL escalation. Never escalate on a replaced/unknown PID (#2021).
 */
async function killMatchingRetainedIdentity(
  identity: RetainedProcessIdentity,
  force = false,
): Promise<void> {
  const signalIfMatch = (forceKill: boolean): boolean => {
    if (classifyRetainedIdentity(identity) !== 'match') return false;
    try {
      if (isWindows()) {
        killProcessWindows(identity.pid, forceKill);
      } else {
        process.kill(identity.pid, forceKill ? 'SIGKILL' : 'SIGTERM');
      }
      return true;
    } catch {
      return false;
    }
  };

  const waitWhileMatch = async (ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && classifyRetainedIdentity(identity) === 'match') {
      await new Promise((resolve) => setTimeout(resolve, isWindows() ? 100 : 20));
    }
  };

  if (!signalIfMatch(force)) return;
  await waitWhileMatch(2000);
  if (!force && classifyRetainedIdentity(identity) === 'match') {
    // Recheck immediately before escalation — PID may have been reused (#2021).
    if (!signalIfMatch(true)) return;
    await waitWhileMatch(1000);
  }
}

/**
 * Kill retained tree members whose generation still matches, then verify none remain.
 * Signals only confirmed matches; unknown identities keep Stop unresolved (#2021).
 */
export async function killRetainedProcessTree(
  identities: RetainedProcessIdentity[],
  force = false,
): Promise<boolean> {
  if (identities.length === 0) return true;
  // Phase 1: signal every confirmed match immediately — do not wait between
  // members. Waiting on one child while a parent is still alive lets that
  // parent spawn a replacement subprocess that is not in the snapshot (#2021).
  for (const identity of identities) {
    if (classifyRetainedIdentity(identity) !== 'match') continue;
    try {
      if (isWindows()) {
        killProcessWindows(identity.pid, force);
      } else {
        process.kill(identity.pid, force ? 'SIGKILL' : 'SIGTERM');
      }
    } catch {
      // continue
    }
  }
  // Phase 2: wait / escalate each captured identity with generation rechecks.
  for (const identity of identities) {
    if (classifyRetainedIdentity(identity) !== 'match') continue;
    try {
      await killMatchingRetainedIdentity(identity, force);
    } catch {
      // continue verifying others
    }
  }
  // Any unknown identity blocks verification — never claim the tree is gone
  // when a probe failed or generation cannot be confirmed.
  if (identities.some((identity) => classifyRetainedIdentity(identity) === 'unknown')) {
    return false;
  }
  if (!identities.every((identity) => classifyRetainedIdentity(identity) === 'gone')) {
    return false;
  }
  // Cover mid-Stop forks via the original process group (#2021 tip Major).
  // Windows taskkill /T already covered the console tree in phase 1/2.
  if (!isWindows()) {
    const root = identities[identities.length - 1]!;
    const pgid = root.pgid;
    if (typeof pgid !== 'number' || pgid <= 0) {
      // No group coverage — keep unresolved rather than trusting PID-only kills.
      return false;
    }
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // group already gone
    }
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const remaining = listProcessGroupPids(pgid);
      if (remaining === 'scan_failed') return false;
      if (remaining.length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const remaining = listProcessGroupPids(pgid);
    return remaining !== 'scan_failed' && remaining.length === 0;
  }
  return true;
}

/** PIDs currently in process group `pgid`, or scan_failed when pgrep is unusable. */
function listProcessGroupPids(pgid: number): number[] | 'scan_failed' {
  const result = spawn.sync('pgrep', ['-g', String(pgid)], {
    encoding: 'utf8',
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  });
  if (result.error) return 'scan_failed';
  if (result.status !== 0 && result.status !== 1) return 'scan_failed';
  if (!result.stdout || result.status === 1) return [];
  return result.stdout.trim().split('\n').filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0);
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
async function killProcessTree(pid: number, force: boolean, deadlineMs?: number,
  signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
  // Collect all PIDs first (sync) - returns in child-first order
  const pids = collectProcessTree(pid);
  if (pids === 'scan_failed') {
    // Signal the known root anyway (partial kill > zero kill), but never claim
    // stopped without a full-tree verify (#1911 Opus Major / debian-slim no pgrep).
    const killSignal = force ? 'SIGKILL' : signal;
    try {
      if (!signalAllowed(deadlineMs)) return false;
      process.kill(pid, killSignal);
    } catch {
      // already gone
    }
    await waitForProcessToDie(pid, force, deadlineMs);
    return false;
  }

  // Signal all processes synchronously (children first, then root).
  // Preserve the caller's signal when soft-killing so Ctrl-C stays SIGINT
  // (exit 130) instead of always remapping to SIGTERM (exit 143).
  const killSignal = force ? 'SIGKILL' : signal;
  for (const p of pids) {
    try {
      if (!signalAllowed(deadlineMs)) return false;
      process.kill(p, killSignal);
    } catch {
      // Process may have already exited
    }
  }

  // Wait for processes to die (async) - wait for root last
  for (const p of pids) {
    await waitForProcessToDie(p, force, deadlineMs);
  }

  return pids.every((candidate) => !isProcessAlive(candidate));
}

/** Kill a PID and all descendants, verifying the complete tree is gone. */
export async function killProcessTreeByPid(
  pid: number,
  force: boolean = false,
  // 3rd arg: soft POSIX signal (#1424 job Ctrl-C → exit 130) OR Windows stop report (#1911).
  signalOrReport: NodeJS.Signals | ((report: WindowsStopReport) => void) = 'SIGTERM',
  // 4th arg: stop deadline (signal-lease budget) when numeric, else the Windows
  // report fallback used when the 3rd arg is a signal (#1911).
  deadlineOrFallbackReport?: number | ((report: WindowsStopReport) => void),
  fallbackReport?: (report: WindowsStopReport) => void
): Promise<boolean> {
  const deadlineMs = typeof deadlineOrFallbackReport === 'number' ? deadlineOrFallbackReport : undefined;
  const onReport = typeof signalOrReport === 'function' ? signalOrReport
    : typeof deadlineOrFallbackReport === 'function' ? deadlineOrFallbackReport
    : fallbackReport;
  const signal: NodeJS.Signals = typeof signalOrReport === 'function' ? 'SIGTERM' : signalOrReport;
  const n = typeof pid === 'number' ? pid : Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false;
  if (isWindows()) {
    return stopWindowsProcessTree(n, force, onReport, deadlineMs);
  }
  return killProcessTree(n, force, deadlineMs, signal);
}

/**
 * Waits for a process to die, escalating if the graceful signal didn't work.
 * POSIX: SIGTERM → SIGKILL. Windows: taskkill /T → taskkill /F /T.
 */
async function waitForProcessToDie(pid: number, force: boolean, deadlineMs?: number): Promise<void> {
  const maxWait = 2000;
  // Windows isProcessAlive shells out to tasklist; keep the poll coarse so a
  // stop cannot burn the runner event loop for seconds (#1911 Overseer).
  const pollInterval = isWindows() ? 100 : 20;
  let deadline = Date.now() + maxWait;

  // OS probes are synchronous on Windows. Count their time against the
  // grace period too, otherwise twenty slow tasklist calls can turn two
  // seconds of graceful shutdown into a much longer archive request.
  while (Date.now() < deadline && isProcessAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(pollInterval, remaining)));
  }

  // Graceful kill didn't finish — escalate (same structure on both platforms).
  if (!force && isProcessAlive(pid) && signalAllowed(deadlineMs)) {
    try {
      if (isWindows()) {
        killProcessWindows(pid, true, deadlineMs);
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      return;
    }
    deadline = Date.now() + 1000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(pollInterval, remaining)));
    }
  }
}

export async function killProcessByChildProcess(
  child: ChildProcess,
  force: boolean = false,
  signalOrReport: NodeJS.Signals | ((report: WindowsStopReport) => void) = 'SIGTERM',
  deadlineOrFallbackReport?: number | ((report: WindowsStopReport) => void),
  fallbackReport?: (report: WindowsStopReport) => void
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) {
    return false;
  }

  // Both platforms: tree-kill + full-tree verify (win32 must not trust
  // root-only). The soft signal rides along on POSIX so job Ctrl-C stays
  // exit 130 (#1424).
  return killProcessTreeByPid(pid, force, signalOrReport, deadlineOrFallbackReport, fallbackReport);
}
