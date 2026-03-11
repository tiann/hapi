/**
 * Integration tests for runner HTTP control system
 *
 * Tests the full flow of runner startup, session tracking, and shutdown
 *
 * IMPORTANT: These tests MUST be run with the integration test environment:
 * yarn test:integration-test-env
 *
 * DO NOT run with regular 'npm test' or 'yarn test' - it will use the wrong environment
 * and may affect your default ~/.zhushen runner!
 *
 * The integration test environment uses .env.integration-test which sets:
 * - ZS_API_URL=http://localhost:3006 (local zhushen-hub)
 * - CLI_API_TOKEN=jlovec (must match local hub)
 *
 * ZS_HOME is isolated automatically in vitest.config.ts per process/worktree.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { existsSync, rmSync, unlinkSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path, { join } from 'path';
import { configuration } from '@/configuration';
import {
  listRunnerSessions,
  stopRunnerSession,
  spawnRunnerSession,
  stopRunnerHttp,
  notifyRunnerSessionStarted,
  stopRunner,
  getRunnerAvailability,
  isRunnerRunningCurrentlyInstalledHappyVersion
} from '@/runner/controlClient';
import { readRunnerState, clearRunnerState, clearRunnerLock } from '@/persistence';
import { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { getLatestRunnerLog } from '@/ui/logger';
import { isProcessAlive, isWindows, killProcess, killProcessByChildProcess } from '@/utils/process';

// Utility to wait for condition
async function waitFor(
  condition: () => Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Timeout waiting for condition');
}

// Check if dev hub is running and properly configured
async function isServerHealthy(): Promise<boolean> {
  try {
    if (!configuration.cliApiToken) {
      console.log('[TEST] Missing CLI_API_TOKEN (required for direct-connect integration tests)');
      return false;
    }

    const url = `${configuration.apiUrl}/cli/machines/__healthcheck__`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${configuration.cliApiToken}` },
      signal: AbortSignal.timeout(1000)
    });

    if (response.status === 401) {
      console.log('[TEST] Bot health check failed: invalid CLI_API_TOKEN');
      return false;
    }
    if (response.status === 503) {
      console.log('[TEST] Bot health check failed: bot not ready (503)');
      return false;
    }
    
    return true;
  } catch (error) {
    console.log('[TEST] Bot not reachable:', error);
    return false;
  }
}

describe.skipIf(!await isServerHealthy())('Runner Integration Tests', { timeout: 20_000 }, () => {
  let runnerPid: number;
  let shouldCleanupIsolatedHome = false;

  beforeAll(() => {
    const defaultHome = join(homedir(), '.zhushen');
    const apiUrl = configuration.apiUrl.toLowerCase();
    const isLocalApi = apiUrl.startsWith('http://localhost:') || apiUrl.startsWith('http://127.0.0.1:');

    if (configuration.happyHomeDir === defaultHome) {
      throw new Error(
        `[TEST] Refusing to run runner integration tests against default ZS_HOME: ${configuration.happyHomeDir}. ` +
          'Set isolated ZS_HOME in .env.integration-test.'
      );
    }

    if (!isLocalApi) {
      throw new Error(
        `[TEST] Refusing to run runner integration tests against non-local API URL: ${configuration.apiUrl}. ` +
          'Use local http://localhost:<port> hub for integration tests.'
      );
    }

    const isolatedHomePrefix = `${join(tmpdir(), 'zs-integration-test-')}`;
    shouldCleanupIsolatedHome = configuration.happyHomeDir.startsWith(isolatedHomePrefix);
  });

  afterAll(() => {
    if (!shouldCleanupIsolatedHome) {
      return;
    }

    rmSync(configuration.happyHomeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // First ensure no runner is running by checking PID in metadata file
    await stopRunner()

    // Start fresh runner for this test
    // This will return and start a background process - we don't need to wait for it
    void spawnHappyCLI(['runner', 'start'], {
      stdio: 'ignore'
    });

    // Wait for runner to write its state file (it needs to auth, setup, and start server)
    await waitFor(async () => {
      const state = await readRunnerState();
      return state !== null;
    }, 10_000, 250); // Wait up to 10 seconds, checking every 250ms

    const runnerState = await readRunnerState();
    if (!runnerState) {
      throw new Error('Runner failed to start within timeout');
    }
    runnerPid = runnerState.pid;

    console.log(`[TEST] Runner started for test: PID=${runnerPid}`);
    console.log(`[TEST] Runner log file: ${runnerState?.runnerLogPath}`);
  }, 20_000);

  afterEach(async () => {
    await stopRunner()
  }, 10_000);

  it('should list sessions (initially empty)', async () => {
    const sessions = await listRunnerSessions();
    expect(sessions).toEqual([]);
  });

  it('should track session-started webhook from terminal session', async () => {
    // Simulate a terminal-started session reporting to runner
    const mockMetadata: Metadata = {
      path: '/test/path',
      host: 'test-host',
      homeDir: '/test/home',
      happyHomeDir: '/test/happy-home',
      happyLibDir: '/test/happy-lib',
      happyToolsDir: '/test/happy-tools',
      hostPid: 99999,
      startedBy: 'terminal',
      machineId: 'test-machine-123'
    };

    await notifyRunnerSessionStarted('test-session-123', mockMetadata);

    // Verify session is tracked
    const sessions = await listRunnerSessions();
    expect(sessions).toHaveLength(1);
    
    const tracked = sessions[0];
    expect(tracked.startedBy).toBe('zs directly - likely by user from terminal');
    expect(tracked.happySessionId).toBe('test-session-123');
    expect(tracked.pid).toBe(99999);
  });

  it('should spawn & stop a session via HTTP (not testing RPC route, but similar enough)', async () => {
    const response = await spawnRunnerSession('/tmp', 'spawned-test-456');

    expect(response).toHaveProperty('success', true);
    expect(response).toHaveProperty('sessionId');

    // Verify session is tracked
    await waitFor(async () => {
      const sessions = await listRunnerSessions();
      return sessions.some((s: any) => s.happySessionId === response.sessionId);
    }, 5_000, 100);

    const sessions = await listRunnerSessions();
    const spawnedSession = sessions.find(
      (s: any) => s.happySessionId === response.sessionId
    );

    expect(spawnedSession).toBeDefined();
    expect(spawnedSession.startedBy).toBe('runner');

    // Clean up - stop the spawned session
    expect(spawnedSession.happySessionId).toBeDefined();
    await stopRunnerSession(spawnedSession.happySessionId);
  });

  it('stress test: spawn / stop', { timeout: 60_000 }, async () => {
    const promises = [];
    const sessionCount = 20;
    for (let i = 0; i < sessionCount; i++) {
      promises.push(spawnRunnerSession('/tmp'));
    }

    // Wait for all sessions to be spawned
    const results = await Promise.all(promises);
    results.forEach(result => {
      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
    });
    const sessionIds = results.map(r => r.sessionId);

    await waitFor(async () => {
      const sessions = await listRunnerSessions();
      return sessionIds.every(sessionId => sessions.some((s: any) => s.happySessionId === sessionId));
    }, 15_000, 200);

    const sessions = await listRunnerSessions();
    const runnerSessions = sessions.filter((s: any) => sessionIds.includes(s.happySessionId));
    expect(runnerSessions).toHaveLength(sessionCount);

    // Stop all sessions
    const stopResults = await Promise.all(sessionIds.map(sessionId => stopRunnerSession(sessionId)));
    expect(stopResults.some(r => r), 'Expected at least one stop request to be accepted').toBe(true);

    // Verify all sessions are stopped
    await waitFor(async () => {
      const emptySessions = await listRunnerSessions();
      return sessionIds.every(sessionId => !emptySessions.some((s: any) => s.happySessionId === sessionId));
    }, 10_000, 200);
  });

  it('should handle runner stop request gracefully', async () => {    
    await stopRunnerHttp();

    // Verify metadata file is cleaned up
    await waitFor(async () => !existsSync(configuration.runnerStateFile), 1000);
  });

  it('should track both runner-spawned and terminal sessions', async () => {
    const terminalPid = 88888;
    const terminalSessionId = 'terminal-session-bbb';

    const terminalMetadata: Metadata = {
      path: '/tmp',
      host: 'test-host',
      homeDir: '/test/home',
      happyHomeDir: '/test/happy-home',
      happyLibDir: '/test/happy-lib',
      happyToolsDir: '/test/happy-tools',
      hostPid: terminalPid,
      startedBy: 'terminal',
      machineId: 'test-machine-terminal'
    };

    await notifyRunnerSessionStarted(terminalSessionId, terminalMetadata);

    // Spawn a runner session
    const spawnResponse = await spawnRunnerSession('/tmp', 'runner-session-bbb');
    expect(spawnResponse.success).toBe(true);

    await waitFor(async () => {
      const sessions = await listRunnerSessions();
      const hasTerminal = sessions.some(
        (s: any) => s.startedBy === 'zs directly - likely by user from terminal' && s.happySessionId === terminalSessionId && s.pid === terminalPid
      );
      const hasRunner = sessions.some((s: any) => s.happySessionId === spawnResponse.sessionId);
      return hasTerminal && hasRunner;
    }, 10_000, 200);

    const sessions = await listRunnerSessions();
    const terminalSession = sessions.find(
      (s: any) => s.startedBy === 'zs directly - likely by user from terminal' && s.happySessionId === terminalSessionId && s.pid === terminalPid
    );
    const runnerSession = sessions.find(
      (s: any) => s.happySessionId === spawnResponse.sessionId
    );

    expect(terminalSession).toBeDefined();
    expect(terminalSession.startedBy).toBe('zs directly - likely by user from terminal');

    expect(runnerSession).toBeDefined();
    expect(runnerSession.startedBy).toBe('runner');

    await stopRunnerSession(terminalSessionId);
    await stopRunnerSession(runnerSession.happySessionId);
  });

  it('should update session metadata when webhook is called', async () => {
    // Spawn a session
    const spawnResponse = await spawnRunnerSession('/tmp');
    expect(spawnResponse.success).toBe(true);

    // Verify webhook was processed (session ID updated)
    await waitFor(async () => {
      const sessions = await listRunnerSessions();
      return sessions.some((s: any) => s.happySessionId === spawnResponse.sessionId);
    }, 10_000, 200);

    const sessions = await listRunnerSessions();
    const session = sessions.find((s: any) => s.happySessionId === spawnResponse.sessionId);
    expect(session).toBeDefined();

    // Clean up
    await stopRunnerSession(spawnResponse.sessionId);
  });

  it('should not allow starting a second runner', async () => {
    // Runner is already running from beforeEach
    // Try to start another runner
    const secondChild = spawn('bun', ['src/index.ts', 'runner', 'start-sync'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    secondChild.stdout?.on('data', (data) => {
      output += data.toString();
    });
    secondChild.stderr?.on('data', (data) => {
      output += data.toString();
    });

    // Wait for the second runner to exit
    await new Promise<void>((resolve) => {
      secondChild.on('exit', () => resolve());
    });

    // Should report that runner is already running
    expect(output).toContain('already running');
  });

  it('should handle concurrent session operations', async () => {
    // Spawn multiple sessions concurrently
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        spawnRunnerSession('/tmp')
      );
    }

    const results = await Promise.all(promises);

    // All should succeed
    results.forEach(res => {
      expect(res.success).toBe(true);
      expect(res.sessionId).toBeDefined();
    });

    // Collect session IDs for tracking
    const spawnedSessionIds = results.map(r => r.sessionId);

    await waitFor(async () => {
      const sessions = await listRunnerSessions();
      return spawnedSessionIds.every(sessionId => sessions.some((s: any) => s.happySessionId === sessionId));
    }, 10_000, 200);

    // List should show all sessions
    const sessions = await listRunnerSessions();
    const runnerSessions = sessions.filter(
      (s: any) => s.startedBy === 'runner' && spawnedSessionIds.includes(s.happySessionId)
    );
    expect(runnerSessions.length).toBeGreaterThanOrEqual(3);

    // Stop all spawned sessions
    for (const session of runnerSessions) {
      expect(session.happySessionId).toBeDefined();
      await stopRunnerSession(session.happySessionId);
    }
  });

  it('should die with logs when SIGKILL is sent', async () => {
    // SIGKILL test - runner should die immediately
    const logsDir = configuration.logsDir;
    const { readdirSync } = await import('fs');
    
    // Get initial log files
    const initialLogs = readdirSync(logsDir).filter(f => f.endsWith('-runner.log'));
    
    // Send SIGKILL to runner (force kill)
    await killProcess(runnerPid, true);
    
    // Wait for process to die
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if process is dead
    const isDead = !isProcessAlive(runnerPid);
    expect(isDead).toBe(true);
    
    // Check that log file exists (it was created when runner started)
    const finalLogs = readdirSync(logsDir).filter(f => f.endsWith('-runner.log'));
    expect(finalLogs.length).toBeGreaterThanOrEqual(initialLogs.length);
    
    // The runner won't have time to write cleanup logs with SIGKILL
    console.log('[TEST] Runner killed with SIGKILL - no cleanup logs expected');
    
    // Clean up state file manually since runner couldn't do it
    await clearRunnerState();
  });

  it('should preserve runner state when process is alive but control port is temporarily unreachable', async () => {
    const initialState = await readRunnerState();
    expect(initialState).toBeDefined();
    expect(isProcessAlive(initialState!.pid)).toBe(true);

    const originalState = readFileSync(configuration.runnerStateFile, 'utf8');
    const unreachableState = {
      ...initialState!,
      httpPort: 1
    };

    try {
      writeFileSync(configuration.runnerStateFile, JSON.stringify(unreachableState, null, 2));

      const availability = await getRunnerAvailability();
      expect(availability.status).toBe('degraded');
      expect(availability.state).toBeDefined();
      expect(availability.state!.pid).toBe(initialState!.pid);
      expect(existsSync(configuration.runnerStateFile)).toBe(true);

      const persistedState = await readRunnerState();
      expect(persistedState).toBeDefined();
      expect(persistedState!.pid).toBe(initialState!.pid);
      expect(persistedState!.httpPort).toBe(1);
    } finally {
      writeFileSync(configuration.runnerStateFile, originalState);
    }
  });

  it('should treat same-PID unreachable runner state as stale metadata', async () => {
    const originalState = readFileSync(configuration.runnerStateFile, 'utf8');

    writeFileSync(configuration.runnerLockFile, String(process.pid), 'utf8');
    expect(existsSync(configuration.runnerLockFile)).toBe(true);

    const samePidState = {
      pid: process.pid,
      httpPort: 1,
      startTime: new Date().toISOString(),
      startedWithCliVersion: 'test-version'
    };

    try {
      writeFileSync(configuration.runnerStateFile, JSON.stringify(samePidState, null, 2));

      const availability = await getRunnerAvailability();
      expect(availability.status).toBe('stale');
      expect(availability.state).toBeDefined();
      expect(availability.state!.pid).toBe(process.pid);
      expect(existsSync(configuration.runnerStateFile)).toBe(false);
      expect(existsSync(configuration.runnerLockFile)).toBe(false);
    } finally {
      if (existsSync(configuration.runnerLockFile)) {
        unlinkSync(configuration.runnerLockFile);
      }
      if (!existsSync(configuration.runnerStateFile)) {
        writeFileSync(configuration.runnerStateFile, originalState);
      }
    }
  });

  it('should not remove runner lock when only stale state is cleared', async () => {
    writeFileSync(configuration.runnerLockFile, String(runnerPid), 'utf8');
    expect(existsSync(configuration.runnerLockFile)).toBe(true);

    await clearRunnerState();

    expect(existsSync(configuration.runnerLockFile)).toBe(true);

    await clearRunnerLock();
    expect(existsSync(configuration.runnerLockFile)).toBe(false);
  });

  it('should die with cleanup logs when a graceful shutdown is requested', async () => {
    // Graceful shutdown test - runner should cleanup gracefully
    const logFile = await getLatestRunnerLog();
    if (!logFile) {
      throw new Error('No log file found');
    }
    
    if (isWindows()) {
      // Windows taskkill does not deliver SIGTERM/SIGBREAK to Node handlers.
      await stopRunnerHttp();
    } else {
      // Send SIGTERM to runner (graceful shutdown)
      await killProcess(runnerPid);
    }
    
    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 4_000));
    
    // Check if process is dead
    const isDead = !isProcessAlive(runnerPid);
    expect(isDead).toBe(true);
    
    // Read the log file to check for cleanup messages
    const logContent = readFileSync(logFile.path, 'utf8');
    
    // Should contain cleanup messages
    if (!isWindows()) {
      expect(logContent).toContain('SIGTERM');
    }
    expect(logContent).toContain('cleanup');
    
    console.log('[TEST] Runner terminated gracefully - cleanup logs written');
    
    // Clean up state file if it still exists (should have been cleaned by SIGTERM handler)
    await clearRunnerState();
  });

  /**
   * Version mismatch detection in development mode is based on package.json mtime.
   * This test verifies the detection contract itself without depending on a full
   * self-restart handoff, which is timing-sensitive under integration-test process control.
   */
  it('should detect runner version mismatch in development mode', async () => {
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJsonOriginalRawText = readFileSync(packagePath, 'utf8');
    const originalPackage = JSON.parse(packageJsonOriginalRawText);
    const originalVersion = originalPackage.version;
    const testVersion = `0.0.0-integration-test-should-be-auto-cleaned-up-${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

    expect(originalVersion, 'Your current cli version was not cleaned up from previous test it seems').not.toBe(testVersion);

    const initialState = await readRunnerState();
    expect(initialState).toBeDefined();
    expect(typeof initialState!.startedWithCliMtimeMs).toBe('number');
    const initialCliMtimeMs = initialState!.startedWithCliMtimeMs!;

    const modifiedPackage = { ...originalPackage, version: testVersion };
    writeFileSync(packagePath, JSON.stringify(modifiedPackage, null, 2));

    try {
      const modifiedPackageStat = statSync(packagePath);
      expect(modifiedPackageStat.mtimeMs).not.toBe(initialCliMtimeMs);

      await waitFor(async () => {
        return !(await isRunnerRunningCurrentlyInstalledHappyVersion());
      }, 5_000, 200);

      expect(await isRunnerRunningCurrentlyInstalledHappyVersion()).toBe(false);
    } finally {
      writeFileSync(packagePath, packageJsonOriginalRawText);
      console.log(`[TEST] Restored package.json version to ${originalVersion}`);
    }
  });

  it('should restart runner when it is already running', async () => {
    // Runner is already running from beforeEach and restart must replace it with a new PID
    const initialState = await readRunnerState();
    expect(initialState).toBeDefined();
    const initialPid = initialState!.pid;

    // Use the actual restart subcommand (stop + start + show status)
    void spawnHappyCLI(['runner', 'restart'], {
      stdio: 'ignore'
    });

    // Wait for new runner to come up with a different PID so we know restart did not reuse stale state
    await waitFor(async () => {
      const state = await readRunnerState();
      return state !== null && state.pid !== initialPid;
    }, 15_000, 250);

    const newState = await readRunnerState();
    expect(newState).toBeDefined();
    expect(newState!.pid).not.toBe(initialPid);
    expect(isProcessAlive(newState!.pid)).toBe(true);

    // Update runnerPid for afterEach cleanup
    runnerPid = newState!.pid;
  });

  it('should restart runner when it is not running', async () => {
    // Stop the runner first so no runner is running
    await stopRunner();

    // Wait for runner to die
    await waitFor(async () => !isProcessAlive(runnerPid), 3000);

    // Use the actual restart subcommand - should tolerate no runner running
    void spawnHappyCLI(['runner', 'restart'], {
      stdio: 'ignore'
    });

    // Wait for new runner to come up
    await waitFor(async () => {
      const state = await readRunnerState();
      return state !== null;
    }, 15_000, 250);

    const newState = await readRunnerState();
    expect(newState).toBeDefined();
    expect(isProcessAlive(newState!.pid)).toBe(true);

    // Update runnerPid for afterEach cleanup
    runnerPid = newState!.pid;
  });

  // TODO: Add a test to see if a corrupted file will work

  // TODO: Test npm uninstall scenario - runner should gracefully handle when zs is uninstalled
  // Current behavior: runner tries to spawn new runner on version mismatch but entrypoint is gone
  // Expected: runner should detect missing entrypoint and either exit cleanly or at minimum not respawn infinitely
});
