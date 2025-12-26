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
  const args = ['/T', '/PID', pid.toString()];
  if (force) {
    args.unshift('/F');
  }
  try {
    const result = spawn.sync('taskkill', args, { stdio: 'pipe' });
    if (result.error) {
      return false;
    }
    return result.status === 0;
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
    return true;
  } catch {
    return false;
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
    return killProcess(pid, force);
  }

  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
