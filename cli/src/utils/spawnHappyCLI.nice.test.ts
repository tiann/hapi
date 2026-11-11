import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn((): unknown => ({ pid: 4242 })));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { resolveAgentNiceLevel } from './spawnHappyCLI';

describe('resolveAgentNiceLevel', () => {
  it('defaults to 15 when unset', () => {
    expect(resolveAgentNiceLevel(undefined)).toBe(15);
    expect(resolveAgentNiceLevel('')).toBe(15);
    expect(resolveAgentNiceLevel('  ')).toBe(15);
  });

  it('parses explicit levels and clamps nonsense back to the default', () => {
    expect(resolveAgentNiceLevel('5')).toBe(5);
    expect(resolveAgentNiceLevel('30')).toBe(30);
    expect(resolveAgentNiceLevel('-3')).toBe(15);
    expect(resolveAgentNiceLevel('abc')).toBe(15);
  });

  it("returns null for '0' (opt-out)", () => {
    expect(resolveAgentNiceLevel('0')).toBeNull();
  });
});

describe('spawnHappyCLI nice demotion', () => {
  const originalPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  beforeEach(() => {
    spawnMock.mockClear();
    delete process.env['HAPI_AGENT_NICE'];
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('prefixes /usr/bin/nice -n 15 on unix when lowerPriority is set', async () => {
    setPlatform('darwin');
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    spawnHappyCLI(['claude', '--version'], { lowerPriority: true });
    const [command, args] = spawnMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(command).toBe('/usr/bin/nice');
    expect((args as string[]).slice(0, 3)).toEqual(['-n', '15', expect.any(String)]);
  });

  it('keeps the command line untouched without lowerPriority', async () => {
    setPlatform('darwin');
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    spawnHappyCLI(['claude', '--version'], {});
    const [command] = spawnMock.mock.calls[0] as unknown as [string];
    expect(command).not.toBe('/usr/bin/nice');
  });

  it('honours HAPI_AGENT_NICE=0 as a disable switch', async () => {
    setPlatform('linux');
    process.env['HAPI_AGENT_NICE'] = '0';
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    spawnHappyCLI(['claude', '--version'], { lowerPriority: true });
    const [command] = spawnMock.mock.calls[0] as unknown as [string];
    expect(command).not.toBe('/usr/bin/nice');
  });

  it('ignores the demotion on windows', async () => {
    setPlatform('win32');
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    spawnHappyCLI(['claude', '--version'], { lowerPriority: true });
    const [command] = spawnMock.mock.calls[0] as unknown as [string];
    expect(command).not.toBe('/usr/bin/nice');
  });

  it('strips lowerPriority before handing options to spawn', async () => {
    setPlatform('darwin');
    const { spawnHappyCLI } = await import('./spawnHappyCLI');
    spawnHappyCLI(['claude', '--version'], { lowerPriority: true });
    const options = (spawnMock.mock.calls[0] as unknown as unknown[])[2] as Record<string, unknown>;
    expect(options).not.toHaveProperty('lowerPriority');
  });
});
