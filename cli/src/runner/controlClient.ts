/**
 * HTTP client helpers for runner communication
 * Used by CLI commands to interact with running runner
 */

import { logger } from '@/ui/logger';
import { clearRunnerLock, clearRunnerState, readRunnerState, type RunnerLocallyPersistedState } from '@/persistence';
import { Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { isProcessAlive, killProcess } from '@/utils/process';

export function getInstalledCliMtimeMs(): number | undefined {
  if (isBunCompiled()) {
    try {
      return statSync(process.execPath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  const packageJsonPath = join(projectPath(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    return statSync(packageJsonPath).mtimeMs;
  } catch {
    return undefined;
  }
}

async function runnerPost(path: string, body?: any): Promise<{ error?: string } | any> {
  const state = await readRunnerState();
  if (!state?.httpPort) {
    const errorMessage = 'No runner running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  if (!isProcessAlive(state.pid)) {
    const errorMessage = 'Runner is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.ZS_RUNNER_HTTP_TIMEOUT ? parseInt(process.env.ZS_RUNNER_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

export async function notifyRunnerSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<{ error?: string } | any> {
  return await runnerPost('/session-started', {
    sessionId,
    metadata
  });
}

export async function listRunnerSessions(): Promise<any[]> {
  const result = await runnerPost('/list');
  return result.children || [];
}

export async function stopRunnerSession(sessionId: string): Promise<boolean> {
  const result = await runnerPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnRunnerSession(directory: string, sessionId?: string): Promise<any> {
  const result = await runnerPost('/spawn-session', { directory, sessionId });
  return result;
}

export async function stopRunnerHttp(): Promise<void> {
  await runnerPost('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded zs,
 * the runner is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another runner to make sure 
 * our runner is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 */
export type RunnerAvailabilityStatus = 'missing' | 'stale' | 'degraded' | 'running';

export interface RunnerAvailability {
  status: RunnerAvailabilityStatus;
  state: RunnerLocallyPersistedState | null;
}

/**
 * Check runner availability using both persisted state and control-port reachability.
 *
 * Status semantics:
 * - missing: no persisted state exists
 * - stale: persisted state existed but PID is dead, so stale metadata was cleaned up
 * - degraded: PID is alive but control port is temporarily unreachable or unhealthy
 * - running: PID is alive and control port is healthy
 */
export async function getRunnerAvailability(): Promise<RunnerAvailability> {
  const state = await readRunnerState();
  if (!state) {
    return { status: 'missing', state: null };
  }

  // Check if the runner process is still alive
  if (!isProcessAlive(state.pid)) {
    logger.debug('[RUNNER RUN] Runner PID not running, cleaning up stale state and lock');
    await cleanupRunnerState(true);
    return { status: 'stale', state };
  }

  if (state.pid === process.pid) {
    logger.debug('[RUNNER RUN] Runner state points to current PID before control server is ready, cleaning stale metadata');
    await cleanupRunnerState(true);
    return { status: 'stale', state };
  }

  // PID reuse is common in containers (especially PID 1). Verify the control port is
  // actually responding before treating the persisted runner state as live.
  try {
    const timeout = process.env.ZS_RUNNER_HTTP_TIMEOUT ? parseInt(process.env.ZS_RUNNER_HTTP_TIMEOUT) : 1_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeout)
    });

    if (response.ok) {
      return { status: 'running', state };
    }

    logger.debug(`[RUNNER RUN] Runner state exists but control port is not healthy (HTTP ${response.status}), treating as degraded`);
  } catch (error) {
    logger.debug('[RUNNER RUN] Runner state exists but control port is unreachable, treating as degraded', error);
  }

  return { status: 'degraded', state };
}

/**
 * @deprecated Prefer getRunnerAvailability() so callers can distinguish
 * degraded, stale, and missing runner states explicitly.
 */
export async function checkIfRunnerRunningAndCleanupStaleState(): Promise<boolean> {
  const availability = await getRunnerAvailability();
  return availability.status === 'running';
}

/**
 * Check if the running runner version matches the current CLI version.
 * This should work from both the runner itself & a new CLI process.
 * Works via the runner.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no runner running
 */
export async function isRunnerRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[RUNNER CONTROL] Checking if runner is running same version');
  const availability = await getRunnerAvailability();

  if (availability.status !== 'running') {
    logger.debug(`[RUNNER CONTROL] Runner is not confirmed healthy (status: ${availability.status}), returning false`);
    return false;
  }

  const state = availability.state;
  if (!state) {
    logger.debug('[RUNNER CONTROL] No runner state found, returning false');
    return false;
  }

  try {
    const currentCliMtimeMs = getInstalledCliMtimeMs();
    if (typeof currentCliMtimeMs === 'number' && typeof state.startedWithCliMtimeMs === 'number') {
      logger.debug(`[RUNNER CONTROL] Current CLI mtime: ${currentCliMtimeMs}, Runner started with mtime: ${state.startedWithCliMtimeMs}`);
      return currentCliMtimeMs === state.startedWithCliMtimeMs;
    }

    const currentCliVersion = packageJson.version;
    logger.debug(`[RUNNER CONTROL] Current CLI version: ${currentCliVersion}, Runner started with version: ${state.startedWithCliVersion}`);
    return currentCliVersion === state.startedWithCliVersion;

    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether
    // we will get a new path or not when zs is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades,
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
    const happyProcess = spawnHappyCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    happyProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => happyProcess.stdout?.on('close', resolve));
    logger.debug(`[RUNNER CONTROL] Current CLI version: ${version}, Runner started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug('[RUNNER CONTROL] Error checking runner version', error);
    return false;
  }
}

export async function cleanupRunnerState(removeLock: boolean = false): Promise<void> {
  try {
    await clearRunnerState();
    if (removeLock) {
      await clearRunnerLock();
      logger.debug('[RUNNER RUN] Runner state and stale lock files removed');
      return;
    }
    logger.debug('[RUNNER RUN] Runner state file removed');
  } catch (error) {
    logger.debug('[RUNNER RUN] Error cleaning up runner metadata', error);
  }
}

export async function stopRunner(): Promise<boolean> {
  try {
    const state = await readRunnerState();
    if (!state) {
      logger.debug('No runner state found');
      return true;
    }

    logger.debug(`Stopping runner with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopRunnerHttp();

      // Wait for runner to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Runner stopped gracefully via HTTP');
      return true;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    const killed = await killProcess(state.pid, true);
    if (killed) {
      logger.debug('Force killed runner');
      return true;
    }

    logger.debug('Runner already dead or could not be killed');
    return !isProcessAlive(state.pid);
  } catch (error) {
    logger.debug('Error stopping runner', error);
    return false;
  }
}


async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (isProcessAlive(pid)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    return; // Process is dead
  }
  throw new Error('Process did not die within timeout');
}
