import os from 'os';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupAllCodexHomesSync,
  cleanupCodexHomeDirSync,
  cleanupCodexHomeForSessionSync
} from './run';

const createdTempDirs = new Set<string>();

const createCodexHomeDir = async (): Promise<string> => {
  const codexHomeDir = await mkdtemp(join(os.tmpdir(), 'hapi-codex-cleanup-test-'));
  createdTempDirs.add(codexHomeDir);
  await writeFile(join(codexHomeDir, 'auth.json'), '{"token":"test"}', 'utf8');
  return codexHomeDir;
};

afterEach(async () => {
  for (const dir of createdTempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  createdTempDirs.clear();
});

describe('codex home cleanup helpers', () => {
  it('cleanupCodexHomeDirSync removes existing codex home directory', async () => {
    const codexHomeDir = await createCodexHomeDir();
    expect(existsSync(codexHomeDir)).toBe(true);

    cleanupCodexHomeDirSync(codexHomeDir);

    expect(existsSync(codexHomeDir)).toBe(false);
  });

  it('cleanupCodexHomeDirSync is best-effort for missing directories', () => {
    const missingDir = join(
      os.tmpdir(),
      `hapi-codex-cleanup-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    expect(() => cleanupCodexHomeDirSync(missingDir)).not.toThrow();
  });

  it('cleanupCodexHomeForSessionSync removes tracked map entry and codex home dir', async () => {
    const sessionId = 'session-123';
    const codexHomeDir = await createCodexHomeDir();
    const codexHomeBySessionId = new Map<string, string>([[sessionId, codexHomeDir]]);

    cleanupCodexHomeForSessionSync(
      {
        happySessionId: sessionId,
        codexHomeDir
      },
      codexHomeBySessionId
    );

    expect(codexHomeBySessionId.has(sessionId)).toBe(false);
    expect(existsSync(codexHomeDir)).toBe(false);
  });

  it('cleanupCodexHomeForSessionSync keeps codex home dir while another session still references it', async () => {
    const sharedCodexHomeDir = await createCodexHomeDir();
    const codexHomeBySessionId = new Map<string, string>([
      ['session-one', sharedCodexHomeDir],
      ['session-two', sharedCodexHomeDir]
    ]);

    cleanupCodexHomeForSessionSync(
      {
        happySessionId: 'session-one',
        codexHomeDir: sharedCodexHomeDir
      },
      codexHomeBySessionId
    );

    expect(codexHomeBySessionId.has('session-one')).toBe(false);
    expect(codexHomeBySessionId.get('session-two')).toBe(sharedCodexHomeDir);
    expect(existsSync(sharedCodexHomeDir)).toBe(true);
  });

  it('cleanupAllCodexHomesSync removes all known codex homes and clears tracked session map', async () => {
    const codexHomeOne = await createCodexHomeDir();
    const codexHomeTwo = await createCodexHomeDir();
    const codexHomeThree = await createCodexHomeDir();

    const codexHomeBySessionId = new Map<string, string>([
      ['session-one', codexHomeOne],
      ['session-two', codexHomeTwo],
      ['session-two-resume', codexHomeTwo]
    ]);

    cleanupAllCodexHomesSync(codexHomeBySessionId, [
      { codexHomeDir: codexHomeThree },
      { codexHomeDir: codexHomeOne }
    ]);

    expect(codexHomeBySessionId.size).toBe(0);
    expect(existsSync(codexHomeOne)).toBe(false);
    expect(existsSync(codexHomeTwo)).toBe(false);
    expect(existsSync(codexHomeThree)).toBe(false);
  });
});
