import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadRunnerState = vi.fn();
const mockClearRunnerState = vi.fn();
const mockClearRunnerLock = vi.fn();
const mockIsProcessAlive = vi.fn();
const originalFetch = globalThis.fetch;

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
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns false for degraded runner state so callers do not treat control-plane loss as reusable health', async () => {
    const module = await import('./controlClient');

    await expect(module.isRunnerRunningCurrentlyInstalledHappyVersion()).resolves.toBe(false);
  });

  it('returns false for missing runner state', async () => {
    const module = await import('./controlClient');
    mockReadRunnerState.mockResolvedValue(null);

    await expect(module.isRunnerRunningCurrentlyInstalledHappyVersion()).resolves.toBe(false);
  });
});
