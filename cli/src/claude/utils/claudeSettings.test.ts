import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSettings, shouldIncludeCoAuthoredBy, shouldEnableAutoTitle } from './claudeSettings';

describe('Claude Settings', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for testing
    testClaudeDir = join(tmpdir(), `test-claude-${Date.now()}`);
    mkdirSync(testClaudeDir, { recursive: true });
    
    // Set environment variable to point to test directory
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    
    // Clean up test directory
    if (existsSync(testClaudeDir)) {
      rmSync(testClaudeDir, { recursive: true, force: true });
    }
  });

  describe('readClaudeSettings', () => {
    it('returns null when settings file does not exist', () => {
      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });

    it('reads settings when file exists', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      const testSettings = { includeCoAuthoredBy: false, otherSetting: 'value' };
      writeFileSync(settingsPath, JSON.stringify(testSettings));

      const settings = readClaudeSettings();
      expect(settings).toEqual(testSettings);
    });

    it('returns null when settings file is invalid JSON', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, 'invalid json');

      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });
  });

  describe('shouldIncludeCoAuthoredBy', () => {
    it('returns true when no settings file exists (default behavior)', () => {
      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });

    it('returns true when includeCoAuthoredBy is not set (default behavior)', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ otherSetting: 'value' }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });

    it('returns false when includeCoAuthoredBy is explicitly set to false', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(false);
    });

    it('returns true when includeCoAuthoredBy is explicitly set to true', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });
  });
});

describe('shouldEnableAutoTitle', () => {
  let testHapiDir: string;
  let originalHapiHome: string | undefined;

  beforeEach(() => {
    testHapiDir = join(tmpdir(), `test-hapi-${Date.now()}`);
    mkdirSync(testHapiDir, { recursive: true });
    originalHapiHome = process.env.HAPI_HOME;
    process.env.HAPI_HOME = testHapiDir;

    vi.resetModules();
  });

  afterEach(() => {
    if (originalHapiHome !== undefined) {
      process.env.HAPI_HOME = originalHapiHome;
    } else {
      delete process.env.HAPI_HOME;
    }
    if (existsSync(testHapiDir)) {
      rmSync(testHapiDir, { recursive: true, force: true });
    }
  });

  it('returns true when no settings file exists (default)', async () => {
    const { shouldEnableAutoTitle } = await import('./claudeSettings');
    expect(shouldEnableAutoTitle()).toBe(true);
  });

  it('returns true when enableAutoTitle is not set', async () => {
    writeFileSync(join(testHapiDir, 'settings.json'), JSON.stringify({ machineId: 'test' }));
    const { shouldEnableAutoTitle } = await import('./claudeSettings');
    expect(shouldEnableAutoTitle()).toBe(true);
  });

  it('returns false when enableAutoTitle is explicitly false', async () => {
    writeFileSync(join(testHapiDir, 'settings.json'), JSON.stringify({ enableAutoTitle: false }));
    const { shouldEnableAutoTitle } = await import('./claudeSettings');
    expect(shouldEnableAutoTitle()).toBe(false);
  });

  it('returns true when enableAutoTitle is explicitly true', async () => {
    writeFileSync(join(testHapiDir, 'settings.json'), JSON.stringify({ enableAutoTitle: true }));
    const { shouldEnableAutoTitle } = await import('./claudeSettings');
    expect(shouldEnableAutoTitle()).toBe(true);
  });
});