import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'child_process';

const {
  spawnMock,
  existsSyncMock,
  isBunCompiledMock,
  projectPathMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn((..._args: any[]) => ({ pid: 12345 }) as any),
  existsSyncMock: vi.fn((path: string) => !path.includes('missing-hapi.exe')),
  isBunCompiledMock: vi.fn(() => false),
  projectPathMock: vi.fn(() => process.cwd())
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: spawnMock
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

  it('forces Bun child processes to run with the cli project root as cwd', async () => {
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
    const previousArgv0 = process.argv[0];
    process.argv[0] = 'C:\\Users\\Administrator\\.hapi\\patched\\resume-recovery-0.17.2\\hapi.exe';
    const { resolveHappyCliExecutable } = await import('./spawnHappyCLI');

    try {
      expect(resolveHappyCliExecutable()).toBe(process.argv[0]);
    } finally {
      process.argv[0] = previousArgv0;
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
