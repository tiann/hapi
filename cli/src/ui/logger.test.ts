import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger';
import * as fs from 'node:fs';
import { join } from 'path';

// Mock configuration to avoid side effects
vi.mock('@/configuration', () => ({
  configuration: {
    logsDir: '/tmp/logs',
    isRunnerProcess: false,
    localTimezoneTimestamp: () => '2025-01-01 12:00:00.000'
  }
}));

describe('Logger', () => {
  let logger: Logger;
  const logDir = '/tmp/logs';
  const logFilePath = join(logDir, 'test.log');

  beforeEach(() => {
    if (fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
    fs.mkdirSync(logDir, { recursive: true });

    logger = new Logger(logFilePath);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('debug writes to file but NOT to console, even if DEBUG is set', () => {
    process.env.DEBUG = 'true';
    const message = 'test debug message';
    const consoleSpy = vi.spyOn(console, 'log');

    logger.debug(message);

    // Verify it writes to file
    expect(fs.existsSync(logFilePath)).toBe(true);
    const content = fs.readFileSync(logFilePath, 'utf-8');
    expect(content).toContain(message);

    // Verify it DOES NOT write to console
    expect(consoleSpy).not.toHaveBeenCalled();

    delete process.env.DEBUG;
  });

  it('info writes to console AND file', () => {
    const message = 'test info message';
    const consoleSpy = vi.spyOn(console, 'log');

    logger.info(message);

    // Verify it writes to console
    expect(consoleSpy).toHaveBeenCalled();
    const consoleArgs = consoleSpy.mock.calls[0];
    expect(consoleArgs[1]).toBe(message);

    // Verify it writes to file
    expect(fs.existsSync(logFilePath)).toBe(true);
    const content = fs.readFileSync(logFilePath, 'utf-8');
    expect(content).toContain(message);
  });
});
