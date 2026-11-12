import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import { join } from 'node:path';

const {
  execFileMock,
  writeFileSyncMock,
  readFileSyncMock,
  mkdirSyncMock,
  chmodSyncMock,
  rmSyncMock,
  loggerDebugMock
} = vi.hoisted(() => ({
  // Default implementation invokes the callback so `runLaunchctl` resolves.
  execFileMock: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      (callback as (error: Error | null, result?: unknown) => void)(null, { stdout: '', stderr: '' });
    }
    return undefined;
  }),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(() => {
    throw new Error('ENOENT (default mock)');
  }),
  mkdirSyncMock: vi.fn(),
  chmodSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  loggerDebugMock: vi.fn()
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: execFileMock
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    mkdirSync: mkdirSyncMock,
    chmodSync: chmodSyncMock,
    rmSync: rmSyncMock
  };
});

vi.mock('@/ui/logger', () => ({
  logger: { debug: loggerDebugMock }
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalWatchdogEnv = process.env.HAPI_RUNNER_WATCHDOG;
const originalHeartbeatIntervalEnv = process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL;
// The vitest worker sets HAPI_HOME globally (test/setup.ts); every test here
// must control it explicitly because all watchdog state is scoped to it.
const originalHapiHomeEnv = process.env.HAPI_HOME;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true
  });
}

describe('buildWatchdogScript', () => {
  it('embeds the stat probe branches, threshold, pgrep pattern, log append and kill -9', async () => {
    const { buildWatchdogScript } = await import('./watchdog');

    const script = buildWatchdogScript({
      heartbeatPath: '/Users/tester/.hapi/runner-heartbeat',
      logPath: '/Users/tester/.hapi/logs/watchdog.log'
    });

    expect(script).toContain('set -u');
    expect(script).toContain("HEARTBEAT='/Users/tester/.hapi/runner-heartbeat'");
    expect(script).toContain('STALE_SECONDS=300');
    expect(script).toContain("RUNNER_PATTERN='(hapi|index\\.ts) runner start'");
    expect(script).toContain("LOG_PATH='/Users/tester/.hapi/logs/watchdog.log'");
    // darwin-first stat probe with a linux fallback
    expect(script).toContain('stat -f %m "$HEARTBEAT"');
    expect(script).toContain('stat -c %Y "$HEARTBEAT"');
    expect(script).toContain('[ "$age" -lt "$STALE_SECONDS" ]');
    expect(script).toContain('pgrep -f "$RUNNER_PATTERN"');
    expect(script).toContain('>> "$LOG_PATH"');
    expect(script).toContain('kill -9 "$pid"');
    // Missing heartbeat file means "never started" — nothing to watch.
    expect(script).toContain('[ ! -f "$HEARTBEAT" ]');
    // Destructive recovery is gated on the runner's own supervision claim
    // (heartbeat file line 2): an unsupervised runner is never killed.
    expect(script).toContain("sed -n '2p' \"$HEARTBEAT\"");
    expect(script).toContain('[ "$supervision" != "supervised" ]');
    expect(script).toContain('unsupervised; leaving recovery to the operator');
  });

  it('selects the kill victim exclusively from the heartbeat pid claim', async () => {
    const { buildWatchdogScript } = await import('./watchdog');

    const script = buildWatchdogScript({
      heartbeatPath: '/hb',
      logPath: '/log'
    });

    // Victim identity comes from the heartbeat's third line (the pid of the
    // runner instance that owns THIS heartbeat file)…
    expect(script).toContain("pid=$(sed -n '3p' \"$HEARTBEAT\"");
    // …and must still match the runner pattern in the live process table,
    // so a pid reused by an unrelated process is never killed.
    expect(script).toContain('grep -Fx "$pid"');
    // Never substitute a guess: an unknown/exited/reused pid means skip.
    expect(script).toContain('[ -z "$pid" ]');
    // The pre-scoping "kill the oldest pgrep hit" heuristic must be gone —
    // on a multi-instance machine it kills the wrong runner.
    expect(script).not.toContain('head -n 1');
  });

  it('verifies the recorded process generation before killing the pid claim', async () => {
    const { buildWatchdogScript } = await import('./watchdog');

    const script = buildWatchdogScript({
      heartbeatPath: '/hb',
      logPath: '/log'
    });

    // The heartbeat's fourth line records the pid's start time; the script
    // re-queries it with the same LC_ALL/TZ pinning (and whitespace
    // trimming) the runner-side marker uses, so a recycled pid — whose
    // current start time differs — is never killed.
    expect(script).toContain("sed -n '4p' \"$HEARTBEAT\"");
    expect(script).toContain('LC_ALL=C TZ=UTC ps -p "$pid" -o lstart=');
    expect(script).toContain('[ "$actual_start" != "$recorded_start" ]');
    expect(script).toContain('(pid reuse); not killing');
  });

  it('narrows the legacy fallback to a unique pgrep candidate', async () => {
    const { buildWatchdogScript } = await import('./watchdog');

    const legacy = buildWatchdogScript({
      heartbeatPath: '/hb',
      logPath: '/log',
      legacyHeartbeatVictimFallback: true
    });

    // The legacy branch is the fallback for heartbeats WITHOUT a pid line
    // (pre per-instance-scoping writers) only, and it may act only when
    // pgrep proves the single-instance premise: exactly one candidate.
    // Several candidates (another HAPI_HOME's runner, a lock-less
    // source-checkout launch) cannot be attributed to a pid-less
    // heartbeat — log and skip, never guess.
    expect(legacy).toContain('| grep -c .');
    expect(legacy).toContain('[ "$candidate_count" -ne 1 ]');
    expect(legacy).toContain('cannot tell which one owns the legacy heartbeat, not killing');
    // The sole surviving candidate becomes the victim…
    expect(legacy).toContain('| head -n 1');
    // …while a heartbeat that does carry a pid claim still gets exact
    // victim selection plus the generation check.
    expect(legacy).toContain("pid=$(sed -n '3p' \"$HEARTBEAT\"");
    expect(legacy).toContain('LC_ALL=C TZ=UTC ps -p "$pid" -o lstart=');
  });

  it('matches both compiled and source-checkout launch shapes, nothing wider', async () => {
    const { WATCHDOG_RUNNER_PATTERN } = await import('./watchdog');

    // A runner launched from a source checkout (`bun …/index.ts runner
    // start`) used to be invisible to the bare `hapi runner start`
    // pattern, silently disarming the watchdog for it. The fix is a
    // narrow union; these checks lock its ERE semantics (the script tests
    // additionally prove it against the host's real pgrep).
    expect(WATCHDOG_RUNNER_PATTERN).toBe('(hapi|index\\.ts) runner start');
    const pattern = new RegExp(WATCHDOG_RUNNER_PATTERN);
    expect(pattern.test('hapi runner start')).toBe(true);
    expect(pattern.test('/usr/local/bin/hapi runner start --workspace-root /w')).toBe(true);
    expect(pattern.test('bun /Users/x/repo/hapi/cli/src/index.ts runner start')).toBe(true);
    expect(pattern.test('bun run /repo/hapi/cli/src/index.ts runner start')).toBe(true);
    // Not so wide that arbitrary "runner start" processes match…
    expect(pattern.test('mything runner start')).toBe(false);
    expect(pattern.test('runner start')).toBe(false);
    // …and the watchdog script itself never matches its own pattern.
    expect(pattern.test('/bin/bash /Users/x/.hapi/watchdog.sh')).toBe(false);
  });

  it('honors custom staleSeconds and runnerPattern', async () => {
    const { buildWatchdogScript } = await import('./watchdog');

    const script = buildWatchdogScript({
      heartbeatPath: '/hb',
      logPath: '/log',
      staleSeconds: 120,
      runnerPattern: 'hapi runner start-sync'
    });

    expect(script).toContain('STALE_SECONDS=120');
    expect(script).toContain("RUNNER_PATTERN='hapi runner start-sync'");
  });

  it('single-quotes interpolated paths so spaces cannot break the script', async () => {
    const { buildWatchdogScript } = await import('./watchdog');

    const script = buildWatchdogScript({
      heartbeatPath: "/Users/space user/.hapi/runner-heartbeat",
      logPath: "/Users/space user/.hapi/logs/watchdog.log"
    });

    expect(script).toContain("HEARTBEAT='/Users/space user/.hapi/runner-heartbeat'");
    expect(script).toContain("LOG_PATH='/Users/space user/.hapi/logs/watchdog.log'");
  });

  it('stamps the generating instance label into the header comment', async () => {
    const { buildWatchdogScript } = await import('./watchdog');

    const script = buildWatchdogScript({
      heartbeatPath: '/hb',
      logPath: '/log',
      label: 'com.hapi.watchdog-deadbeef'
    });

    expect(script).toContain('# Generated by hapi (com.hapi.watchdog-deadbeef) — do not edit.');
  });
});

describe('buildWatchdogPlist', () => {
  it('renders the LaunchAgent with bash, the script path and a 60s interval', async () => {
    const { buildWatchdogPlist } = await import('./watchdog');

    const plist = buildWatchdogPlist({ scriptPath: '/Users/tester/.hapi/watchdog.sh' });

    expect(plist).toContain('<string>com.hapi.watchdog</string>');
    expect(plist).toContain('<string>/bin/bash</string>');
    expect(plist).toContain('<string>/Users/tester/.hapi/watchdog.sh</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>60</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
  });

  it('renders a custom per-instance label', async () => {
    const { buildWatchdogPlist } = await import('./watchdog');

    const plist = buildWatchdogPlist({ scriptPath: '/w.sh', label: 'com.hapi.watchdog-1a2b3c4d' });

    expect(plist).toContain('<string>com.hapi.watchdog-1a2b3c4d</string>');
  });

  it('honors a custom interval', async () => {
    const { buildWatchdogPlist } = await import('./watchdog');

    const plist = buildWatchdogPlist({ scriptPath: '/w.sh', intervalSeconds: 120 });

    expect(plist).toContain('<integer>120</integer>');
  });
});

describe('per-instance scoping', () => {
  afterEach(() => {
    if (originalHapiHomeEnv === undefined) {
      delete process.env.HAPI_HOME;
    } else {
      process.env.HAPI_HOME = originalHapiHomeEnv;
    }
  });

  it('keeps the historical default paths and label when HAPI_HOME is unset', async () => {
    delete process.env.HAPI_HOME;
    const { runnerHeartbeatPath, watchdogLabel, watchdogInstanceSuffix } = await import('./watchdog');

    expect(runnerHeartbeatPath()).toBe(join(os.homedir(), '.hapi', 'runner-heartbeat'));
    expect(watchdogInstanceSuffix()).toBe('');
    expect(watchdogLabel()).toBe('com.hapi.watchdog');
  });

  it('scopes the heartbeat path and launchd label to a custom HAPI_HOME', async () => {
    process.env.HAPI_HOME = '/srv/hapi-instance-b';
    const { runnerHeartbeatPath, watchdogLabel, watchdogInstanceSuffix } = await import('./watchdog');

    expect(runnerHeartbeatPath()).toBe('/srv/hapi-instance-b/runner-heartbeat');
    const suffix = watchdogInstanceSuffix();
    expect(suffix).toMatch(/^-[0-9a-f]{8}$/);
    expect(watchdogLabel()).toBe(`com.hapi.watchdog${suffix}`);
  });

  it('derives a stable suffix that differs between homes and ignores ~ spelling', async () => {
    const { watchdogInstanceSuffix } = await import('./watchdog');
    const suffixFor = (home: string) => watchdogInstanceSuffix({ HAPI_HOME: home });

    const suffixA = suffixFor('/srv/hapi-a');
    expect(suffixFor('/srv/hapi-a')).toBe(suffixA);
    expect(suffixFor('/srv/hapi-b')).not.toBe(suffixA);
    // `~` expands to the real home dir, so both spellings are one instance.
    expect(suffixFor('~/instances/a')).toBe(suffixFor(join(os.homedir(), 'instances/a')));
  });
});

describe('ensureWatchdogInstalled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        (callback as (error: Error | null, result?: unknown) => void)(null, { stdout: '', stderr: '' });
      }
      return undefined;
    });
    if (originalWatchdogEnv === undefined) {
      delete process.env.HAPI_RUNNER_WATCHDOG;
    } else {
      process.env.HAPI_RUNNER_WATCHDOG = originalWatchdogEnv;
    }
    if (originalHeartbeatIntervalEnv === undefined) {
      delete process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL;
    } else {
      process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL = originalHeartbeatIntervalEnv;
    }
    if (originalHapiHomeEnv === undefined) {
      delete process.env.HAPI_HOME;
    } else {
      process.env.HAPI_HOME = originalHapiHomeEnv;
    }
  });

  afterAll(() => {
    if (originalWatchdogEnv === undefined) {
      delete process.env.HAPI_RUNNER_WATCHDOG;
    } else {
      process.env.HAPI_RUNNER_WATCHDOG = originalWatchdogEnv;
    }
    if (originalHeartbeatIntervalEnv === undefined) {
      delete process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL;
    } else {
      process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL = originalHeartbeatIntervalEnv;
    }
    if (originalHapiHomeEnv === undefined) {
      delete process.env.HAPI_HOME;
    } else {
      process.env.HAPI_HOME = originalHapiHomeEnv;
    }
  });

  it('returns disabled and touches nothing when HAPI_RUNNER_WATCHDOG=0', async () => {
    setPlatform('darwin');
    process.env.HAPI_RUNNER_WATCHDOG = '0';
    const { ensureWatchdogInstalled } = await import('./watchdog');
    // Importing the module graph constructs the configuration singleton,
    // which mkdirs its logs dir once — not part of what this test guards.
    vi.clearAllMocks();

    const result = await ensureWatchdogInstalled();

    expect(result).toBe('disabled');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });

  it('returns skipped on non-darwin platforms without installing anything', async () => {
    setPlatform('linux');
    const { ensureWatchdogInstalled } = await import('./watchdog');

    const result = await ensureWatchdogInstalled();

    expect(result).toBe('skipped');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(loggerDebugMock).toHaveBeenCalledWith(expect.stringContaining('Skipped on platform linux'));
  });

  it('writes script and plist, chmods 755 and bootstraps the LaunchAgent on darwin', async () => {
    setPlatform('darwin');
    delete process.env.HAPI_HOME;
    const { ensureWatchdogInstalled } = await import('./watchdog');

    const result = await ensureWatchdogInstalled();

    expect(result).toBe('installed');
    const home = os.homedir();
    const scriptPath = join(home, '.hapi', 'watchdog.sh');
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.hapi.watchdog.plist');

    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
    const [scriptFile, scriptContent] = writeFileSyncMock.mock.calls[0] as unknown[];
    expect(scriptFile).toBe(scriptPath);
    expect(String(scriptContent)).toContain('STALE_SECONDS=300');
    expect(String(scriptContent)).toContain("RUNNER_PATTERN='(hapi|index\\.ts) runner start'");
    // The default-home runner owns its script: strict pid-exact victim
    // selection, no legacy oldest-pgrep fallback.
    expect(String(scriptContent)).not.toContain('head -n 1');
    expect(chmodSyncMock).toHaveBeenCalledWith(scriptPath, 0o755);

    const [plistFile, plistContent] = writeFileSyncMock.mock.calls[1] as unknown[];
    expect(plistFile).toBe(plistPath);
    expect(String(plistContent)).toContain('<integer>60</integer>');
    expect(String(plistContent)).toContain(scriptPath);

    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][0]).toBe('launchctl');
    expect(execFileMock.mock.calls[0][1]).toEqual(['bootout', `gui/${uid}`, plistPath]);
    expect(execFileMock.mock.calls[1][1]).toEqual(['bootstrap', `gui/${uid}`, plistPath]);
  });

  it('installs per-instance script, label and heartbeat when HAPI_HOME is set', async () => {
    setPlatform('darwin');
    const instanceHome = '/srv/hapi-instance-b';
    process.env.HAPI_HOME = instanceHome;
    const { ensureWatchdogInstalled, watchdogLabel, runnerHeartbeatPath } = await import('./watchdog');

    const result = await ensureWatchdogInstalled();

    expect(result).toBe('installed');
    const scriptPath = join(instanceHome, 'watchdog.sh');
    const plistPath = join(os.homedir(), 'Library', 'LaunchAgents', `${watchdogLabel()}.plist`);

    expect(writeFileSyncMock).toHaveBeenCalledTimes(3);
    const [scriptFile, scriptContent] = writeFileSyncMock.mock.calls[0] as unknown[];
    expect(scriptFile).toBe(scriptPath);
    expect(String(scriptContent)).toContain(`HEARTBEAT='${runnerHeartbeatPath()}'`);
    // A home owned by a current runner keeps strict pid-exact victim
    // selection — the legacy fallback must not leak into it.
    expect(String(scriptContent)).not.toContain('head -n 1');
    expect(chmodSyncMock).toHaveBeenCalledWith(scriptPath, 0o755);

    // Upgrade transition: the pre-scoping default-home script (whose
    // pgrep-oldest victim could kill this instance) is rewritten in the
    // pid-exact form, keeping the historical oldest-pgrep victim as a
    // fallback so a still-running old runner (heartbeat without a pid
    // line) stays protected instead of silently disarmed.
    const [defaultScriptFile, defaultScriptContent] = writeFileSyncMock.mock.calls[1] as unknown[];
    expect(defaultScriptFile).toBe(join(os.homedir(), '.hapi', 'watchdog.sh'));
    expect(String(defaultScriptContent)).toContain(`HEARTBEAT='${join(os.homedir(), '.hapi', 'runner-heartbeat')}'`);
    expect(String(defaultScriptContent)).toContain("pid=$(sed -n '3p' \"$HEARTBEAT\"");
    expect(String(defaultScriptContent)).toContain('| head -n 1');
    // No default-home script is installed (ENOENT): the default 300s
    // threshold applies — this instance's env does not leak into a home it
    // does not own.
    expect(String(defaultScriptContent)).toContain('STALE_SECONDS=300');

    const [plistFile, plistContent] = writeFileSyncMock.mock.calls[2] as unknown[];
    expect(plistFile).toBe(plistPath);
    expect(String(plistContent)).toContain(`<string>${watchdogLabel()}</string>`);
    expect(String(plistContent)).toContain(scriptPath);
    expect(chmodSyncMock).toHaveBeenCalledWith(join(os.homedir(), '.hapi', 'watchdog.sh'), 0o755);
  });

  it('preserves the default home\'s installed stale threshold in the transition rewrite', async () => {
    setPlatform('darwin');
    process.env.HAPI_HOME = '/srv/hapi-instance-b';
    // THIS instance slowed its own heartbeat cadence, widening its own
    // stale window…
    process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL = '300000';
    const defaultScriptPath = join(os.homedir(), '.hapi', 'watchdog.sh');
    readFileSyncMock.mockImplementation(((path: unknown) => {
      // …while the default home's runner installed its own (different)
      // widened threshold long ago.
      if (String(path) === defaultScriptPath) {
        return '#!/bin/bash\n# Generated by hapi (com.hapi.watchdog) — do not edit.\nset -u\n\nSTALE_SECONDS=900\nHEARTBEAT=/old\n';
      }
      throw new Error('ENOENT');
    }) as any);
    const { ensureWatchdogInstalled } = await import('./watchdog');

    const result = await ensureWatchdogInstalled();

    expect(result).toBe('installed');
    const [ownScriptFile, ownScriptContent] = writeFileSyncMock.mock.calls[0] as unknown[];
    expect(String(ownScriptFile)).toBe('/srv/hapi-instance-b/watchdog.sh');
    expect(String(ownScriptContent)).toContain('STALE_SECONDS=600');
    const [defaultScriptFile, defaultScriptContent] = writeFileSyncMock.mock.calls[1] as unknown[];
    expect(String(defaultScriptFile)).toBe(defaultScriptPath);
    // The default home keeps ITS threshold: importing this instance's
    // 600s window could stretch the default home's protection, and
    // importing an unconfigured 300s could kill-loop its slow-but-healthy
    // runner.
    expect(String(defaultScriptContent)).toContain('STALE_SECONDS=900');
    expect(String(defaultScriptContent)).not.toContain('STALE_SECONDS=600');
  });

  it('falls back to the default threshold for the transition rewrite when no default script exists', async () => {
    setPlatform('darwin');
    process.env.HAPI_HOME = '/srv/hapi-instance-b';
    process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL = '300000';
    const { ensureWatchdogInstalled } = await import('./watchdog');

    await ensureWatchdogInstalled();

    const [, ownScriptContent] = writeFileSyncMock.mock.calls[0] as unknown[];
    expect(String(ownScriptContent)).toContain('STALE_SECONDS=600');
    const [, defaultScriptContent] = writeFileSyncMock.mock.calls[1] as unknown[];
    // No readable default-home script: the standard 300s window — never
    // this instance's widened one.
    expect(String(defaultScriptContent)).toContain('STALE_SECONDS=300');
    expect(String(defaultScriptContent)).not.toContain('STALE_SECONDS=600');
  });

  it('skips rewriting files whose content is unchanged', async () => {
    setPlatform('darwin');
    delete process.env.HAPI_HOME;
    const home = os.homedir();
    const scriptPath = join(home, '.hapi', 'watchdog.sh');
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.hapi.watchdog.plist');
    const { ensureWatchdogInstalled, buildWatchdogScript, buildWatchdogPlist } = await import('./watchdog');
    const expectedScript = buildWatchdogScript({
      heartbeatPath: join(home, '.hapi', 'runner-heartbeat'),
      logPath: join(home, '.hapi', 'logs', 'watchdog.log')
    });
    const expectedPlist = buildWatchdogPlist({ scriptPath });
    readFileSyncMock.mockImplementation(((path: unknown) => {
      const value = String(path);
      if (value === scriptPath) {
        return expectedScript;
      }
      if (value === plistPath) {
        return expectedPlist;
      }
      throw new Error('ENOENT');
    }) as any);

    const result = await ensureWatchdogInstalled();

    expect(result).toBe('installed');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(chmodSyncMock).toHaveBeenCalledWith(scriptPath, 0o755);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('widens the stale window when the runner heartbeat interval is slowed past the default cadence', async () => {
    setPlatform('darwin');
    delete process.env.HAPI_HOME;
    process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL = '300000';
    const { ensureWatchdogInstalled } = await import('./watchdog');

    await ensureWatchdogInstalled();

    const [, scriptContent] = writeFileSyncMock.mock.calls[0] as unknown[];
    // 300s interval + 300s grace: never kill a healthy (just slow) runner.
    expect(String(scriptContent)).toContain('STALE_SECONDS=600');
  });

  it('reports skipped when launchctl bootstrap fails, without throwing', async () => {
    setPlatform('darwin');
    delete process.env.HAPI_HOME;
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        (callback as (error: Error | null, result?: unknown) => void)(new Error('Bootstrap failed'));
      }
      return undefined;
    });
    const { ensureWatchdogInstalled } = await import('./watchdog');

    const result = await ensureWatchdogInstalled();

    expect(result).toBe('skipped');
    expect(loggerDebugMock).toHaveBeenCalledWith(
      expect.stringContaining('bootstrap did not report success')
    );
  });
});

describe('touchRunnerHeartbeat supervision claim', () => {
  const realWriteFileSync = vi.importActual<typeof import('node:fs')>('node:fs') as unknown as { writeFileSync: (p: string, d: string) => void };
  const originalSupervisedEnv = process.env.HAPI_RUNNER_SUPERVISED;
  const heartbeatPath = join(os.homedir(), '.hapi', 'runner-heartbeat');
  const written: Array<{ path: string; data: string }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    written.length = 0;
    delete process.env.HAPI_HOME;
    writeFileSyncMock.mockImplementation(((path: unknown, data: unknown) => {
      written.push({ path: String(path), data: String(data) });
    }) as any);
  });

  afterEach(() => {
    if (originalHapiHomeEnv === undefined) {
      delete process.env.HAPI_HOME;
    } else {
      process.env.HAPI_HOME = originalHapiHomeEnv;
    }
  });

  afterAll(() => {
    if (originalSupervisedEnv === undefined) {
      delete process.env.HAPI_RUNNER_SUPERVISED;
    } else {
      process.env.HAPI_RUNNER_SUPERVISED = originalSupervisedEnv;
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('writes the timestamp, an unsupervised claim, the pid and the generation marker', async () => {
    delete process.env.HAPI_RUNNER_SUPERVISED;
    const { touchRunnerHeartbeat } = await import('./watchdog');

    touchRunnerHeartbeat(1_700_000_000_000, false, 4242, 'Mon Nov  3 09:12:34 2026');

    expect(written[0].path).toBe(heartbeatPath);
    expect(written[0].data).toBe('1700000000000\nunsupervised\n4242\nMon Nov  3 09:12:34 2026\n');
  });

  it('writes an empty generation marker when the start time is unknown', async () => {
    const { touchRunnerHeartbeat } = await import('./watchdog');

    touchRunnerHeartbeat(1_700_000_000_000, false, 4242, null);

    expect(written[0].data).toBe('1700000000000\nunsupervised\n4242\n\n');
  });

  it('derives the generation marker from the live process when not given', async () => {
    const { touchRunnerHeartbeat } = await import('./watchdog');

    touchRunnerHeartbeat(5, true);

    // Fourth line: the ps lstart marker, or empty when unavailable — either
    // way the four-line shape is stable for the watchdog script to parse.
    expect(written[0].data).toMatch(/^5\nsupervised\n\d+\n.*\n$/);
  });

  it('writes the supervised claim when HAPI_RUNNER_SUPERVISED=1', async () => {
    process.env.HAPI_RUNNER_SUPERVISED = '1';
    const { touchRunnerHeartbeat } = await import('./watchdog');

    touchRunnerHeartbeat(1_700_000_000_001, true, 4243, 'Mon Nov  3 09:12:34 2026');

    expect(written[0].data).toBe('1700000000001\nsupervised\n4243\nMon Nov  3 09:12:34 2026\n');
  });

  it('rewrites the claim on every tick so a later unsupervised runner clears a stale marker', async () => {
    process.env.HAPI_RUNNER_SUPERVISED = '1';
    const { touchRunnerHeartbeat } = await import('./watchdog');
    touchRunnerHeartbeat(1, true, 7, null);
    delete process.env.HAPI_RUNNER_SUPERVISED;
    touchRunnerHeartbeat(2, false, 8, null);
    expect(written[1].data).toBe('2\nunsupervised\n8\n\n');
  });

  it('writes the heartbeat into a custom HAPI_HOME so instances stay isolated', async () => {
    process.env.HAPI_HOME = '/srv/hapi-instance-b';
    const { touchRunnerHeartbeat } = await import('./watchdog');

    touchRunnerHeartbeat(1_700_000_000_002, true, 99, 'Tue Nov 10 08:00:00 2026');

    expect(written[0].path).toBe('/srv/hapi-instance-b/runner-heartbeat');
    expect(written[0].data).toBe('1700000000002\nsupervised\n99\nTue Nov 10 08:00:00 2026\n');
  });
});

describe('clearRunnerHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPI_HOME;
  });

  afterEach(() => {
    if (originalHapiHomeEnv === undefined) {
      delete process.env.HAPI_HOME;
    } else {
      process.env.HAPI_HOME = originalHapiHomeEnv;
    }
  });

  it('removes the heartbeat file best-effort with force', async () => {
    const { clearRunnerHeartbeat } = await import('./watchdog');

    clearRunnerHeartbeat();

    expect(rmSyncMock).toHaveBeenCalledWith(join(os.homedir(), '.hapi', 'runner-heartbeat'), { force: true });
  });

  it('targets the custom HAPI_HOME heartbeat', async () => {
    process.env.HAPI_HOME = '/srv/hapi-instance-b';
    const { clearRunnerHeartbeat } = await import('./watchdog');

    clearRunnerHeartbeat();

    expect(rmSyncMock).toHaveBeenCalledWith('/srv/hapi-instance-b/runner-heartbeat', { force: true });
  });
});

afterAll(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});
