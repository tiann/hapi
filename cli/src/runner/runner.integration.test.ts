/**
 * Integration tests for runner HTTP control system
 * 
 * Tests the full flow of runner startup, session tracking, and shutdown
 * 
 * IMPORTANT: These tests spawn real detached runner/session process trees
 * and MUST be run through the dedicated serial integration project:
 * 
 *   bun run test:integration            (runner lifecycle coverage)
 *   bun run test:integration:stress     (+ the 20-session stress test)
 * 
 * They are EXCLUDED from the default parallel unit-test suite
 * (`bun run test` / `vitest run`) — see vitest.config.ts and
 * vitest.integration.config.ts. Every process the suite spawns is registered
 * with testProcessRegistry immediately after spawn, so even a failing or
 * interrupted test still reaps its children (two-stage: logical stop first,
 * then bounded process-tree termination). The final audit lives in
 * globalSetup teardown and fails the run if any test-owned process survives.
 * 
 * The 20-session stress test is opt-in via HAPI_RUN_STRESS_TESTS=true.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import path, { join } from 'path';
import { configuration } from '@/configuration';
import { 
  listRunnerSessions, 
  stopRunnerSession, 
  spawnRunnerSession, 
  stopRunnerHttp, 
  notifyRunnerSessionStarted, 
  stopRunner
} from '@/runner/controlClient';
import { readRunnerState, clearRunnerState } from '@/persistence';
import { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { getLatestRunnerLog } from '@/ui/logger';
import { getProcessStartMarker, isProcessAlive, isWindows, killProcess, killProcessByChildProcess } from '@/utils/process';
import { ApiClient } from '@/api/api';
import { buildTestChildEnv, testOwnedMarker } from '@/test/integrationEnv';
import { trackChildProcess, trackRunnerPid, trackSession, cleanupAllRegisteredProcesses } from '@/test/processRegistry';
import { findTestOwnedProcesses, reapTestOwnedProcesses } from '@/test/auditTestProcesses';

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

  /** Spawn a runner session and register it in the test-owned registry immediately. */
  async function spawnTrackedSession(directory: string, sessionId?: string): Promise<any> {
    const response = await spawnRunnerSession(directory, sessionId);
    if (response?.sessionId) {
      trackSession(response.sessionId, `runner-session:${response.sessionId}`);
    }
    return response;
  }

  async function startTestRunner(env: NodeJS.ProcessEnv = {}): Promise<void> {
    // Start fresh runner for this test
    // This will return and start a background process - we don't need to wait for it
    const runnerLauncher = spawnHappyCLI(['runner', 'start'], {
      stdio: 'ignore',
      // Test-scoped env: neutralizes any outer HAPI/pi session identity and
      // stamps every child with the run's unique test marker.
      env: { ...buildTestChildEnv(), ...env }
    });
    // Register immediately after spawn so cleanup runs even if this test fails
    // before reaching its happy-path teardown.
    trackChildProcess(runnerLauncher, 'runner-launcher');
    
    // The state file proves local control is available, not that the Hub has
    // received this runner's RPC registrations yet.
    // Also require the PID to actually be alive: a SIGKILLed runner (or a
    // crashed one) can leave a stale runner.state.json behind, and reading it
    // as "started" would make every control call in the test body fail.
    await waitFor(async () => {
      const state = await readRunnerState();
      return state !== null && isProcessAlive(state.pid);
    }, 10_000, 250); // Wait up to 10 seconds, checking every 250ms
    
    const runnerState = await readRunnerState();
    if (!runnerState) {
      throw new Error('Runner failed to start within timeout');
    }
    runnerPid = runnerState.pid;
    trackRunnerPid(runnerPid, 'runner');

    const machineId = runnerState.startedWithMachineId;
    if (!machineId) throw new Error('Runner state is missing its machine ID');
    // ApiMachineClient emits its RPC registrations before the running-state
    // update on the same socket. Match the PID so the previous runner's state
    // cannot satisfy this barrier during a restart.
    await waitFor(async () => {
      const response = await fetch(`${configuration.apiUrl}/cli/machines/${machineId}`, {
        headers: { Authorization: `Bearer ${configuration.cliApiToken}` },
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const { machine } = await response.json() as {
        machine?: { active: boolean; runnerState: { status: string; pid?: number } | null };
      };
      return machine?.active === true
        && machine.runnerState?.status === 'running'
        && machine.runnerState.pid === runnerPid;
    }, 10_000);

    console.log(`[TEST] Runner started for test: PID=${runnerPid}`);
    console.log(`[TEST] Runner log file: ${runnerState?.runnerLogPath}`);
  }

  beforeEach(async () => {
    // First ensure no runner is running by checking PID in metadata file
    await stopRunner()
    await startTestRunner()
  });

  /** Bounded wrapper around the graceful runner stop. */
  async function stopRunnerBounded(): Promise<void> {
    // stopRunner()'s HTTP stop can burn the worker-wide 60s timeout
    // (HAPI_RUNNER_HTTP_TIMEOUT) on a hung-but-live runner, which would
    // exhaust the hook budget before the marker sweep runs. Bound it: if the
    // runner does not stop in time, the sweep below force-reaps it (it
    // carries the run marker) and the next beforeEach's alive-PID guard
    // ignores any stale state file.
    await Promise.race([stopRunner(), new Promise((resolve) => setTimeout(resolve, 10_000))])
  }

  afterEach(async () => {
    // Two-stage cleanup must run BEFORE stopRunner() so the runner is still
    // alive to logically stop tracked sessions and report their PIDs.
    await cleanupAllRegisteredProcesses()
    // Graceful stop (the runner removes its own state file), bounded so a
    // hung runner cannot starve the sweep below.
    await stopRunnerBounded()
    // Marker sweep: sessions/agents can reparent to PID 1 before the registry
    // tree-kill runs, so reap anything still carrying the run's test marker
    // (same audit globalSetup teardown performs at the end of the run). This
    // runs unconditionally and its survivors are verified, never ignored.
    const leftovers = await reapTestOwnedProcesses(testOwnedMarker())
    expect(
      leftovers,
      'test-owned processes survived the marker sweep'
    ).toEqual([]);
  });

  afterAll(async () => {
    await cleanupAllRegisteredProcesses()
    await stopRunnerBounded()
    await reapTestOwnedProcesses(testOwnedMarker())
  });

  it('should list sessions (initially empty)', async () => {
    const sessions = await listRunnerSessions();
    expect(sessions).toEqual([]);
  });

  const resumeProcessFile = `${configuration.runnerStateFile}.resume-processes.json`;
  const verifiedExitFile = `${configuration.runnerStateFile}.verified-exits.json`;
  type ResumeRecord = {
    requestedSessionId: string;
    confirmedSessionId: string;
    pid: number;
    processStartMarker: string;
    bootId?: string;
  };

  function readResumeRecords(): ResumeRecord[] {
    return JSON.parse(readFileSync(resumeProcessFile, 'utf8'));
  }

  function expectNoExitTombstone(sessionId: string, pid: number): void {
    const exits: string[] = existsSync(verifiedExitFile)
      ? JSON.parse(readFileSync(verifiedExitFile, 'utf8'))
      : [];
    expect(exits).not.toContain(sessionId);
    expect(exits).not.toContain(`PID-${pid}`);
  }

  async function restartWithResumeRecords(records: ResumeRecord[], env: NodeJS.ProcessEnv = {}): Promise<void> {
    const oldPid = runnerPid;
    await stopRunnerHttp();
    await waitFor(async () => !isProcessAlive(oldPid));
    writeFileSync(resumeProcessFile, JSON.stringify(records));
    await startTestRunner(env);
  }

  async function spawnUnrelatedProcess(): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: buildTestChildEnv(),
      stdio: 'ignore',
    });
    trackChildProcess(child, 'resume-generation-unrelated-process');
    if (!child.pid) throw new Error('Failed to spawn generation fixture');
    const pid = child.pid;
    await waitFor(async () => getProcessStartMarker(pid) !== null);
    return pid;
  }

  async function findFixtureThread(pid: number): Promise<number> {
    let tid: number | undefined;
    await waitFor(async () => {
      tid = readdirSync(`/proc/${pid}/task`).map(Number).find(candidate => candidate !== pid);
      return tid !== undefined;
    });
    return tid!;
  }

  function processProbeFixture(pid: number | { pidFile: string }): { modeFile: string; env: NodeJS.ProcessEnv } {
    const binDir = join(configuration.happyHomeDir, `generation-probe-${randomUUID()}`);
    mkdirSync(binDir);
    const modeFile = join(binDir, 'mode');
    const quotedModeFile = `'${modeFile.replace(/'/g, `'\\''`)}'`;
    const expectedPid = typeof pid === 'number'
      ? `'${pid}'`
      : `"$(cat '${pid.pidFile.replace(/'/g, `'\\''`)}' 2>/dev/null)"`;
    // Only this test-owned PID's lstart probe is changed. All identity,
    // process-tree, and orphan scans use the real system ps unchanged.
    writeFileSync(join(binDir, 'ps'), `#!/bin/sh
if [ "$1" = '-p' ] && [ "$2" = ${expectedPid} ] && [ "$3" = '-o' ] && [ "$4" = 'lstart=' ] && [ -f ${quotedModeFile} ]; then
  case "$(cat ${quotedModeFile})" in
    block) exit 1 ;;
    replace) printf '%s\\n' 'different-generation'; exit 0 ;;
  esac
fi
exec /bin/ps "$@"
`, { mode: 0o755 });
    return {
      modeFile,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        HAPI_RUNNER_HEARTBEAT_INTERVAL: '200',
        HAPI_DISABLE_VERSION_HANDOFF: '1',
      },
    };
  }

  it.skipIf(process.platform !== 'linux')('releases a previous-boot record without stopping the reused live PID or claiming session exit', async () => {
    const pid = await spawnUnrelatedProcess();
    const currentBoot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const oldBoot = currentBoot === '00000000-0000-4000-8000-000000000000'
      ? '00000000-0000-4000-8000-000000000001'
      : '00000000-0000-4000-8000-000000000000';
    const sessionId = randomUUID();
    await restartWithResumeRecords([{
      requestedSessionId: sessionId,
      confirmedSessionId: sessionId,
      pid,
      // A matching marker must not override proof of a different boot.
      processStartMarker: getProcessStartMarker(pid)!,
      bootId: oldBoot,
    }]);

    expect(readResumeRecords().some(record => record.requestedSessionId === sessionId)).toBe(false);
    expect(isProcessAlive(pid)).toBe(true);
    expectNoExitTombstone(sessionId, pid);
    expect(await stopRunnerSession(sessionId)).toBe('unknown');
    expect(isProcessAlive(pid)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('releases a legacy record whose PID was reused by a live nonleader thread', async () => {
    const pid = await spawnUnrelatedProcess();
    const tid = await findFixtureThread(pid);
    expect(isProcessAlive(tid)).toBe(true);
    expect(getProcessStartMarker(tid)).toBeNull();
    const sessionId = randomUUID();
    await restartWithResumeRecords([{
      requestedSessionId: sessionId,
      confirmedSessionId: sessionId,
      pid: tid,
      processStartMarker: 'Sun Oct 25 04:46:27 2026',
    }]);

    expect(readResumeRecords().some(record => record.requestedSessionId === sessionId)).toBe(false);
    expect(isProcessAlive(pid)).toBe(true);
    expect(isProcessAlive(tid)).toBe(true);
    expectNoExitTombstone(sessionId, tid);
    expect(await stopRunnerSession(sessionId)).toBe('unknown');
    expect(isProcessAlive(tid)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('does not adopt or terminate a session webhook naming a nonleader thread', async () => {
    const pid = await spawnUnrelatedProcess();
    const tid = await findFixtureThread(pid);
    const sessionId = randomUUID();
    await notifyRunnerSessionStarted(sessionId, {
      path: '/tmp',
      host: hostname(),
      homeDir: '/tmp',
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: process.cwd(),
      happyToolsDir: process.cwd(),
      hostPid: tid,
      startedBy: 'runner',
      machineId: 'test-generation-machine',
    });

    expect((await listRunnerSessions()).some(item => item.happySessionId === sessionId)).toBe(false);
    expect(readResumeRecords().some(item => item.requestedSessionId === sessionId)).toBe(false);
    expect(isProcessAlive(pid)).toBe(true);
    expect(isProcessAlive(tid)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('preserves live legacy and same-boot records when restarting the runner', async () => {
    const legacyPid = await spawnUnrelatedProcess();
    const currentPid = await spawnUnrelatedProcess();
    const uppercasePid = await spawnUnrelatedProcess();
    const malformedPid = await spawnUnrelatedProcess();
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const records: ResumeRecord[] = [legacyPid, currentPid, uppercasePid, malformedPid].map(pid => {
      const sessionId = randomUUID();
      return {
        requestedSessionId: sessionId,
        confirmedSessionId: sessionId,
        pid,
        processStartMarker: getProcessStartMarker(pid)!,
        ...(pid === legacyPid ? {} : {
          bootId: pid === uppercasePid ? bootId.toUpperCase()
            : pid === malformedPid ? 'not-a-boot-id' : bootId,
        }),
      };
    });
    await restartWithResumeRecords(records);

    const { bootId: _invalidBoot, ...legacyMalformed } = records[3];
    expect(readResumeRecords()).toEqual(expect.arrayContaining([
      records[0], records[1], { ...records[2], bootId }, legacyMalformed,
    ]));
    for (const record of records) {
      expect(isProcessAlive(record.pid)).toBe(true);
      expectNoExitTombstone(record.requestedSessionId, record.pid);
    }
  });

  it.skipIf(process.platform !== 'linux')('keeps an unverifiable record through stop and releases a later heartbeat mismatch without exit tombstones', async () => {
    const pid = await spawnUnrelatedProcess();
    const sessionId = randomUUID();
    const record: ResumeRecord = {
      requestedSessionId: sessionId,
      confirmedSessionId: sessionId,
      pid,
      processStartMarker: getProcessStartMarker(pid)!,
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    };
    const fixture = processProbeFixture(pid);
    writeFileSync(fixture.modeFile, 'block');
    await restartWithResumeRecords([record], fixture.env);

    expect(readResumeRecords()).toContainEqual(record);
    expect(await stopRunnerSession(sessionId)).toBe('still_alive');
    expect(readResumeRecords()).toContainEqual(record);
    expect(isProcessAlive(pid)).toBe(true);
    expectNoExitTombstone(sessionId, pid);

    unlinkSync(fixture.modeFile);
    const heartbeat = (await readRunnerState())?.lastHeartbeat;
    await waitFor(async () => (await readRunnerState())?.lastHeartbeat !== heartbeat);
    expect(readResumeRecords()).toContainEqual(record);
    expectNoExitTombstone(sessionId, pid);

    writeFileSync(fixture.modeFile, 'replace');
    await waitFor(async () => !readResumeRecords().some(item => item.requestedSessionId === sessionId));
    expect(isProcessAlive(pid)).toBe(true);
    expectNoExitTombstone(sessionId, pid);
    expect(await stopRunnerSession(sessionId)).toBe('unknown');
  });

  it.skipIf(process.platform !== 'linux')('preserves an adopted process and its record when stop cannot verify its generation', async () => {
    const pid = await spawnUnrelatedProcess();
    const sessionId = randomUUID();
    const fixture = processProbeFixture(pid);
    await restartWithResumeRecords([], fixture.env);
    await notifyRunnerSessionStarted(sessionId, {
      path: '/tmp',
      host: hostname(),
      homeDir: '/tmp',
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: process.cwd(),
      happyToolsDir: process.cwd(),
      hostPid: pid,
      hostStartMarker: getProcessStartMarker(pid)!,
      startedBy: 'runner',
      machineId: 'test-generation-machine',
    });
    const record = readResumeRecords().find(item => item.requestedSessionId === sessionId);
    expect(record).toBeDefined();

    writeFileSync(fixture.modeFile, 'block');
    expect(await stopRunnerSession(sessionId)).toBe('still_alive');
    expect(readResumeRecords()).toContainEqual(record);
    expect((await listRunnerSessions()).some(item => item.happySessionId === sessionId)).toBe(true);
    expect(isProcessAlive(pid)).toBe(true);
    expectNoExitTombstone(sessionId, pid);

    unlinkSync(fixture.modeFile);
    const heartbeat = (await readRunnerState())?.lastHeartbeat;
    await waitFor(async () => (await readRunnerState())?.lastHeartbeat !== heartbeat);
    expect(isProcessAlive(pid)).toBe(true);
    expect(readResumeRecords()).toContainEqual(record);
  });

  it.skipIf(process.platform !== 'linux')('settles an unconfirmed startup on generation mismatch and cancels its old kill deadline', async () => {
    const fixtureDir = join(configuration.happyHomeDir, `unconfirmed-generation-${randomUUID()}`);
    mkdirSync(fixtureDir);
    const pidFile = join(fixtureDir, 'pid');
    const preload = join(fixtureDir, 'preload.ts');
    // Bun runs this before the CLI entrypoint. Park only the test session;
    // runner launchers and the runner itself still execute their real code.
    writeFileSync(preload, `import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'claude') {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
`);
    const fixture = processProbeFixture({ pidFile });
    const webhookTimeoutMs = 3000;
    await restartWithResumeRecords([], {
      ...fixture.env,
      BUN_OPTIONS: `--preload=${preload}`,
      HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: String(webhookTimeoutMs),
    });
    const state = await readRunnerState();
    const sessionId = randomUUID();
    const spawnRequest = fetch(`http://127.0.0.1:${state!.httpPort}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/tmp', sessionId }),
    }).then(async response => ({ status: response.status, body: await response.json() as { error?: string } }));
    // Teardown may stop the runner while a deliberately failing Red assertion
    // leaves this request pending. Observe its rejection in that case too.
    void spawnRequest.catch(() => {});
    await waitFor(async () => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    trackRunnerPid(pid, 'unconfirmed-generation-session');
    await waitFor(async () => readResumeRecords().some(record => record.pid === pid));
    const startupObservedAt = Date.now();
    expect(isProcessAlive(pid)).toBe(true);

    writeFileSync(fixture.modeFile, 'replace');
    await waitFor(async () => !readResumeRecords().some(record => record.pid === pid));
    const result = await Promise.race([
      spawnRequest,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 1000)),
    ]);
    expect(result, 'generation invalidation must settle startup before its old timeout').not.toBeNull();
    expect(result!.status).toBe(500);
    expect(result!.body.error).toMatch(/generation changed before startup was confirmed/);
    expectNoExitTombstone(sessionId, pid);

    // Cross the original deadline: its timer must have been cancelled instead
    // of signalling the now-untrusted PID after the binding was discarded.
    await waitFor(async () => Date.now() > startupObservedAt + webhookTimeoutMs + 300, webhookTimeoutMs + 1000);
    expect(isProcessAlive(pid)).toBe(true);
    expectNoExitTombstone(sessionId, pid);
  });

  it.skipIf(process.platform !== 'linux')('persists the boot ID of a newly spawned session across runner restart', async () => {
    const response = await spawnTrackedSession('/tmp');
    expect(response.success).toBe(true);
    const record = readResumeRecords().find(item => item.confirmedSessionId === response.sessionId);
    expect(record).toBeDefined();
    expect(record!.bootId).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    await restartWithResumeRecords([record!]);
    expect(readResumeRecords()).toContainEqual(record);
    expect(isProcessAlive(record!.pid)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('resumes the same Hub session once after recovering a stale thread record', async () => {
    const pid = await spawnUnrelatedProcess();
    const tid = await findFixtureThread(pid);
    const machineId = JSON.parse(readFileSync(configuration.settingsFile, 'utf8')).machineId;
    expect(typeof machineId).toBe('string');
    const api = await ApiClient.create();
    const session = await api.getOrCreateSession({
      tag: `resume-generation-${randomUUID()}`,
      metadata: {
        path: '/tmp',
        host: hostname(),
        homeDir: '/tmp',
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: process.cwd(),
        happyToolsDir: process.cwd(),
        machineId,
        flavor: 'claude',
      },
      state: null,
    });
    trackSession(session.id, 'resumed-generation-session');
    expect(session.active).toBe(false);
    const registrationMarker = join(configuration.happyHomeDir, `rpc-registration-${randomUUID()}`);
    const registrationPreload = `${registrationMarker}.ts`;
    // Exercise the state-file/Hub-registration gap without delaying RPC or
    // resume requests after registration. Preserve register-before-running.
    writeFileSync(registrationPreload, `import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'runner' && process.argv[3] === 'start-sync') {
  const { RpcHandlerManager } = await import(${JSON.stringify(join(process.cwd(), 'src/api/rpc/RpcHandlerManager.ts'))});
  const onSocketConnect = RpcHandlerManager.prototype.onSocketConnect;
  RpcHandlerManager.prototype.onSocketConnect = function(socket) {
    writeFileSync(${JSON.stringify(registrationMarker)}, String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    return onSocketConnect.call(this, socket);
  };
}
`);
    await restartWithResumeRecords([{
      requestedSessionId: session.id,
      confirmedSessionId: session.id,
      pid: tid,
      processStartMarker: 'Sun Oct 25 04:46:27 2026',
    }], { BUN_OPTIONS: `--preload=${registrationPreload}` });
    await waitFor(async () => existsSync(registrationMarker));
    expect(readFileSync(registrationMarker, 'utf8')).toBe(String(runnerPid));

    const auth = await fetch(`${configuration.apiUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: configuration.cliApiToken }),
    });
    expect(auth.status).toBe(200);
    const { token } = await auth.json() as { token: string };
    const resume = () => fetch(`${configuration.apiUrl}/api/sessions/${session.id}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const responses = await Promise.all([resume(), resume()]);
    for (const response of responses) {
      const body = await response.json();
      expect(body).toEqual({ type: 'success', sessionId: session.id });
      expect(response.status).toBe(200);
    }
    const retry = await resume();
    expect(retry.status).toBe(200);
    const sessions = await listRunnerSessions();
    expect(sessions.filter(item => item.happySessionId === session.id)).toHaveLength(1);
    expect(isProcessAlive(pid)).toBe(true);
    expect(isProcessAlive(tid)).toBe(true);
  }, 40_000);

  it('preserves shared Codex support after a runner heartbeat', async () => {
    const initial = await readRunnerState();
    expect(initial?.sharedCodexRuntime).toBe(true);

    await waitFor(async () => Boolean((await readRunnerState())?.lastHeartbeat), 35_000);

    const afterHeartbeat = await readRunnerState();
    expect(afterHeartbeat?.pid).toBe(initial?.pid);
    expect(afterHeartbeat?.sharedCodexRuntime).toBe(true);
  }, 40_000);

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
    expect(tracked.startedBy).toBe('hapi directly - likely by user from terminal');
    expect(tracked.happySessionId).toBe('test-session-123');
    expect(tracked.pid).toBe(99999);
  });

  it('should spawn & stop a session via HTTP (not testing RPC route, but similar enough)', async () => {
    const response = await spawnTrackedSession('/tmp', 'spawned-test-456');

    expect(response).toHaveProperty('success', true);
    expect(response).toHaveProperty('sessionId');

    // Verify session is tracked
    const sessions = await listRunnerSessions();
    const spawnedSession = sessions.find(
      (s: any) => s.happySessionId === response.sessionId
    );
    
    expect(spawnedSession).toBeDefined();
    expect(spawnedSession.startedBy).toBe('runner');
    
    // Clean up - stop the spawned session
    expect(spawnedSession.happySessionId).toBeDefined();
    expect(await stopRunnerSession(spawnedSession.happySessionId)).toBe('stopped');
    expect(await stopRunnerSession(spawnedSession.happySessionId)).toBe('already_gone');
    // Distinct from 'still_alive': no PID matched this id and there is no
    // verified-exit tombstone (and argv orphan scan found nothing), so the
    // runner has no basis to call it either alive or dead.
    expect(await stopRunnerSession('unknown-session-id')).toBe('unknown');
  });

  it.skipIf(process.env.HAPI_RUN_STRESS_TESTS !== 'true')(
    'stress test: spawn / stop (opt-in via HAPI_RUN_STRESS_TESTS=true)',
    { timeout: 60_000 },
    async () => {
      const promises = [];
      const sessionCount = 20;
      for (let i = 0; i < sessionCount; i++) {
        promises.push(spawnTrackedSession('/tmp'));
      }

      // Wait for all sessions to be spawned
      const results = await Promise.all(promises);
      const sessionIds = results.map(r => r.sessionId);

      const sessions = await listRunnerSessions();
      expect(sessions).toHaveLength(sessionCount);

      // Stop all sessions
      const stopResults = await Promise.all(sessionIds.map(sessionId => stopRunnerSession(sessionId)));
      expect(stopResults.every(r => r === 'stopped' || r === 'already_gone'), 'Not all sessions reported stopped').toBe(true);

      // Verify all sessions are stopped
      const emptySessions = await listRunnerSessions();
      expect(emptySessions).toHaveLength(0);
    }
  );

  it('should handle runner stop request gracefully', async () => {    
    await stopRunnerHttp();

    // Verify metadata file is cleaned up
    await waitFor(async () => !existsSync(configuration.runnerStateFile), 1000);
  });

  it('should track both runner-spawned and terminal sessions', async () => {
    // Spawn a real hapi process that looks like it was started from terminal
    const terminalHappyProcess = spawnHappyCLI([
      'claude',
      '--hapi-starting-mode', 'remote',
      '--started-by', 'terminal'
    ], {
      cwd: '/tmp',
      detached: true,
      stdio: 'ignore',
      env: buildTestChildEnv()
    });
    // Register immediately after spawn so cleanup runs even on failure.
    trackChildProcess(terminalHappyProcess, 'terminal-session');
    if (!terminalHappyProcess || !terminalHappyProcess.pid) {
      throw new Error('Failed to spawn terminal hapi process');
    }
    // Give time to start & report itself
    await new Promise(resolve => setTimeout(resolve, 5_000));

    // Spawn a runner session
    const spawnResponse = await spawnTrackedSession('/tmp', 'runner-session-bbb');

    // List all sessions
    const sessions = await listRunnerSessions();
    expect(sessions).toHaveLength(2);

    // Verify we have one of each type
    const terminalSession = sessions.find(
      (s: any) => s.pid === terminalHappyProcess.pid
    );
    const runnerSession = sessions.find(
      (s: any) => s.happySessionId === spawnResponse.sessionId
    );

    expect(terminalSession).toBeDefined();
    expect(terminalSession.startedBy).toBe('hapi directly - likely by user from terminal');
    
    expect(runnerSession).toBeDefined();
    expect(runnerSession.startedBy).toBe('runner');

    // Clean up both sessions
    await stopRunnerSession('terminal-session-aaa');
    await stopRunnerSession(runnerSession.happySessionId);
    
    // Also kill the terminal process directly to be sure
    try {
      await killProcessByChildProcess(terminalHappyProcess);
    } catch (e) {
      // Process might already be dead
    }
  });

  it('should update session metadata when webhook is called', async () => {
    // Spawn a session
    const spawnResponse = await spawnTrackedSession('/tmp');

    // Verify webhook was processed (session ID updated)
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
      env: buildTestChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Register immediately so the registry can reap it if the test fails.
    trackChildProcess(secondChild, 'second-runner');

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
        spawnTrackedSession('/tmp')
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

    // Give sessions time to report via webhook
    await new Promise(resolve => setTimeout(resolve, 1000));

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
   * Version mismatch detection test - control flow:
   * 
   * 1. Test starts runner with original version (e.g., 0.9.0-6) compiled into dist/
   * 2. Test modifies package.json to new version (e.g., 0.0.0-integration-test-*)
   * 3. Test runs `yarn build` to recompile with new version
   * 4. Runner's heartbeat (every 30s) reads package.json and compares to its compiled version
   * 5. Runner detects mismatch: package.json != configuration.currentCliVersion
   * 6. Runner spawns new runner via spawnHappyCLI(['runner', 'start'])
   * 7. New runner starts, reads runner.state.json, sees old version != its compiled version
   * 8. New runner calls stopRunner() to kill old runner, then takes over
   * 
   * This simulates what happens during `npm upgrade hapi`:
   * - Running runner has OLD version loaded in memory (configuration.currentCliVersion)
   * - npm replaces node_modules/hapi/ with NEW version files
   * - package.json on disk now has NEW version
   * - Runner reads package.json, detects mismatch, triggers self-update
   * - Key difference: npm atomically replaces the entire module directory, while
   *   our test must carefully rebuild to avoid missing entrypoint errors
   * 
   * Critical timing constraints:
   * - Heartbeat must be long enough (30s) for yarn build to complete before runner tries to spawn
   * - If heartbeat fires during rebuild, spawn fails (entrypoint missing) and test fails
   * - pkgroll doesn't reliably update compiled version, must use full yarn build
   * - Test modifies package.json BEFORE rebuild to ensure new version is compiled in
   * 
   * Common failure modes:
   * - Heartbeat too short: runner tries to spawn while dist/ is being rebuilt
   * - Using pkgroll alone: doesn't update compiled configuration.currentCliVersion
   * - Modifying package.json after runner starts: triggers immediate version check on startup
   */
  it('[takes 1 minute to run] should detect version mismatch and kill old runner', { timeout: 100_000 }, async () => {
    // Read current package.json to get version
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJsonOriginalRawText = readFileSync(packagePath, 'utf8');
    const originalPackage = JSON.parse(packageJsonOriginalRawText);
    const originalVersion = originalPackage.version;
    const testVersion = `0.0.0-integration-test-should-be-auto-cleaned-up-${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

    expect(originalVersion, 'Your current cli version was not cleaned up from previous test it seems').not.toBe(testVersion);
    
    // Modify package.json version
    const modifiedPackage = { ...originalPackage, version: testVersion };
    writeFileSync(packagePath, JSON.stringify(modifiedPackage, null, 2));

    try {
      // Get initial runner state
      const initialState = await readRunnerState();
      expect(initialState).toBeDefined();
      expect(initialState!.startedWithCliVersion).toBe(originalVersion);
      const initialPid = initialState!.pid;

      // No rebuild needed: bun runs TypeScript directly, so the spawned runner
      // process reads package.json fresh and picks up the modified version automatically.

      console.log(`[TEST] Current runner running with version ${originalVersion}, PID: ${initialPid}`);
      
      console.log(`[TEST] Changed package.json version to ${testVersion}`);

      // The runner should automatically detect the version mismatch and restart itself
      // We check once per minute, wait for a little longer than that
      await new Promise(resolve => setTimeout(resolve, parseInt(process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL || '30000') + 10_000));

      // Check that the runner is running with the new version
      const finalState = await readRunnerState();
      expect(finalState).toBeDefined();
      expect(finalState!.startedWithCliVersion).toBe(testVersion);
      expect(finalState!.pid).not.toBe(initialPid);
      console.log('[TEST] Runner version mismatch detection successful');
    } finally {
      // CRITICAL: Restore original package.json version
      writeFileSync(packagePath, packageJsonOriginalRawText);
      console.log(`[TEST] Restored package.json version to ${originalVersion}`);

      // No rebuild needed with bun (TypeScript is run directly).
    }
  });

  /**
   * Regression coverage for issue #1515: a test that never reaches its own
   * happy-path cleanup must not leak the detached children it registered at
   * spawn time. The child is tracked immediately after spawn; the test body
   * then runs ONLY the spawn-time registered cleanup and asserts the child is
   * gone.
   *
   * A deliberately-failing (`it.fails`) variant would be weaker here: Vitest
   * applies the expected-failure inversion after afterEach, so a broken
   * registry assertion inside the hook would be masked as "expected". A
   * normal test asserts directly.
   */
  it('regression: registered detached child is reaped even when the test body never reaches its own cleanup', async () => {
    const child = spawnHappyCLI([
      'claude',
      '--hapi-starting-mode', 'remote',
      '--started-by', 'terminal'
    ], {
      cwd: '/tmp',
      detached: true,
      stdio: 'ignore',
      env: buildTestChildEnv()
    });
    // Register immediately after spawn — cleanup must run even though this
    // test deliberately performs no per-test teardown of its own.
    trackChildProcess(child, 'regression-terminal');
    if (!child.pid) {
      throw new Error('Failed to spawn regression terminal hapi process');
    }

    // Give the detached child time to fully start (including its agent
    // probes), so a leak would be real and observable. Require the fixture to
    // actually be alive: if it exited on its own, the registry exit listener
    // would remove it and the dead assertion below would pass vacuously.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(
      isProcessAlive(child.pid),
      'regression fixture exited before cleanup — test is vacuous'
    ).toBe(true);

    // Simulate the failure path: only the spawn-time registered cleanup runs.
    await cleanupAllRegisteredProcesses()
    expect(
      isProcessAlive(child.pid),
      'registered detached child survived registry cleanup'
    ).toBe(false);
  });

  it('regression: final audit finds zero test-owned processes after the reaping regression test', async () => {
    // The runner from this test's beforeEach legitimately spawns model-catalog
    // probe children (agent --list-models / agent acp) at startup; stopping
    // it orphans them with the run marker. Reap first to clear that noise,
    // then INSPECT: anything still marked at this point is a genuine survivor
    // the reaper could not remove within its bounded window and must fail the
    // suite (same audit globalSetup teardown performs at the end of the run).
    // Killable leaks from the reaping regression test are already gone here:
    // its direct child is asserted dead in the test body, and its afterEach
    // sweep re-kills for its full bounded window.
    await stopRunnerBounded()
    await reapTestOwnedProcesses(testOwnedMarker())
    const leftovers = findTestOwnedProcesses(testOwnedMarker());
    expect(
      leftovers,
      'test-owned processes survived the bounded reaper — cleanup guarantee broken'
    ).toEqual([]);
  });

  // TODO: Add a test to see if a corrupted file will work
  
  // TODO: Test npm uninstall scenario - runner should gracefully handle when hapi is uninstalled
  // Current behavior: runner tries to spawn new runner on version mismatch but entrypoint is gone
  // Expected: runner should detect missing entrypoint and either exit cleanly or at minimum not respawn infinitely
});
