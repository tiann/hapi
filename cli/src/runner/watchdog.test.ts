import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import { join } from 'node:path';

const {
  execFileMock,
  writeFileSyncMock,
  readFileSyncMock,
  mkdirSyncMock,
  chmodSyncMock,
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
    chmodSync: chmodSyncMock
  };
});

vi.mock('@/ui/logger', () => ({
  logger: { debug: loggerDebugMock }
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalWatchdogEnv = process.env.HAPI_RUNNER_WATCHDOG;
const originalHeartbeatIntervalEnv = process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL;

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
    expect(script).toContain("RUNNER_PATTERN='hapi runner start'");
    expect(script).toContain("LOG_PATH='/Users/tester/.hapi/logs/watchdog.log'");
    // darwin-first stat probe with a linux fallback
    expect(script).toContain('stat -f %m "$HEARTBEAT"');
    expect(script).toContain('stat -c %Y "$HEARTBEAT"');
    expect(script).toContain('[ "$age" -lt "$STALE_SECONDS" ]');
    expect(script).toContain('pgrep -f "$RUNNER_PATTERN"');
    expect(script).toContain('>> "$LOG_PATH"');
    expect(script).toContain('kill -9 "$pid"');
    // Exactly one victim per run: the first (oldest) pgrep hit.
    expect(script).toContain('head -n 1');
    // Missing heartbeat file means "never started" — nothing to watch.
    expect(script).toContain('[ ! -f "$HEARTBEAT" ]');
    // Destructive recovery is gated on the runner's own supervision claim
    // (heartbeat file line 2): an unsupervised runner is never killed.
    expect(script).toContain("sed -n '2p' \"$HEARTBEAT\"");
    expect(script).toContain('[ "$supervision" != "supervised" ]');
    expect(script).toContain('unsupervised; leaving recovery to the operator');
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

  it('honors a custom interval', async () => {
    const { buildWatchdogPlist } = await import('./watchdog');

    const plist = buildWatchdogPlist({ scriptPath: '/w.sh', intervalSeconds: 120 });

    expect(plist).toContain('<integer>120</integer>');
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
  });

  it('returns disabled and touches nothing when HAPI_RUNNER_WATCHDOG=0', async () => {
    setPlatform('darwin');
    process.env.HAPI_RUNNER_WATCHDOG = '0';
    const { ensureWatchdogInstalled } = await import('./watchdog');

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
    expect(String(scriptContent)).toContain("RUNNER_PATTERN='hapi runner start'");
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

  it('skips rewriting files whose content is unchanged', async () => {
    setPlatform('darwin');
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
    process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL = '300000';
    const { ensureWatchdogInstalled } = await import('./watchdog');

    await ensureWatchdogInstalled();

    const [, scriptContent] = writeFileSyncMock.mock.calls[0] as unknown[];
    // 300s interval + 300s grace: never kill a healthy (just slow) runner.
    expect(String(scriptContent)).toContain('STALE_SECONDS=600');
  });

  it('reports skipped when launchctl bootstrap fails, without throwing', async () => {
    setPlatform('darwin');
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
    writeFileSyncMock.mockImplementation(((path: unknown, data: unknown) => {
      written.push({ path: String(path), data: String(data) });
    }) as any);
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

  it('writes the timestamp plus an unsupervised claim by default', async () => {
    delete process.env.HAPI_RUNNER_SUPERVISED;
    const { touchRunnerHeartbeat } = await import('./watchdog');

    touchRunnerHeartbeat(1_700_000_000_000);

    expect(written[0].path).toBe(heartbeatPath);
    expect(written[0].data).toBe('1700000000000\nunsupervised\n');
  });

  it('writes the supervised claim when HAPI_RUNNER_SUPERVISED=1', async () => {
    process.env.HAPI_RUNNER_SUPERVISED = '1';
    const { touchRunnerHeartbeat } = await import('./watchdog');

    touchRunnerHeartbeat(1_700_000_000_001);

    expect(written[0].data).toBe('1700000000001\nsupervised\n');
  });

  it('rewrites the claim on every tick so a later unsupervised runner clears a stale marker', async () => {
    process.env.HAPI_RUNNER_SUPERVISED = '1';
    const { touchRunnerHeartbeat } = await import('./watchdog');
    touchRunnerHeartbeat(1);
    delete process.env.HAPI_RUNNER_SUPERVISED;
    touchRunnerHeartbeat(2);
    expect(written[1].data).toBe('2\nunsupervised\n');
  });
});

afterAll(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});
