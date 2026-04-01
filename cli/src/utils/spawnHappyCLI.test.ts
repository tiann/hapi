import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'child_process';

const spawnMock = vi.fn((..._args: any[]) => ({ pid: 12345 } as any));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: spawnMock
  };
});

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalInvokedCwd = process.env.HAPI_INVOKED_CWD;

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
    if (originalInvokedCwd === undefined) {
      delete process.env.HAPI_INVOKED_CWD;
    } else {
      process.env.HAPI_INVOKED_CWD = originalInvokedCwd;
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
      expect(command.args[1].replace(/\\/g, '/')).toMatch(/\/hapi\/cli$/);
      expect(command.args[2].replace(/\\/g, '/')).toMatch(/\/hapi\/cli\/src\/index\.ts$/);
    } else {
      expect(command.args.some((arg) => arg.replace(/\\/g, '/').endsWith('/hapi/cli/src/index.ts'))).toBe(true);
    }
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
