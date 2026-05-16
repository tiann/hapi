/**
 * HTTP client helpers for runner communication
 * Used by CLI commands to interact with running runner
 */

import { logger } from '@/ui/logger';
import { clearRunnerState, readRunnerState, readSettings } from '@/persistence';
import { Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { existsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { isProcessAlive, killProcess } from '@/utils/process';
import { configuration } from '@/configuration';
import { hashRunnerCliApiToken, isRunnerStateCompatibleWithIdentity } from './runnerIdentity';

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

  const timeout = process.env.HAPI_RUNNER_HTTP_TIMEOUT ? parseInt(process.env.HAPI_RUNNER_HTTP_TIMEOUT) : 10_000;
  const port = state.httpPort;
  const payload = Buffer.from(JSON.stringify(body || {}));

  // Speak HTTP/1.1 over a raw TCP socket instead of using fetch / node:http.
  // bun honors HTTP_PROXY at process startup for both APIs and offers no
  // per-request bypass; if the user's NO_PROXY is misformatted (e.g. "127.*",
  // a wildcard libcurl-style parsers don't accept) this loopback webhook
  // gets routed through the proxy and times out. Going through node:net
  // is the only path that reliably skips the proxy stack.
  return await new Promise((resolve) => {
    const fail = (reason: string) => {
      const errorMessage = `Request failed: ${path}, ${reason}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      resolve({ error: errorMessage });
    };

    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      action();
    };

    socket.setTimeout(timeout, () => {
      settle(() => fail(`timed out after ${timeout}ms`));
    });

    socket.on('connect', () => {
      const head =
        `POST ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${payload.length}\r\n` +
        `Connection: close\r\n\r\n`;
      socket.write(head);
      socket.write(payload);
    });

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    socket.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        settle(() => fail('malformed HTTP response'));
        return;
      }
      const statusLine = raw.slice(0, raw.indexOf('\r\n'));
      const statusMatch = /^HTTP\/\d\.\d (\d+)/.exec(statusLine);
      if (!statusMatch) {
        settle(() => fail('malformed HTTP status line'));
        return;
      }
      const status = parseInt(statusMatch[1]!, 10);
      const responseBody = raw.slice(headerEnd + 4);

      settle(() => {
        if (status < 200 || status >= 300) {
          const errorMessage = `Request failed: ${path}, HTTP ${status}`;
          logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
          resolve({ error: errorMessage });
          return;
        }
        try {
          resolve(responseBody ? JSON.parse(responseBody) : {});
        } catch (error) {
          fail(error instanceof Error ? error.message : 'invalid JSON response');
        }
      });
    });

    socket.on('error', (error) => {
      settle(() => fail(error.message));
    });
  });
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

export async function stopRunner() {
  try {
    const state = await readRunnerState();
    if (!state) {
      logger.debug('No runner state found');
      return;
    }

    logger.debug(`Stopping runner with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopRunnerHttp();

      // Wait for runner to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Runner stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    const killed = await killProcess(state.pid, true);
    if (killed) {
      logger.debug('Force killed runner');
    } else {
      logger.debug('Runner already dead or could not be killed');
    }
  } catch (error) {
    logger.debug('Error stopping runner', error);
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
