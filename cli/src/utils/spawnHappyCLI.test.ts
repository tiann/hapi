import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'child_process';

const {
  spawnMock,
  spawnSyncMock,
  existsSyncMock,
  isBunCompiledMock,
  projectPathMock,
  canDisclaimForChildrenMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn((..._args: any[]) => ({ pid: 12345 }) as any),
  spawnSyncMock: vi.fn((..._args: any[]) => ({ status: 0, stdout: '1048576\n' }) as any),
  existsSyncMock: vi.fn((path: string) => !path.includes('missing-hapi.exe')),
  isBunCompiledMock: vi.fn(() => false),
  projectPathMock: vi.fn(() => process.cwd()),
  canDisclaimForChildrenMock: vi.fn(() => false)
}));

vi.mock('@/runtime/responsibility', () => ({
  canDisclaimForChildren: canDisclaimForChildrenMock
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock
  };
});

vi.mock('@/projectPath', () => ({
  isBunCompiled: isBunCompiledMock,
  projectPath: projectPathMock
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalInvokedCwd = process.env.HAPI_INVOKED_CWD;
const originalCliExecutable = process.env.HAPI_CLI_EXECUTABLE;
const originalBunExec = process.env.HAPI_BUN_EXEC;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true
  });
}

function getSpawnOptionsOrThrow(): SpawnOptions {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const firstCall = spawnMock.mock.calls[0] as unknown[] | undefined;
  const options = firstCall?.[2] as SpawnOptions | undefined;
  if (!options) {
    throw new Error('Expected spawn options to be passed as third argument');
  }
  return options;
}

describe('spawnHappyCLI windowsHide behavior', () => {
  beforeAll(() => {
    if (!originalPlatformDescriptor?.configurable) {
      throw new Error('process.platform is not configurable in this runtime');
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    existsSyncMock.mockImplementation((path: string) => !path.includes('missing-hapi.exe'));
    isBunCompiledMock.mockReturnValue(false);
    projectPathMock.mockReturnValue(process.cwd());
    canDisclaimForChildrenMock.mockReturnValue(false);
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: '1048576\n' }) as any);
    if (originalInvokedCwd === undefined) {
      delete process.env.HAPI_INVOKED_CWD;
    } else {
      process.env.HAPI_INVOKED_CWD = originalInvokedCwd;
    }
    if (originalCliExecutable === undefined) {
      delete process.env.HAPI_CLI_EXECUTABLE;
    } else {
      process.env.HAPI_CLI_EXECUTABLE = originalCliExecutable;
    }
    if (originalBunExec === undefined) {
      delete process.env.HAPI_BUN_EXEC;
    } else {
      process.env.HAPI_BUN_EXEC = originalBunExec;
    }
  });

  afterAll(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('sets windowsHide=true when platform is win32 and detached=true', async () => {
    setPlatform('win32');
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['runner', 'start-sync'], {
      detached: true,
      stdio: 'ignore'
    });

    const options = getSpawnOptionsOrThrow();
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
  });

  it('does not set windowsHide when platform is win32 but detached is false', async () => {
    setPlatform('win32');
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['runner', 'start-sync'], {
      detached: false,
      stdio: 'ignore'
    });

    const options = getSpawnOptionsOrThrow();
    expect(options.detached).toBe(false);
    expect('windowsHide' in options).toBe(false);
  });

  it('does not set windowsHide on non-win32 even when detached=true', async () => {
    setPlatform('linux');
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['runner', 'start-sync'], {
      detached: true,
      stdio: 'ignore'
    });

    const options = getSpawnOptionsOrThrow();
    expect(options.detached).toBe(true);
    expect('windowsHide' in options).toBe(false);
  });

  describe('macOS responsibility disclaim', () => {
    const exe = '/Users/me/.local/bin/hapi-local';

    function spawnCall(): { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined } {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
      return { command, args, env: options.env };
    }

    beforeEach(() => {
      isBunCompiledMock.mockReturnValue(true);
      process.env.HAPI_CLI_EXECUTABLE = exe;
      existsSyncMock.mockImplementation(() => true);
      canDisclaimForChildrenMock.mockReturnValue(true);
    });

    afterEach(() => {
      delete process.env.HAPI_DISCLAIM_RESPONSIBILITY;
    });

    it('requests the disclaim for this spawner through the environment, leaving the command unchanged', async () => {
      setPlatform('darwin');
      const { spawnHappyCLI } = await import('./spawnHappyCLI');

      spawnHappyCLI(['claude', '--started-by', 'runner'], { detached: true, stdio: 'ignore' });

      const call = spawnCall();
      expect(call.command).toBe(exe);
      expect(call.args).toEqual(['claude', '--started-by', 'runner']);
      expect(call.env?.HAPI_DISCLAIM_RESPONSIBILITY).toBe(String(process.pid));
      expect(getSpawnOptionsOrThrow().detached).toBe(true);
    });

    it('does not request it when the spawner cannot hand its responsibility on (Terminal, SSH)', async () => {
      setPlatform('darwin');
      canDisclaimForChildrenMock.mockReturnValue(false);
      process.env.HAPI_DISCLAIM_RESPONSIBILITY = '1';
      const { spawnHappyCLI } = await import('./spawnHappyCLI');

      spawnHappyCLI(['runner', 'start-sync'], { detached: true, stdio: 'ignore' });

      const call = spawnCall();
      expect(call.args).toEqual(['runner', 'start-sync']);
      expect(call.env && 'HAPI_DISCLAIM_RESPONSIBILITY' in call.env).toBe(false);
    });

    it('does not request it for a non-detached darwin spawn', async () => {
      setPlatform('darwin');
      const { spawnHappyCLI } = await import('./spawnHappyCLI');

      spawnHappyCLI(['hub'], { detached: false, stdio: 'ignore' });

      const call = spawnCall();
      expect(call.args).toEqual(['hub']);
      expect(call.env && 'HAPI_DISCLAIM_RESPONSIBILITY' in call.env).toBe(false);
    });

    it.each(['linux', 'win32'])('does not request it for a detached %s spawn', async (platform) => {
      setPlatform(platform);
      const { spawnHappyCLI } = await import('./spawnHappyCLI');

      spawnHappyCLI(['runner', 'start-sync'], { detached: true, stdio: 'ignore' });

      const call = spawnCall();
      expect(call.args).toEqual(['runner', 'start-sync']);
      expect(call.env && 'HAPI_DISCLAIM_RESPONSIBILITY' in call.env).toBe(false);
    });
  });

  it('forces Bun child processes to run with the cli project root as cwd', async () => {
    // Clear the test-isolation override so we test the pure runtime behaviour
    delete process.env.HAPI_BUN_EXEC;
    const { getHappyCliCommand } = await import('./spawnHappyCLI');

    const command = getHappyCliCommand(['mcp', '--url', 'http://127.0.0.1:1234/']);
    const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);

    expect(command.command).toBe(process.execPath);
    if (isBunRuntime) {
      expect(command.args[0]).toBe('--cwd');
      expect(command.args[1].replace(/\\/g, '/')).toMatch(/\/cli$/);
      expect(command.args[2].replace(/\\/g, '/')).toMatch(/\/cli\/src\/index\.ts$/);
    } else {
      expect(command.args.some((arg) => arg.replace(/\\/g, '/').endsWith('/cli/src/index.ts'))).toBe(true);
    }
  });

  it('uses an inherited compiled CLI executable override when it points to an existing binary', async () => {
    isBunCompiledMock.mockReturnValue(true);
    process.env.HAPI_CLI_EXECUTABLE = 'C:\\Users\\Administrator\\.hapi\\patched\\hapi.exe';
    const { getHappyCliCommand, resolveHappyCliExecutable } = await import('./spawnHappyCLI');

    const command = getHappyCliCommand(['mcp', '--url', 'http://127.0.0.1:1234/']);

    expect(resolveHappyCliExecutable()).toBe(process.env.HAPI_CLI_EXECUTABLE);
    expect(command.command).toBe(process.env.HAPI_CLI_EXECUTABLE);
  });

  it('falls back to a real argv0 executable before process.execPath in compiled mode', async () => {
    isBunCompiledMock.mockReturnValue(true);
    const previousCliExecutable = process.env.HAPI_CLI_EXECUTABLE;
    delete process.env.HAPI_CLI_EXECUTABLE;
    const previousArgv0 = process.argv[0];
    process.argv[0] = 'C:\\Users\\Administrator\\.hapi\\patched\\resume-recovery-0.17.2\\hapi.exe';
    const { resolveHappyCliExecutable } = await import('./spawnHappyCLI');

    try {
      expect(resolveHappyCliExecutable()).toBe(process.argv[0]);
    } finally {
      process.argv[0] = previousArgv0;
      if (previousCliExecutable === undefined) {
        delete process.env.HAPI_CLI_EXECUTABLE;
      } else {
        process.env.HAPI_CLI_EXECUTABLE = previousCliExecutable;
      }
    }
  });

  it('ignores an inherited compiled CLI executable override when the binary is missing', async () => {
    isBunCompiledMock.mockReturnValue(true);
    process.env.HAPI_CLI_EXECUTABLE = 'C:\\Users\\Administrator\\.hapi\\patched\\missing-hapi.exe';
    const { getHappyCliCommand } = await import('./spawnHappyCLI');

    const command = getHappyCliCommand(['mcp', '--url', 'http://127.0.0.1:1234/']);

    expect(command.command).toBe(process.execPath);
  });

  it('passes the resolved compiled executable to child HAPI processes', async () => {
    isBunCompiledMock.mockReturnValue(true);
    process.env.HAPI_CLI_EXECUTABLE = 'C:\\Users\\Administrator\\.hapi\\patched\\hapi.exe';
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['mcp', '--url', 'http://127.0.0.1:1234/'], {
      stdio: 'ignore'
    });

    const [command, _args, options] = spawnMock.mock.calls[0] as unknown[] | undefined ?? [];
    expect(command).toBe(process.env.HAPI_CLI_EXECUTABLE);
    expect((options as SpawnOptions | undefined)?.env?.HAPI_CLI_EXECUTABLE).toBe(process.env.HAPI_CLI_EXECUTABLE);
  });

  it('passes invoked workspace cwd to child processes when cwd is provided', async () => {
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    const childCwd = 'C:\\workspace\\project';

    spawnHappyCLI(['runner', 'start-sync'], {
      cwd: childCwd,
      stdio: 'ignore'
    });

    const options = getSpawnOptionsOrThrow();
    expect(options.env?.HAPI_INVOKED_CWD).toBe(childCwd);
  });

  it('prefers the explicit child cwd over an inherited HAPI_INVOKED_CWD', async () => {
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    const inheritedInvokedCwd = 'C:\\workspace\\other-project';
    const childCwd = 'C:\\workspace\\project';

    spawnHappyCLI(['runner', 'start-sync'], {
      cwd: childCwd,
      env: {
        HAPI_INVOKED_CWD: inheritedInvokedCwd
      },
      stdio: 'ignore'
    });

    const options = getSpawnOptionsOrThrow();
    expect(options.env?.HAPI_INVOKED_CWD).toBe(childCwd);
  });

  it('keeps an existing absolute HAPI_INVOKED_CWD when no child cwd is provided', async () => {
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    const inheritedInvokedCwd = 'C:\\workspace\\other-project';

    spawnHappyCLI(['runner', 'start-sync'], {
      env: {
        HAPI_INVOKED_CWD: inheritedInvokedCwd
      },
      stdio: 'ignore'
    });

    const options = getSpawnOptionsOrThrow();
    expect(options.env?.HAPI_INVOKED_CWD).toBe(inheritedInvokedCwd);
  });
});

describe('applyNofileBump', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('wraps a low-soft-limit spawn in a ulimit-raising /bin/sh exec', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('/usr/local/bin/hapi', ['claude', '--started-by', 'runner'], {
      platform: 'darwin',
      softLimit: 10240
    });

    expect(result.command).toBe('/bin/sh');
    expect(result.args[0]).toBe('-c');
    expect(result.args[1]).toBe('ulimit -n 1048576 2>/dev/null; exec "$@"');
    // $0 placeholder so `exec "$@"` starts at the real command.
    expect(result.args[2]).toBe('sh');
    expect(result.args[3]).toBe('/usr/local/bin/hapi');
    expect(result.args.slice(4)).toEqual(['claude', '--started-by', 'runner']);
  });

  it('actually launches the wrapped command through /bin/sh (real exec, not mocked)', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const { applyNofileBump } = await import('./spawnHappyCLI');
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');

    const result = applyNofileBump('/bin/echo', ['launched-ok'], {
      platform: process.platform,
      softLimit: 10240
    });

    // Guards the shell-invocation shape: without `-c` sh treats the script
    // string as a file name (exit 127), and without the $0 placeholder
    // `exec "$@"` would drop the real command.
    const stdout = execFileSync(result.command, result.args, { encoding: 'utf8' });
    expect(stdout.trim()).toBe('launched-ok');
  });

  it('leaves the command unchanged when the soft limit is already comfortable', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('/usr/local/bin/hapi', ['claude'], {
      platform: 'darwin',
      softLimit: 1048576
    });

    expect(result).toEqual({ command: '/usr/local/bin/hapi', args: ['claude'] });
  });

  it('leaves the command unchanged when the soft limit is exactly at the threshold', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('/usr/local/bin/hapi', ['claude'], {
      platform: 'darwin',
      softLimit: 65536
    });

    expect(result).toEqual({ command: '/usr/local/bin/hapi', args: ['claude'] });
  });

  it('leaves the command unchanged on win32 regardless of the soft limit', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('C:\\hapi\\hapi.exe', ['claude'], {
      platform: 'win32',
      softLimit: 10240
    });

    expect(result).toEqual({ command: 'C:\\hapi\\hapi.exe', args: ['claude'] });
  });

  it('leaves the command unchanged when the soft limit cannot be determined', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('/usr/local/bin/hapi', ['claude'], {
      platform: 'darwin',
      softLimit: Number.NaN
    });

    expect(result).toEqual({ command: '/usr/local/bin/hapi', args: ['claude'] });
  });

  it('reads the inherited soft and hard limits via /bin/sh ulimit probes when not injected', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      (args?.[1] === 'ulimit -Sn'
        ? { status: 0, stdout: '10240\n' }
        : { status: 0, stdout: '1048576\n' }) as any
    );
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('/usr/local/bin/hapi', ['claude'], { platform: 'darwin' });

    expect(spawnSyncMock).toHaveBeenCalledWith('/bin/sh', ['-c', 'ulimit -Sn'], expect.anything());
    expect(spawnSyncMock).toHaveBeenCalledWith('/bin/sh', ['-c', 'ulimit -Hn'], expect.anything());
    expect(result.command).toBe('/bin/sh');
  });

  it('clamps the raise target to the inherited hard limit', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    // Non-root processes cannot raise the soft limit past the hard cap; a
    // fixed 1048576 target would fail with "Operation not permitted" and
    // silently leave the crashing low limit in place.
    const result = applyNofileBump('/usr/local/bin/hapi', ['claude'], {
      platform: 'darwin',
      softLimit: 10240,
      hardLimit: 65536
    });

    expect(result.command).toBe('/bin/sh');
    expect(result.args[1]).toBe('ulimit -n 65536 2>/dev/null; exec "$@"');
  });

  it('keeps the fixed target when the hard limit cannot be probed', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('/usr/local/bin/hapi', ['claude'], {
      platform: 'darwin',
      softLimit: 10240,
      hardLimit: Number.NaN
    });

    expect(result.command).toBe('/bin/sh');
    expect(result.args[1]).toBe('ulimit -n 1048576 2>/dev/null; exec "$@"');
  });

  it('does not wrap when the hard limit leaves no room to raise the soft limit', async () => {
    const { applyNofileBump } = await import('./spawnHappyCLI');

    const result = applyNofileBump('/usr/local/bin/hapi', ['claude'], {
      platform: 'darwin',
      softLimit: 10240,
      hardLimit: 10240
    });

    expect(result).toEqual({ command: '/usr/local/bin/hapi', args: ['claude'] });
  });

  it('does not wrap dev-mode spawns even when the soft limit is low', async () => {
    setPlatform('darwin');
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      (args?.[1] === 'ulimit -Sn'
        ? { status: 0, stdout: '10240\n' }
        : { status: 0, stdout: '1048576\n' }) as any
    );
    isBunCompiledMock.mockReturnValue(false);
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['runner', 'start-sync'], { stdio: 'ignore' });

    const [command] = spawnMock.mock.calls[0] as unknown[];
    expect(command).not.toBe('/bin/sh');
  });

  it('wraps compiled-mode spawns when the soft limit is low, keeping HAPI_CLI_EXECUTABLE on the real binary', async () => {
    setPlatform('darwin');
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      (args?.[1] === 'ulimit -Sn'
        ? { status: 0, stdout: '10240\n' }
        : { status: 0, stdout: '1048576\n' }) as any
    );
    isBunCompiledMock.mockReturnValue(true);
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['claude', '--started-by', 'runner'], { stdio: 'ignore' });

    const [command, args, options] = spawnMock.mock.calls[0] as unknown[];
    expect(command).toBe('/bin/sh');
    expect((args as string[]).slice(0, 3)).toEqual([
      '-c',
      'ulimit -n 1048576 2>/dev/null; exec "$@"',
      'sh'
    ]);
    const env = (options as SpawnOptions).env as Record<string, string | undefined>;
    expect(env?.HAPI_CLI_EXECUTABLE).not.toBe('/bin/sh');
    expect(typeof env?.HAPI_CLI_EXECUTABLE).toBe('string');
  });

  it('does not wrap compiled-mode spawns when the soft limit is comfortable', async () => {
    setPlatform('darwin');
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: '1048576\n' }) as any);
    isBunCompiledMock.mockReturnValue(true);
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['claude', '--started-by', 'runner'], { stdio: 'ignore' });

    const [command] = spawnMock.mock.calls[0] as unknown[];
    expect(command).not.toBe('/bin/sh');
  });
});
