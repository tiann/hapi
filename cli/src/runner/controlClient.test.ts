import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadRunnerState = vi.fn();
const mockClearRunnerState = vi.fn();
const mockClearRunnerLock = vi.fn();
const mockIsProcessAlive = vi.fn();

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn()
  }
}));

vi.mock('@/persistence', () => ({
  readRunnerState: mockReadRunnerState,
  clearRunnerState: mockClearRunnerState,
  clearRunnerLock: mockClearRunnerLock
}));

vi.mock('@/utils/process', () => ({
  isProcessAlive: mockIsProcessAlive,
  killProcess: vi.fn()
}));

vi.mock('../../package.json', () => ({
  default: {
    version: '1.0.0'
  }
}));

describe('isRunnerRunningCurrentlyInstalledHappyVersion degraded handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadRunnerState.mockResolvedValue({
      pid: 123,
      httpPort: 4312,
      startedWithCliVersion: '1.0.0',
      startedWithCliMtimeMs: 111
    });
    mockIsProcessAlive.mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
  });

  it('treats degraded runner as reusable to avoid forced restart during temporary control-plane loss', async () => {
    const module = await import('./controlClient');

    await expect(module.isRunnerRunningCurrentlyInstalledHappyVersion()).resolves.toBe(true);
  });

  it('returns false for missing runner state', async () => {
    const module = await import('./controlClient');
    mockReadRunnerState.mockResolvedValue(null);

    await expect(module.isRunnerRunningCurrentlyInstalledHappyVersion()).resolves.toBe(false);
  });
});
