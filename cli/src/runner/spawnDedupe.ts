import path from 'path';
import { createHash } from 'crypto';

import type { SpawnSessionOptions } from '@/modules/common/rpcTypes';
import type { TrackedSession } from './types';

function normalizePathForKey(directory: string): string {
  const resolved = path.resolve(directory);
  return process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
}

function valueOrEmpty(value: string | boolean | undefined): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : '';
  }
  return value ?? '';
}

function hashSecret(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return createHash('sha256').update(value).digest('hex');
}

export function buildRunnerSpawnKey(options: SpawnSessionOptions): string | null {
  if ((options.sessionType ?? 'simple') !== 'simple') {
    return null;
  }

  return JSON.stringify({
    agent: options.agent ?? 'claude',
    directory: normalizePathForKey(options.directory),
    resumeSessionId: valueOrEmpty(options.resumeSessionId),
    model: valueOrEmpty(options.model),
    effort: valueOrEmpty(options.effort),
    modelReasoningEffort: valueOrEmpty(options.modelReasoningEffort),
    yolo: valueOrEmpty(options.yolo),
    permissionMode: valueOrEmpty(options.permissionMode),
    tokenHash: hashSecret(options.token)
  });
}

export function findReusableRunnerSpawnSession(
  sessions: Iterable<TrackedSession>,
  spawnKey: string,
  isAlive: (pid: number) => boolean
): TrackedSession | null {
  for (const session of sessions) {
    if (session.startedBy !== 'runner') {
      continue;
    }
    if (session.spawnKey !== spawnKey) {
      continue;
    }
    if (!session.happySessionId) {
      continue;
    }
    if (!isAlive(session.pid)) {
      continue;
    }
    return session;
  }
  return null;
}
