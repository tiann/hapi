import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';

export const isWindows = (): boolean => process.platform === 'win32';

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      windowsHide: true
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

export async function killProcess(pid: number, force: boolean = false): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  if (isWindows()) {
    return killProcessWindows(pid, force);
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

  return true;
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

export async function killProcessByChildProcess(
  child: ChildProcess,
  force: boolean = false
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) {
    return false;
  }

  if (isWindows()) {
    // Windows taskkill /T already kills the entire process tree
    return killProcess(pid, force);
  }

  // Kill entire process tree on Unix to prevent orphan processes
  return killProcessTree(pid, force);
}
