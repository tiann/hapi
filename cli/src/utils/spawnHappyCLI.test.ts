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
const originalVersionsDescriptor = Object.getOwnPropertyDescriptor(process, 'versions');

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true
  });
}

function setVersions(value: Record<string, string | undefined>) {
  Object.defineProperty(process, 'versions', {
    value,
    configurable: true
  });
}

function getSpawnCommandArgsOrThrow(): { command: string; args: string[]; options: SpawnOptions } {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const firstCall = spawnMock.mock.calls[0] as unknown[] | undefined;
  const command = firstCall?.[0] as string | undefined;
  const args = firstCall?.[1] as string[] | undefined;
  const options = firstCall?.[2] as SpawnOptions | undefined;
  if (!command || !args || !options) {
    throw new Error('Expected spawn(command, args, options) to be passed');
  }
  return { command, args, options };
}

describe('spawnHappyCLI windowsHide behavior', () => {
  beforeAll(() => {
    if (!originalPlatformDescriptor?.configurable) {
      throw new Error('process.platform is not configurable in this runtime');
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
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

    const { options } = getSpawnCommandArgsOrThrow();
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

    const { options } = getSpawnCommandArgsOrThrow();
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

    const { options } = getSpawnCommandArgsOrThrow();
    expect(options.detached).toBe(true);
    expect('windowsHide' in options).toBe(false);
  });
});

describe('spawnHappyCLI cwd propagation for bun runtime', () => {
  beforeAll(() => {
    if (!originalVersionsDescriptor?.configurable) {
      throw new Error('process.versions is not configurable in this runtime');
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (originalVersionsDescriptor) {
      Object.defineProperty(process, 'versions', originalVersionsDescriptor);
    }
  });

  it('uses caller provided cwd for bun --cwd when options.cwd is set', async () => {
    setVersions({ ...process.versions, bun: '1.3.5' });
    const { spawnHappyCLI } = await import('./spawnHappyCLI');

    spawnHappyCLI(['runner', 'start-sync'], {
      cwd: '/tmp/session-dir',
      stdio: 'ignore'
    });

    const { args } = getSpawnCommandArgsOrThrow();
    const cwdFlagIndex = args.indexOf('--cwd');
    expect(cwdFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[cwdFlagIndex + 1]).toBe('/tmp/session-dir');
  });
});
