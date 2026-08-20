import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import spawn from 'cross-spawn';

const WINDOWS_COMMAND_TIMEOUT_MS = 3_000;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 10_000;
const POSIX_PROCESS_GROUP_KILL_TIMEOUT_MS = 3_000;
const PROCESS_POLL_INTERVAL_MS = 20;
const WINDOWS_START_MARKER_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;

export const STRICT_PROCESS_OWNERSHIP_ENV = 'HAPI_STRICT_PROCESS_OWNERSHIP_TOKEN';

export const isWindows = (): boolean => process.platform === 'win32';

type ProcessLiveness = 'alive' | 'exited' | 'unknown';

function probeProcessLiveness(pid: number): ProcessLiveness {
  if (!Number.isFinite(pid) || pid <= 0) {
    return 'exited';
  }

  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error && typeof error === 'object'
      && (error as NodeJS.ErrnoException).code === 'ESRCH') {
      return 'exited';
    }
    return 'unknown';
  }
}

export function isProcessAlive(pid: number): boolean {
  return probeProcessLiveness(pid) === 'alive';
}

/** Stable marker for one OS PID generation; null means the platform probe failed. */
export function getProcessStartMarker(pid: number, deadline?: number): string | null {
  if (!isProcessAlive(pid)) return null;
  if (isWindows()) {
    const marker = readWindowsProcessStartMarker(pid, deadline);
    if (marker) return marker;
    const timeout = getWindowsCommandTimeout(deadline);
    if (timeout === null) return null;
    const result = spawn.sync('wmic', [
      'process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'
    ], { stdio: 'pipe', windowsHide: true, timeout });
    if (result.error || result.status !== 0) return null;
    const match = (result.stdout?.toString() ?? '').match(/CreationDate=([^\r\n]+)/);
    return normalizeWindowsWmicStartMarker(match?.[1]?.trim() ?? '');
  }
  if (process.platform === 'linux') {
    if (deadline !== undefined && Date.now() >= deadline) return null;
    const record = readLinuxProcessRecord(pid);
    if (deadline !== undefined && Date.now() >= deadline) return null;
    return record.kind === 'ok' ? record.value.startMarker : null;
  }
  const timeout = deadline === undefined ? undefined : getPosixCommandTimeout(deadline);
  if (timeout === null) return null;
  const result = spawn.sync('ps', ['-p', String(pid), '-o', 'lstart='], {
    stdio: 'pipe',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    ...(timeout === undefined ? {} : { timeout })
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout?.toString().trim() || null;
}

function normalizeWindowsWmicStartMarker(marker: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(marker);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, sign, offset] = match;
  const localTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  if (!Number.isFinite(localTime)) return null;
  const offsetMs = Number(offset) * 60_000 * (sign === '+' ? 1 : -1);
  const utc = new Date(localTime - offsetMs);
  const normalized = `${utc.toISOString().slice(0, 19)}.${fraction}0Z`;
  return isCanonicalWindowsStartMarker(normalized) ? normalized : null;
}

function isCanonicalWindowsStartMarker(marker: string): boolean {
  return WINDOWS_START_MARKER_PATTERN.test(marker)
    && Number.isFinite(Date.parse(marker));
}

function getWindowsCommandTimeout(deadline?: number): number | null {
  if (deadline === undefined) return WINDOWS_COMMAND_TIMEOUT_MS;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  return Math.max(1, Math.min(WINDOWS_COMMAND_TIMEOUT_MS, Math.ceil(remaining)));
}

function getPosixCommandTimeout(deadline: number): number | null {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  return Math.max(1, Math.min(
    POSIX_PROCESS_GROUP_KILL_TIMEOUT_MS,
    Math.ceil(remaining)
  ));
}

function readWindowsProcessStartMarker(pid: number, deadline?: number): string | null {
  const timeout = getWindowsCommandTimeout(deadline);
  if (timeout === null) return null;
  try {
    const powershell = spawn.sync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; `
        + `if ($null -ne $process -and $null -ne $process.CreationDate) { `
        + `$process.CreationDate.ToUniversalTime()`
        + `.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ') }`
    ], { stdio: 'pipe', windowsHide: true, timeout });
    if (powershell.error || powershell.status !== 0) return null;
    const marker = powershell.stdout?.toString().trim() ?? '';
    return isCanonicalWindowsStartMarker(marker) ? marker : null;
  } catch {
    return null;
  }
}

type WindowsProcessRecord = {
  pid: number;
  parentPid: number;
  startMarker: string | null;
};

function parseWindowsProcessRecord(
  pidText: string,
  parentPidText: string,
  startMarker: string
): WindowsProcessRecord | null {
  if (!pidText.trim() || !parentPidText.trim()) return null;
  const pid = Number(pidText);
  const parentPid = Number(parentPidText);
  if (!Number.isInteger(pid) || pid < 0
    || !Number.isInteger(parentPid) || parentPid < 0) {
    return null;
  }
  const marker = startMarker && isCanonicalWindowsStartMarker(startMarker)
    ? startMarker
    : null;
  return { pid, parentPid, startMarker: marker };
}

function parsePowerShellProcessTable(output: string): WindowsProcessRecord[] | null {
  const records: WindowsProcessRecord[] = [];
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of lines) {
    const fields = line.split('|');
    if (fields.length !== 3) return null;
    const record = parseWindowsProcessRecord(fields[0], fields[1], fields[2]);
    if (!record) return null;
    records.push(record);
  }
  return records;
}

function parseWmicProcessTable(output: string): WindowsProcessRecord[] | null {
  const records: WindowsProcessRecord[] = [];
  let fields: Partial<Record<'CreationDate' | 'ParentProcessId' | 'ProcessId', string>> = {};
  const finishRecord = (): boolean => {
    if (Object.keys(fields).length === 0) return true;
    const marker = normalizeWindowsWmicStartMarker(fields.CreationDate ?? '');
    const record = parseWindowsProcessRecord(
      fields.ProcessId ?? '',
      fields.ParentProcessId ?? '',
      marker ?? ''
    );
    fields = {};
    if (!record) return false;
    records.push(record);
    return true;
  };

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!finishRecord()) return null;
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) return null;
    const key = trimmed.slice(0, separator);
    if (key !== 'CreationDate' && key !== 'ParentProcessId' && key !== 'ProcessId') return null;
    fields[key] = trimmed.slice(separator + 1).trim();
  }
  if (!finishRecord() || records.length === 0) return null;
  return records;
}

function readWindowsProcessTable(deadline: number): WindowsProcessRecord[] | null {
  let timeout = getWindowsCommandTimeout(deadline);
  if (timeout === null) return null;
  try {
    const powershell = spawn.sync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | ForEach-Object { `
        + `$creation = if ($null -eq $_.CreationDate) { '' } else { `
        + `$_.CreationDate.ToUniversalTime()`
        + `.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ') }; `
        + `'{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $creation }`
    ], { stdio: 'pipe', windowsHide: true, timeout });
    if (!powershell.error && powershell.status === 0) {
      const records = parsePowerShellProcessTable(powershell.stdout?.toString() ?? '');
      if (records) return records;
    }
  } catch {
    // Fall through to WMIC on Windows installations without usable PowerShell CIM.
  }

  timeout = getWindowsCommandTimeout(deadline);
  if (timeout === null) return null;
  try {
    const wmic = spawn.sync('wmic', [
      'process', 'get', 'ProcessId,ParentProcessId,CreationDate', '/format:list'
    ], { stdio: 'pipe', windowsHide: true, timeout });
    if (wmic.error || wmic.status !== 0) return null;
    return parseWmicProcessTable(wmic.stdout?.toString() ?? '');
  } catch {
    return null;
  }
}

function captureWindowsProcessTree(
  rootPid: number,
  rootStartMarker: string,
  deadline: number
): WindowsProcessRecord[] | null {
  const records = readWindowsProcessTable(deadline);
  if (!records) return null;

  const byPid = new Map<number, WindowsProcessRecord>();
  for (const record of records) {
    if (byPid.has(record.pid)) return null;
    byPid.set(record.pid, record);
  }
  const root = byPid.get(rootPid);
  if (!root || root.startMarker !== rootStartMarker) return null;

  const tree: WindowsProcessRecord[] = [root];
  const included = new Set([rootPid]);
  for (let index = 0; index < tree.length; index += 1) {
    const parent = tree[index];
    const parentStartMarker = parent.startMarker;
    if (!parentStartMarker) return null;
    for (const candidate of records) {
      if (candidate.parentPid !== parent.pid || included.has(candidate.pid)) continue;
      if (!candidate.startMarker) return null;
      if (candidate.startMarker < parentStartMarker) return null;
      included.add(candidate.pid);
      tree.push(candidate);
    }
  }
  return tree;
}

// ponytail: ps -p is cheap and avoids PID-reuse false positives after OS upgrades/reboots
function isRunnerCommand(commandLine: string): boolean {
  return /(?:^|\s)runner(?:\s|$)/.test(commandLine) && /(?:^|\s)start-sync(?:\s|$)/.test(commandLine);
}

export function isHapiRunnerProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }
  if (isWindows()) {
    const result = spawn.sync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'], { stdio: 'pipe' });
    if (result.error) {
      return true;
    }
    if (result.status !== 0) {
      return isProcessAlive(pid);
    }
    return isRunnerCommand(result.stdout?.toString() ?? '');
  }
  const result = spawn.sync('ps', ['-p', String(pid), '-o', 'command='], { stdio: 'pipe' });
  if (result.error || result.status !== 0) {
    return isProcessAlive(pid);
  }
  return isRunnerCommand(result.stdout?.toString() ?? '');
}

function killProcessWindows(
  pid: number,
  force: boolean,
  tree: boolean = true,
  deadline?: number,
  allowMissingAfterFailure: boolean = true
): boolean {
  if (!isProcessAlive(pid)) {
    return allowMissingAfterFailure;
  }

  const timeout = deadline === undefined ? undefined : getWindowsCommandTimeout(deadline);
  if (timeout === null) return false;
  const args = tree ? ['/T', '/PID', pid.toString()] : ['/PID', pid.toString()];
  if (force) {
    args.unshift('/F');
  }
  try {
    const result = spawn.sync('taskkill', args, {
      stdio: 'pipe',
      windowsHide: true,
      ...(timeout === undefined ? {} : { timeout })
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
    return allowMissingAfterFailure && !isProcessAlive(pid);
  } catch {
    return false;
  }
}

type ProcessIdentity = 'same' | 'exited' | 'unknown';

function getProcessIdentity(
  pid: number,
  startMarker: string | null,
  deadline: number
): ProcessIdentity {
  const liveness = probeProcessLiveness(pid);
  if (liveness === 'exited') return 'exited';
  if (liveness === 'unknown') return 'unknown';
  if (startMarker === null) return 'unknown';
  const currentMarker = getProcessStartMarker(pid, deadline);
  if (!currentMarker) return 'unknown';
  return currentMarker === startMarker ? 'same' : 'exited';
}

async function waitForWindowsProcessTreeExit(
  tree: WindowsProcessRecord[],
  maxWait: number,
  deadline: number
): Promise<boolean> {
  const waitDeadline = Math.min(Date.now() + maxWait, deadline);
  const knownGenerations = new Map(tree.map((record) => [
    `${record.pid}:${record.startMarker}`,
    record
  ]));
  let emptyScans = 0;
  while (Date.now() <= waitDeadline) {
    const currentTable = readWindowsProcessTable(deadline);
    if (!currentTable) return false;
    const currentByPid = new Map<number, WindowsProcessRecord>();
    for (const record of currentTable) {
      if (currentByPid.has(record.pid)) return false;
      currentByPid.set(record.pid, record);
    }

    let discovered = true;
    let discoveredThisScan = false;
    while (discovered) {
      discovered = false;
      for (const candidate of currentTable) {
        if (candidate.startMarker
          && knownGenerations.has(`${candidate.pid}:${candidate.startMarker}`)) {
          continue;
        }
        const parent = [...knownGenerations.values()].find((record) => (
          record.pid === candidate.parentPid
        ));
        if (!parent) continue;
        if (!parent.startMarker
          || !candidate.startMarker
          || candidate.startMarker < parent.startMarker) {
          return false;
        }
        knownGenerations.set(`${candidate.pid}:${candidate.startMarker}`, candidate);
        tree.push(candidate);
        discovered = true;
        discoveredThisScan = true;
      }
    }

    let allExited = true;
    for (const processRecord of tree) {
      const identity = getProcessIdentity(
        processRecord.pid,
        processRecord.startMarker,
        deadline
      );
      if (identity === 'unknown') return false;
      if (identity === 'same') allExited = false;
    }
    if (allExited) {
      if (discoveredThisScan) {
        emptyScans = 0;
        await Promise.resolve();
        continue;
      }
      emptyScans += 1;
      if (emptyScans >= 2) return true;
      await Promise.resolve();
      continue;
    }
    emptyScans = 0;
    if (Date.now() >= waitDeadline) return false;
    const delay = Math.min(PROCESS_POLL_INTERVAL_MS, waitDeadline - Date.now());
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return false;
}

async function killWindowsProcessGeneration(
  pid: number,
  force: boolean,
  expectedStartMarker: string | null,
  deadline: number
): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (expectedStartMarker === null || Date.now() >= deadline) return false;
  const processTree = captureWindowsProcessTree(pid, expectedStartMarker, deadline);
  if (!processTree) return false;
  for (const processRecord of processTree) {
    const identity = getProcessIdentity(
      processRecord.pid,
      processRecord.startMarker,
      deadline
    );
    if (identity === 'unknown' || (processRecord.pid === pid && identity !== 'same')) {
      return false;
    }
  }

  const requested = killProcessWindows(pid, force, true, deadline, false);
  if (!requested) return false;
  if (await waitForWindowsProcessTreeExit(
    processTree,
    force ? 1_000 : 2_000,
    deadline
  )) return true;

  const identity = getProcessIdentity(pid, expectedStartMarker, deadline);
  if (force || identity !== 'same') return false;

  const forced = killProcessWindows(pid, true, true, deadline, false);
  if (!forced) return false;
  return waitForWindowsProcessTreeExit(processTree, 1_000, deadline);
}

export async function killProcess(
  pid: number,
  force: boolean = false,
  expectedStartMarker?: string | null,
  deadline?: number
): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  if (isWindows()) {
    if (expectedStartMarker === undefined) {
      return killProcessWindows(pid, force, true, deadline);
    }
    const teardownDeadline = Math.min(
      deadline ?? Number.POSITIVE_INFINITY,
      Date.now() + WINDOWS_TREE_KILL_TIMEOUT_MS
    );
    return killWindowsProcessGeneration(
      pid,
      force,
      expectedStartMarker,
      teardownDeadline
    );
  }

  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    await waitForProcessToDie(pid, force);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively collects all descendant PIDs of a process (depth-first).
 * Returns PIDs in child-first order (leaves first, root last).
 */
function collectProcessTree(pid: number): number[] {
  const pids: number[] = [];

  try {
    const result = spawn.sync('pgrep', ['-P', pid.toString()], { encoding: 'utf8' });
    if (result.stdout) {
      const childPids = result.stdout.trim().split('\n').filter(Boolean).map(Number);
      for (const childPid of childPids) {
        pids.push(...collectProcessTree(childPid));
      }
    }
  } catch {
    // pgrep may not be available
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
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (isWindows()) return killProcess(pid, force);
  return killProcessTree(pid, force);
}

/**
 * Waits for a process to die, escalating to SIGKILL if SIGTERM doesn't work.
 */
async function waitForProcessToDie(pid: number, force: boolean): Promise<void> {
  const maxWait = 2000;
  const pollInterval = 20;
  let waited = 0;

  while (isProcessAlive(pid) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  // If SIGTERM didn't work and we haven't tried SIGKILL yet, escalate
  if (!force && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
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

type PosixMarkerSource = 'linux-proc' | 'ps';

type PosixOwnedProcessRecord = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  startMarker: string;
  markerSource: PosixMarkerSource;
};

type StrictPosixOwnershipState = {
  ownershipToken: string;
  rootStartMarker: string;
  knownGenerations: Map<string, PosixOwnedProcessRecord>;
};

const strictPosixOwnershipByChild = new WeakMap<ChildProcess, StrictPosixOwnershipState>();

function linuxStartTime(startMarker: string): bigint | null {
  const match = /^linux:(\d+)$/.exec(startMarker);
  if (!match) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

type ProcessReadResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'exited' }
  | { kind: 'unknown' };

type OwnedProcessScanResult = PosixOwnedProcessRecord[] | 'retryable' | null;

function isMissingProcessError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ESRCH';
}

function isUnreadableProcessEnvironment(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}

function readLinuxProcessRecord(pid: number): ProcessReadResult<PosixOwnedProcessRecord> {
  let output: string;
  try {
    output = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return isMissingProcessError(error) ? { kind: 'exited' } : { kind: 'unknown' };
  }

  const commandEnd = output.lastIndexOf(')');
  const commandStart = output.indexOf('(');
  if (commandStart <= 0 || commandEnd <= commandStart) return { kind: 'unknown' };
  const parsedPid = Number(output.slice(0, commandStart).trim());
  const fields = output.slice(commandEnd + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  if (parsedPid !== pid
    || !Number.isInteger(parentPid) || parentPid < 0
    || !Number.isInteger(processGroupId) || processGroupId < 0
    || !startTime || !/^\d+$/.test(startTime)) {
    return { kind: 'unknown' };
  }
  return {
    kind: 'ok',
    value: {
      pid,
      parentPid,
      processGroupId,
      startMarker: `linux:${startTime}`,
      markerSource: 'linux-proc'
    }
  };
}

function readProcessUid(pid: number): ProcessReadResult<number> {
  try {
    return { kind: 'ok', value: statSync(`/proc/${pid}`).uid };
  } catch (error) {
    return isMissingProcessError(error) ? { kind: 'exited' } : { kind: 'unknown' };
  }
}

function hasOwnershipToken(environment: Buffer, ownershipToken: string): boolean {
  const expected = `${STRICT_PROCESS_OWNERSHIP_ENV}=${ownershipToken}`;
  return environment.toString().split('\0').includes(expected);
}

function listLinuxOwnedProcessGenerations(
  ownershipToken: string,
  deadline: number,
  rootPid: number,
  rootStartMarker: string,
  knownOwned: Map<string, PosixOwnedProcessRecord>,
  confirmedExited: Set<string>
): OwnedProcessScanResult {
  if (typeof process.getuid !== 'function') return null;
  const rootStartTime = linuxStartTime(rootStartMarker);
  if (rootStartTime === null) return null;
  const uid = process.getuid();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }

  const records: PosixOwnedProcessRecord[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (Date.now() >= deadline) return null;
    const pid = Number(entry);
    const uidBefore = readProcessUid(pid);
    if (uidBefore.kind === 'exited') continue;
    if (uidBefore.kind === 'unknown') return null;
    if (uidBefore.value !== uid) continue;

    const recordBefore = readLinuxProcessRecord(pid);
    if (recordBefore.kind === 'exited') continue;
    if (recordBefore.kind === 'unknown') return null;

    let environment: Buffer;
    try {
      environment = readFileSync(`/proc/${pid}/environ`);
    } catch (error) {
      if (isMissingProcessError(error)) continue;
      if (isUnreadableProcessEnvironment(error)) {
        const key = processGenerationKey(recordBefore.value);
        const candidateStartTime = linuxStartTime(recordBefore.value.startMarker);
        if (candidateStartTime === null) return null;
        if ((pid === rootPid
          || knownOwned.has(key)
          || candidateStartTime >= rootStartTime)
          && !confirmedExited.has(key)) {
          return 'retryable';
        }
        const recordAfter = readLinuxProcessRecord(pid);
        const uidAfter = readProcessUid(pid);
        if (recordAfter.kind === 'exited' || uidAfter.kind === 'exited') continue;
        if (recordAfter.kind === 'unknown'
          || uidAfter.kind === 'unknown'
          || uidAfter.value !== uid
          || recordAfter.value.startMarker !== recordBefore.value.startMarker) {
          return null;
        }
        continue;
      }
      return null;
    }
    if (!hasOwnershipToken(environment, ownershipToken)) continue;

    const recordAfter = readLinuxProcessRecord(pid);
    const uidAfter = readProcessUid(pid);
    if (recordAfter.kind === 'exited' || uidAfter.kind === 'exited') {
      records.push(recordBefore.value);
      continue;
    }
    if (recordAfter.kind === 'unknown' || uidAfter.kind === 'unknown') return null;
    if (uidAfter.value !== uid
      || recordAfter.value.startMarker !== recordBefore.value.startMarker) {
      continue;
    }
    records.push(recordAfter.value);
  }
  return Date.now() >= deadline ? null : records;
}

type PsProcessRecord = PosixOwnedProcessRecord & {
  uid: number;
  command: string;
};

function readPsProcessTable(
  includeEnvironment: boolean,
  deadline: number
): PsProcessRecord[] | null {
  const timeout = getPosixCommandTimeout(deadline);
  if (timeout === null) return null;
  const result = spawn.sync('ps', [
    includeEnvironment ? 'axeww' : 'axww',
    '-o',
    'pid=,uid=,ppid=,pgid=,lstart=,command='
  ], {
    stdio: 'pipe',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    timeout
  });
  if (result.error || result.status !== 0 || Date.now() >= deadline) return null;

  const records: PsProcessRecord[] = [];
  const lines = (result.stdout?.toString() ?? '').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) return null;
    const [, pidText, uidText, parentPidText, processGroupIdText, marker, command] = match;
    const pid = Number(pidText);
    const uid = Number(uidText);
    const parentPid = Number(parentPidText);
    const processGroupId = Number(processGroupIdText);
    if (!Number.isInteger(pid) || pid <= 0
      || !Number.isInteger(uid) || uid < 0
      || !Number.isInteger(parentPid) || parentPid < 0
      || !Number.isInteger(processGroupId) || processGroupId < 0) {
      return null;
    }
    records.push({
      pid,
      uid,
      parentPid,
      processGroupId,
      startMarker: marker,
      markerSource: 'ps',
      command
    });
  }
  return records;
}

function listPsOwnedProcessGenerations(
  ownershipToken: string,
  deadline: number
): PosixOwnedProcessRecord[] | null {
  if (typeof process.getuid !== 'function') return null;
  const enrichedRecords = readPsProcessTable(true, deadline);
  if (enrichedRecords === null) return null;
  const plainRecords = readPsProcessTable(false, deadline);
  if (plainRecords === null) return null;

  const plainByPid = new Map<number, PsProcessRecord>();
  for (const record of plainRecords) {
    if (plainByPid.has(record.pid)) return null;
    plainByPid.set(record.pid, record);
  }

  const uid = process.getuid();
  const expectedToken = `${STRICT_PROCESS_OWNERSHIP_ENV}=${ownershipToken}`;
  const owned: PosixOwnedProcessRecord[] = [];
  for (const enriched of enrichedRecords) {
    if (enriched.pid <= 0) return null;
    const plain = plainByPid.get(enriched.pid);
    if (!plain
      || plain.startMarker !== enriched.startMarker
      || plain.parentPid !== enriched.parentPid
      || plain.processGroupId !== enriched.processGroupId) {
      continue;
    }
    if (plain.uid !== uid || enriched.uid !== uid) continue;
    const prefix = `${plain.command} `;
    if (!enriched.command.startsWith(prefix)) continue;
    const environment = enriched.command.slice(prefix.length);
    if (!environment.split(/\s+/).includes(expectedToken)) continue;
    owned.push({
      pid: enriched.pid,
      parentPid: enriched.parentPid,
      processGroupId: enriched.processGroupId,
      startMarker: enriched.startMarker,
      markerSource: 'ps'
    });
  }
  return owned;
}

function listOwnedProcessGenerations(
  ownershipToken: string,
  deadline: number,
  rootPid: number,
  rootStartMarker: string,
  knownOwned: Map<string, PosixOwnedProcessRecord>,
  confirmedExited: Set<string>
): OwnedProcessScanResult {
  if (!ownershipToken) return null;
  return process.platform === 'linux'
    ? listLinuxOwnedProcessGenerations(
      ownershipToken,
      deadline,
      rootPid,
      rootStartMarker,
      knownOwned,
      confirmedExited
    )
    : listPsOwnedProcessGenerations(ownershipToken, deadline);
}

function getPosixOwnedProcessIdentity(
  record: PosixOwnedProcessRecord,
  deadline: number
): ProcessIdentity {
  if (Date.now() >= deadline) return 'unknown';
  const liveness = probeProcessLiveness(record.pid);
  if (liveness !== 'alive') return liveness === 'exited' ? 'exited' : 'unknown';

  if (record.markerSource === 'linux-proc') {
    const current = readLinuxProcessRecord(record.pid);
    if (current.kind !== 'ok') {
      return current.kind === 'exited' ? 'exited' : 'unknown';
    }
    return current.value.startMarker === record.startMarker ? 'same' : 'exited';
  }

  const currentMarker = getProcessStartMarker(record.pid, deadline);
  if (currentMarker !== null) {
    return currentMarker === record.startMarker ? 'same' : 'exited';
  }
  return probeProcessLiveness(record.pid) === 'exited' ? 'exited' : 'unknown';
}

function revalidateOwnedProcessGeneration(
  record: PosixOwnedProcessRecord,
  ownershipToken: string,
  deadline: number
): ProcessReadResult<PosixOwnedProcessRecord> {
  if (Date.now() >= deadline) return { kind: 'unknown' };
  if (record.markerSource === 'linux-proc') {
    const current = readLinuxProcessRecord(record.pid);
    if (Date.now() >= deadline) return { kind: 'unknown' };
    if (current.kind !== 'ok') return current;
    return current.value.startMarker === record.startMarker
      ? current
      : { kind: 'exited' };
  }

  const currentRecords = listPsOwnedProcessGenerations(ownershipToken, deadline);
  if (currentRecords === null) return { kind: 'unknown' };
  const current = currentRecords.find((candidate) => (
    processGenerationKey(candidate) === processGenerationKey(record)
  ));
  if (current) return { kind: 'ok', value: current };
  const identity = getPosixOwnedProcessIdentity(record, deadline);
  return identity === 'exited' ? { kind: 'exited' } : { kind: 'unknown' };
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    return isMissingProcessError(error);
  }
}

function processGenerationKey(record: PosixOwnedProcessRecord): string {
  return `${record.pid}:${record.markerSource}:${record.startMarker}`;
}

async function killProcessGroup(
  processGroupId: number,
  force: boolean,
  deadline: number | undefined,
  ownershipToken: string,
  rootStartMarker: string,
  knownOwned: Map<string, PosixOwnedProcessRecord>
): Promise<boolean> {
  const teardownDeadline = Math.min(
    deadline ?? Number.POSITIVE_INFINITY,
    Date.now() + POSIX_PROCESS_GROUP_KILL_TIMEOUT_MS
  );
  const gracefulDeadline = force
    ? teardownDeadline
    : Math.min(teardownDeadline, Date.now() + 2_000);
  const termSignaled = new Set<string>();
  const killSignaled = new Set<string>();
  const exitedGenerations = new Set<string>();
  let termGroupSignaled = false;
  let killGroupSignaled = false;
  let emptyScans = 0;

  while (Date.now() < teardownDeadline) {
    const records = listOwnedProcessGenerations(
      ownershipToken,
      teardownDeadline,
      processGroupId,
      rootStartMarker,
      knownOwned,
      exitedGenerations
    );
    if (records === null) return false;
    if (records === 'retryable') {
      const delay = Math.min(
        PROCESS_POLL_INTERVAL_MS,
        teardownDeadline - Date.now()
      );
      if (delay <= 0) return false;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    const scannedGenerations = new Set<string>();
    let observedNewGeneration = false;
    for (const record of records) {
      const key = processGenerationKey(record);
      scannedGenerations.add(key);
      if (exitedGenerations.has(key)) continue;
      if (!knownOwned.has(key)) observedNewGeneration = true;
      knownOwned.set(key, record);
    }

    const currentRecords: PosixOwnedProcessRecord[] = [];
    let generationExitedDuringScan = false;
    for (const [key, record] of knownOwned) {
      const identity = getPosixOwnedProcessIdentity(record, teardownDeadline);
      if (identity === 'unknown') return false;
      if (identity === 'same') {
        if (record.markerSource === 'ps' && !scannedGenerations.has(key)) {
          return false;
        }
        currentRecords.push(record);
      } else {
        knownOwned.delete(key);
        if (!exitedGenerations.has(key)) generationExitedDuringScan = true;
        exitedGenerations.add(key);
      }
    }
    if (currentRecords.length === 0) {
      if (observedNewGeneration || generationExitedDuringScan) {
        emptyScans = 0;
        const delay = Math.min(
          PROCESS_POLL_INTERVAL_MS,
          teardownDeadline - Date.now()
        );
        if (delay <= 0) return false;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      emptyScans += 1;
      if (emptyScans >= 2) return true;
      const delay = Math.min(
        PROCESS_POLL_INTERVAL_MS,
        teardownDeadline - Date.now()
      );
      if (delay <= 0) return false;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    emptyScans = 0;

    const useForce = force || Date.now() >= gracefulDeadline;
    const signal: NodeJS.Signals = useForce ? 'SIGKILL' : 'SIGTERM';
    const signaled = useForce ? killSignaled : termSignaled;
    const groupAlreadySignaled = useForce ? killGroupSignaled : termGroupSignaled;
    const groupRecord = currentRecords.find((record) => (
      record.processGroupId === processGroupId
    ));
    if (groupRecord && !groupAlreadySignaled) {
      const identity = getPosixOwnedProcessIdentity(groupRecord, teardownDeadline);
      if (identity === 'unknown') return false;
      if (identity === 'same') {
        const current = revalidateOwnedProcessGeneration(
          groupRecord,
          ownershipToken,
          teardownDeadline
        );
        if (current.kind === 'unknown') return false;
        if (Date.now() >= teardownDeadline) return false;
        if (current.kind === 'ok'
          && current.value.processGroupId === processGroupId
          && !signalProcess(-processGroupId, signal)) {
          return false;
        }
      }
      if (useForce) killGroupSignaled = true;
      else termGroupSignaled = true;
    }

    for (const record of currentRecords) {
      const key = processGenerationKey(record);
      if (signaled.has(key)) continue;
      const identity = getPosixOwnedProcessIdentity(record, teardownDeadline);
      if (identity === 'unknown') return false;
      if (identity === 'same') {
        const current = revalidateOwnedProcessGeneration(
          record,
          ownershipToken,
          teardownDeadline
        );
        if (current.kind === 'unknown') return false;
        if (Date.now() >= teardownDeadline) return false;
        if (current.kind === 'ok' && !signalProcess(current.value.pid, signal)) return false;
      }
      signaled.add(key);
    }

    const phaseDeadline = useForce ? teardownDeadline : gracefulDeadline;
    const delay = Math.min(
      PROCESS_POLL_INTERVAL_MS,
      phaseDeadline - Date.now(),
      teardownDeadline - Date.now()
    );
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return false;
}

function createStrictPosixOwnershipState(
  rootPid: number,
  ownershipToken: string,
  rootStartMarker: string
): StrictPosixOwnershipState | null {
  const markerSource: PosixMarkerSource = process.platform === 'linux'
    ? 'linux-proc'
    : 'ps';
  if (markerSource === 'linux-proc' && linuxStartTime(rootStartMarker) === null) {
    return null;
  }
  const rootRecord: PosixOwnedProcessRecord = {
    pid: rootPid,
    parentPid: 0,
    processGroupId: rootPid,
    startMarker: rootStartMarker,
    markerSource
  };
  return {
    ownershipToken,
    rootStartMarker,
    knownGenerations: new Map([[processGenerationKey(rootRecord), rootRecord]])
  };
}

export async function killProcessByChildProcess(
  child: ChildProcess,
  force: boolean = false,
  expectedStartMarker?: string | null,
  deadline?: number,
  useProcessGroup: boolean = false,
  ownershipToken?: string
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) {
    return false;
  }

  if (isWindows()) {
    return killProcess(pid, force, expectedStartMarker, deadline);
  }

  if (useProcessGroup) {
    if (!ownershipToken || !expectedStartMarker) return false;
    const existingOwnership = strictPosixOwnershipByChild.get(child);
    if (existingOwnership
      && (existingOwnership.ownershipToken !== ownershipToken
        || existingOwnership.rootStartMarker !== expectedStartMarker)) {
      return false;
    }
    const ownership = existingOwnership ?? createStrictPosixOwnershipState(
      pid,
      ownershipToken,
      expectedStartMarker
    );
    if (!ownership) return false;
    if (!existingOwnership) strictPosixOwnershipByChild.set(child, ownership);
    const terminated = await killProcessGroup(
      pid,
      force,
      deadline,
      ownershipToken,
      ownership.rootStartMarker,
      ownership.knownGenerations
    );
    if (terminated) strictPosixOwnershipByChild.delete(child);
    return terminated;
  }

  // Kill entire process tree on Unix to prevent orphan processes
  return killProcessTreeByPid(pid, force);
}
