/**
 * HTTP client helpers for runner communication
 * Used by CLI commands to interact with running runner
 */

import { logger } from '@/ui/logger';
import { clearRunnerState, readRunnerState, readSettings } from '@/persistence';
import { Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { isProcessAlive } from '@/utils/process';
import { configuration } from '@/configuration';
import { hashRunnerCliApiToken, isRunnerStateCompatibleWithIdentity } from './runnerIdentity';
import { RUNNER_TIMING } from './runnerConstants';
import type { SignedManagedOutcome } from './managedOutcomeMailbox';

export function formatRunnerHttpError(path: string, status: number, payload: unknown): string {
  const base = `Request failed: ${path}, HTTP ${status}`;
  if (!payload || typeof payload !== 'object' || typeof (payload as { error?: unknown }).error !== 'string') {
    return base;
  }
  const detail = (payload as { error: string }).error.trim().replace(/\s+/g, ' ').slice(0, 500);
  return detail ? `${base}: ${detail}` : base;
}

type RunnerHttpTimeoutOptions = {
  minimumTimeoutMs?: number;
  maximumTimeoutMs?: number;
};

export function resolveRunnerHttpTimeout(
  configuredValue: string | undefined,
  options: RunnerHttpTimeoutOptions
): number {
  const parsed = configuredValue ? Number.parseInt(configuredValue, 10) : 10_000;
  const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
  const minimum = typeof options.minimumTimeoutMs === 'number' && Number.isFinite(options.minimumTimeoutMs)
    ? Math.max(1, Math.trunc(options.minimumTimeoutMs))
    : 1;
  const maximum = typeof options.maximumTimeoutMs === 'number' && Number.isFinite(options.maximumTimeoutMs)
    ? Math.max(1, Math.trunc(options.maximumTimeoutMs))
    : Number.POSITIVE_INFINITY;
  return Math.max(minimum, Math.min(configured, maximum));
}

export function getInstalledCliMtimeMs(): number | undefined {
  if (isBunCompiled()) {
    try {
      return statSync(process.execPath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  const candidates = [join(projectPath(), 'package.json')];
  if (process.argv[1]?.startsWith('/')) candidates.push(process.argv[1]);
  const mtimes = candidates.flatMap((path) => {
    try { return existsSync(path) ? [statSync(path).mtimeMs] : []; } catch { return []; }
  });
  return mtimes.length > 0 ? Math.max(...mtimes) : undefined;
}

async function runnerPost(
  path: string,
  body?: any,
  timeoutOptions: RunnerHttpTimeoutOptions = {}
): Promise<{ error?: string } | any> {
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
    const timeout = resolveRunnerHttpTimeout(process.env.HAPI_RUNNER_HTTP_TIMEOUT, timeoutOptions);
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      const errorMessage = formatRunnerHttpError(path, response.status, payload);
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
  metadata: Metadata,
  maximumTimeoutMs?: number
): Promise<{ error?: string } | any> {
  return await runnerPost('/session-started', {
    sessionId,
    metadata
  }, { maximumTimeoutMs });
}

export async function notifyRunnerNativeIdentity(input: {
  launchNonce: string;
  pid: number;
  nativeResumeId: string;
  resumeProfileFingerprint: string;
}): Promise<{ acknowledged: boolean; error?: string }> {
  const result = await runnerPost('/native-identity', input);
  return { acknowledged: result?.acknowledged === true, error: result?.error };
}

export async function listRunnerSessions(): Promise<any[]> {
  const result = await runnerPost('/list');
  return result.children || [];
}

export async function stopRunnerSession(sessionId: string): Promise<boolean> {
  const result = await runnerPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function submitManagedOutcome(envelope: SignedManagedOutcome): Promise<{ acknowledged: boolean }> {
  const result = await runnerPost('/managed-outcome', { envelope });
  return { acknowledged: result?.acknowledged === true };
}

export async function spawnRunnerSession(
  directory: string,
  sessionId?: string,
  spawnRequestId: string = randomUUID()
): Promise<any> {
  let result = await runnerPost('/spawn-session', { spawnRequestId, directory, sessionId }, { minimumTimeoutMs: 20_000 });
  const deadline = Date.now() + 120_000;
  while (result?.pending === true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const status = await queryRunnerSpawnSession(spawnRequestId);
    if (status?.type === 'pending') continue;
    if (status?.type === 'success') {
      return { success: true, sessionId: status.sessionId, approvedNewDirectoryCreation: true };
    }
    if (status?.type === 'requestToApproveDirectoryCreation') {
      return {
        success: false,
        requiresUserApproval: true,
        actionRequired: 'CREATE_DIRECTORY',
        directory: status.directory
      };
    }
    if (status?.type === 'error') return { success: false, error: status.errorMessage };
    result = status;
    break;
  }
  return result;
}

export async function queryRunnerSpawnSession(spawnRequestId: string): Promise<any> {
  return await runnerPost('/spawn-session-status', { spawnRequestId });
}

export async function stopRunnerHttp(): Promise<void> {
  await runnerPost('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded hapi,
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
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `hapi runner status` we can show more information.
 */
export async function checkIfRunnerRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readRunnerState();
  if (!state) {
    return false;
  }

  // Check if the runner is running
  if (isProcessAlive(state.pid)) {
    return true;
  }

  logger.debug('[RUNNER RUN] Runner PID not running, cleaning up state');
  await cleanupRunnerState();
  return false;
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
  const runningRunner = await checkIfRunnerRunningAndCleanupStaleState();
  if (!runningRunner) {
    logger.debug('[RUNNER CONTROL] No runner running, returning false');
    return false;
  }

  const state = await readRunnerState();
  if (!state) {
    logger.debug('[RUNNER CONTROL] No runner state found, returning false');
    return false;
  }

  const settings = await readSettings();
  const currentApiUrl = process.env.HAPI_API_URL
    || settings.apiUrl
    || settings.serverUrl
    || configuration.apiUrl;
  const currentCliApiToken = process.env.CLI_API_TOKEN
    || settings.cliApiToken
    || configuration.cliApiToken;
  const currentMachineId = settings.machineId;
  
  try {
    const currentCliMtimeMs = getInstalledCliMtimeMs();
    if (typeof currentCliMtimeMs === 'number' && typeof state.startedWithCliMtimeMs === 'number') {
      logger.debug(`[RUNNER CONTROL] Current CLI mtime: ${currentCliMtimeMs}, Runner started with mtime: ${state.startedWithCliMtimeMs}`);
      if (currentCliMtimeMs !== state.startedWithCliMtimeMs) {
        return false;
      }
    } else {
      const currentCliVersion = packageJson.version;
      logger.debug(`[RUNNER CONTROL] Current CLI version: ${currentCliVersion}, Runner started with version: ${state.startedWithCliVersion}`);
      if (currentCliVersion !== state.startedWithCliVersion) {
        return false;
      }
    }

    const currentIdentityMatches = isRunnerStateCompatibleWithIdentity(state, {
      apiUrl: currentApiUrl,
      machineId: currentMachineId,
      cliApiTokenHash: hashRunnerCliApiToken(currentCliApiToken)
    });
    logger.debug(`[RUNNER CONTROL] Runner identity match: ${currentIdentityMatches}`, {
      currentApiUrl,
      currentMachineId,
      runnerStartedWithApiUrl: state.startedWithApiUrl,
      runnerStartedWithMachineId: state.startedWithMachineId
    });
    return currentIdentityMatches;
    
    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether 
    // we will get a new path or not when hapi is upgraded globally.
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

export async function cleanupRunnerState(): Promise<void> {
  try {
    await clearRunnerState();
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
      await waitForProcessDeath(state.pid, RUNNER_TIMING.externalEscalationMs);
      logger.debug('Runner stopped gracefully via HTTP');
      return true;
    } catch (error) {
      logger.debug('HTTP stop failed; ownership must be verified before any escalation', error);
    }

    // PID-only force killing is unsafe because the PID may have been reused.
    // Escalation is allowed only after the owner handoff tuple and live birth
    // identity are verified; the lifecycle reconciler owns that path.
    logger.debug('Runner did not stop gracefully; refusing unverified PID-only force kill');
    return false;
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
