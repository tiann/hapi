import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { QuerySpawnSessionResult, SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';
import {
  resolveCanonicalRunnerEffortSelection,
  resolveCanonicalRunnerPermissionSelection,
  resolveEffectiveRunnerModel,
  resolveEffectiveRunnerServiceTier
} from './providerSelection';

const STORE_NAME = 'runner-spawn-requests.v1.json';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_MAX_TERMINAL_REQUESTS = 2_048;
const DEFAULT_MAX_PENDING_REQUESTS = 256;

type SpawnRequestRecord = {
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  pid?: number;
  launchNonce?: string;
  runnerInstanceId?: string;
  reclaimableAt?: number;
  result: SpawnSessionResult;
};

type SpawnRequestState = {
  version: 1;
  requests: Record<string, SpawnRequestRecord>;
};

export type PendingSpawnRequest = {
  spawnRequestId: string;
  createdAt: number;
  updatedAt: number;
  pid?: number;
  launchNonce?: string;
  runnerInstanceId?: string;
};

export type ReconciledSpawnRequest = {
  spawnRequestId: string;
  result: Exclude<SpawnSessionResult, { type: 'pending' }>;
};

export class SpawnRequestConflictError extends Error {
  constructor(spawnRequestId: string) {
    super(`spawnRequestId '${spawnRequestId}' was already used with different parameters`);
    this.name = 'SpawnRequestConflictError';
  }
}

export class SpawnRequestCapacityError extends Error {
  constructor(limit: number) {
    super(`Runner pending spawn request capacity (${limit}) is exhausted`);
    this.name = 'SpawnRequestCapacityError';
  }
}

export function getSpawnRequestStorePath(home: string): string {
  return join(home, STORE_NAME);
}

function assertSpawnRequestId(spawnRequestId: string): void {
  if (!UUID_PATTERN.test(spawnRequestId)) throw new Error('spawnRequestId must be a valid UUID');
}

function tokenFingerprint(options: SpawnSessionOptions): string | null {
  return options.token === undefined
    ? null
    : createHash('sha256').update(options.token).digest('hex');
}

export function fingerprintLegacySpawnSessionOptions(options: SpawnSessionOptions): string {
  const tokenFingerprint = options.token === undefined
    ? null
    : createHash('sha256').update(options.token).digest('hex');
  const canonical = {
    machineId: options.machineId ?? null,
    directory: options.directory,
    sessionId: options.sessionId ?? null,
    resumeSessionId: options.resumeSessionId ?? null,
    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation ?? true,
    agent: options.agent ?? 'claude',
    model: options.model ?? null,
    effort: options.effort ?? null,
    modelReasoningEffort: options.modelReasoningEffort ?? null,
    serviceTier: options.serviceTier ?? null,
    yolo: options.yolo === true,
    permissionMode: options.permissionMode ?? null,
    tokenFingerprint,
    sessionType: options.sessionType ?? 'simple',
    worktreeName: options.worktreeName ?? null
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function fingerprintSpawnSessionOptions(options: SpawnSessionOptions): string {
  const agent = options.agent ?? 'claude';
  const effectiveEffort = resolveCanonicalRunnerEffortSelection(agent, options);
  const canonical = {
    machineId: options.machineId ?? null,
    directory: options.directory,
    sessionId: options.sessionId ?? null,
    resumeSessionId: options.resumeSessionId ?? null,
    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation ?? true,
    agent,
    model: resolveEffectiveRunnerModel(agent, options.model) ?? null,
    effort: agent === 'codex' ? null : (effectiveEffort ?? null),
    modelReasoningEffort: agent === 'codex' ? (effectiveEffort ?? null) : null,
    serviceTier: resolveEffectiveRunnerServiceTier(agent, options.serviceTier) ?? null,
    permissionMode: resolveCanonicalRunnerPermissionSelection(agent, options),
    tokenFingerprint: tokenFingerprint(options),
    sessionType: options.sessionType ?? 'simple',
    worktreeName: options.worktreeName ?? null
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function cloneResult(result: SpawnSessionResult): SpawnSessionResult {
  return { ...result };
}

function cloneState(state: SpawnRequestState): SpawnRequestState {
  const requests: Record<string, SpawnRequestRecord> = Object.create(null) as Record<string, SpawnRequestRecord>;
  for (const [spawnRequestId, record] of Object.entries(state.requests)) {
    requests[spawnRequestId] = {
      ...record,
      result: cloneResult(record.result)
    };
  }
  return { version: 1, requests };
}

function compactState(options: {
  state: SpawnRequestState;
  now: number;
  terminalRetentionMs: number;
  maxTerminalRequests: number;
}): { state: SpawnRequestState; changed: boolean } {
  const retainedTerminal: Array<[string, SpawnRequestRecord]> = [];
  const remove = new Set<string>();
  const cutoff = options.now - options.terminalRetentionMs;
  for (const [spawnRequestId, record] of Object.entries(options.state.requests)) {
    if (record.result.type === 'pending') continue;
    if (record.result.type === 'success' && record.reclaimableAt === undefined) continue;
    if (record.updatedAt < cutoff) {
      remove.add(spawnRequestId);
    } else {
      retainedTerminal.push([spawnRequestId, record]);
    }
  }
  retainedTerminal.sort(([leftId, left], [rightId, right]) => (
    right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || leftId.localeCompare(rightId)
  ));
  for (const [spawnRequestId] of retainedTerminal.slice(options.maxTerminalRequests)) {
    remove.add(spawnRequestId);
  }
  if (remove.size === 0) return { state: options.state, changed: false };
  const state = cloneState(options.state);
  for (const spawnRequestId of remove) delete state.requests[spawnRequestId];
  return { state, changed: true };
}

function assertNonNegativeLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function isSpawnSessionResult(value: unknown): value is SpawnSessionResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.type === 'success') return typeof result.sessionId === 'string';
  if (result.type === 'pending') return typeof result.spawnRequestId === 'string';
  if (result.type === 'requestToApproveDirectoryCreation') return typeof result.directory === 'string';
  if (result.type === 'error') return typeof result.errorMessage === 'string';
  return false;
}

function parseState(raw: string): SpawnRequestState {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Runner spawn request store is invalid');
  const candidate = value as { version?: unknown; requests?: unknown };
  if (candidate.version !== 1 || !candidate.requests || typeof candidate.requests !== 'object') {
    throw new Error('Runner spawn request store has an unsupported schema');
  }

  const requests: Record<string, SpawnRequestRecord> = Object.create(null) as Record<string, SpawnRequestRecord>;
  for (const [spawnRequestId, rawRecord] of Object.entries(candidate.requests as Record<string, unknown>)) {
    assertSpawnRequestId(spawnRequestId);
    if (!rawRecord || typeof rawRecord !== 'object') throw new Error(`Runner spawn request '${spawnRequestId}' is invalid`);
    const record = rawRecord as Partial<SpawnRequestRecord>;
    if (typeof record.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.fingerprint)
      || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)
      || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)
      || (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid <= 0))
      || (record.launchNonce !== undefined && typeof record.launchNonce !== 'string')
      || (record.runnerInstanceId !== undefined && typeof record.runnerInstanceId !== 'string')
      || (record.reclaimableAt !== undefined && (typeof record.reclaimableAt !== 'number' || !Number.isFinite(record.reclaimableAt)))
      || !isSpawnSessionResult(record.result)) {
      throw new Error(`Runner spawn request '${spawnRequestId}' is invalid`);
    }
    if (record.result.type === 'pending' && record.result.spawnRequestId !== spawnRequestId) {
      throw new Error(`Runner spawn request '${spawnRequestId}' has a mismatched pending result`);
    }
    requests[spawnRequestId] = {
      fingerprint: record.fingerprint,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      ...(record.launchNonce !== undefined ? { launchNonce: record.launchNonce } : {}),
      ...(record.runnerInstanceId !== undefined ? { runnerInstanceId: record.runnerInstanceId } : {}),
      ...(record.reclaimableAt !== undefined ? { reclaimableAt: record.reclaimableAt } : {}),
      result: cloneResult(record.result)
    };
  }
  return { version: 1, requests };
}

export class SpawnRequestStore {
  private readonly home: string;
  private readonly path: string;
  private readonly now: () => number;
  private readonly terminalRetentionMs: number;
  private readonly maxTerminalRequests: number;
  private readonly maxPendingRequests: number;
  private state: SpawnRequestState | null = null;
  private operation: Promise<void> = Promise.resolve();
  private readonly waiters = new Map<string, Set<(result: SpawnSessionResult) => void>>();

  constructor(options: {
    home: string;
    now?: () => number;
    terminalRetentionMs?: number;
    maxTerminalRequests?: number;
    maxPendingRequests?: number;
  }) {
    this.home = options.home;
    this.path = getSpawnRequestStorePath(options.home);
    this.now = options.now ?? Date.now;
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.maxTerminalRequests = options.maxTerminalRequests ?? DEFAULT_MAX_TERMINAL_REQUESTS;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    assertNonNegativeLimit('terminalRetentionMs', this.terminalRetentionMs);
    assertNonNegativeLimit('maxTerminalRequests', this.maxTerminalRequests);
    assertNonNegativeLimit('maxPendingRequests', this.maxPendingRequests);
  }

  async begin(
    spawnRequestId: string,
    fingerprint: string,
    compatibleFingerprints: readonly string[] = []
  ): Promise<{
    created: boolean;
    result: SpawnSessionResult;
  }> {
    assertSpawnRequestId(spawnRequestId);
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      const existing = state.requests[spawnRequestId];
      if (existing) {
        if (existing.fingerprint !== fingerprint && !compatibleFingerprints.includes(existing.fingerprint)) {
          throw new SpawnRequestConflictError(spawnRequestId);
        }
        return { created: false, result: cloneResult(existing.result) };
      }
      const pendingCount = Object.values(state.requests)
        .filter((record) => record.result.type === 'pending').length;
      if (pendingCount >= this.maxPendingRequests) throw new SpawnRequestCapacityError(this.maxPendingRequests);

      const nextState = cloneState(state);
      const timestamp = this.now();
      const result: SpawnSessionResult = { type: 'pending', spawnRequestId };
      nextState.requests[spawnRequestId] = {
        fingerprint,
        createdAt: timestamp,
        updatedAt: timestamp,
        result
      };
      await this.persistLocked(nextState);
      return { created: true, result: cloneResult(result) };
    });
  }

  async attachLaunchIdentity(spawnRequestId: string, identity: {
    launchNonce: string;
    runnerInstanceId: string;
  }): Promise<void> {
    assertSpawnRequestId(spawnRequestId);
    if (!identity.launchNonce || !identity.runnerInstanceId) {
      throw new Error('Spawn request launch identity must be complete');
    }
    await this.withLock(async () => {
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const record = nextState.requests[spawnRequestId];
      if (!record) throw new Error(`Spawn request '${spawnRequestId}' not found`);
      if (record.result.type !== 'pending') return;
      if ((record.launchNonce !== undefined && record.launchNonce !== identity.launchNonce)
        || (record.runnerInstanceId !== undefined && record.runnerInstanceId !== identity.runnerInstanceId)) {
        throw new Error(`Spawn request '${spawnRequestId}' is already bound to different launch identity`);
      }
      const collision = Object.entries(nextState.requests).find(([id, item]) => (
        id !== spawnRequestId
        && item.launchNonce === identity.launchNonce
        && item.runnerInstanceId === identity.runnerInstanceId
      ));
      if (collision) {
        throw new Error(`Launch identity is already bound to spawn request '${collision[0]}'`);
      }
      if (record.launchNonce === identity.launchNonce
        && record.runnerInstanceId === identity.runnerInstanceId) return;
      record.launchNonce = identity.launchNonce;
      record.runnerInstanceId = identity.runnerInstanceId;
      record.updatedAt = this.now();
      await this.persistLocked(nextState);
    });
  }

  async attachPid(spawnRequestId: string, pid: number, identity?: {
    launchNonce: string;
    runnerInstanceId: string;
  }): Promise<void> {
    assertSpawnRequestId(spawnRequestId);
    await this.withLock(async () => {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Spawn request PID must be a positive integer');
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const record = nextState.requests[spawnRequestId];
      if (!record) throw new Error(`Spawn request '${spawnRequestId}' not found`);
      if (record.result.type !== 'pending') return;
      if (record.pid === pid) {
        if (identity) {
          if ((record.launchNonce !== undefined && record.launchNonce !== identity.launchNonce)
            || (record.runnerInstanceId !== undefined && record.runnerInstanceId !== identity.runnerInstanceId)) {
            throw new Error(`Spawn request '${spawnRequestId}' is already bound to different launch identity`);
          }
          if (record.launchNonce === undefined || record.runnerInstanceId === undefined) {
            record.launchNonce = identity.launchNonce;
            record.runnerInstanceId = identity.runnerInstanceId;
            record.updatedAt = this.now();
            await this.persistLocked(nextState);
          }
        }
        return;
      }
      if (record.pid !== undefined) throw new Error(`Spawn request '${spawnRequestId}' is already bound to PID ${record.pid}`);
      const collision = Object.entries(nextState.requests).find(([id, item]) => (
        id !== spawnRequestId && item.result.type === 'pending' && item.pid === pid
      ));
      if (collision) throw new Error(`PID ${pid} is already bound to spawn request '${collision[0]}'`);
      record.pid = pid;
      if (identity) {
        record.launchNonce = identity.launchNonce;
        record.runnerInstanceId = identity.runnerInstanceId;
      }
      record.updatedAt = this.now();
      await this.persistLocked(nextState);
    });
  }

  async preservePendingForAmbiguousSpawn(spawnRequestId: string, pid: number, identity?: {
    launchNonce: string;
    runnerInstanceId: string;
  }): Promise<SpawnSessionResult> {
    assertSpawnRequestId(spawnRequestId);
    return await this.withLock(async () => {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Spawn request PID must be a positive integer');
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const record = nextState.requests[spawnRequestId];
      if (!record) throw new Error(`Spawn request '${spawnRequestId}' not found`);
      if (record.pid !== undefined && record.pid !== pid) {
        throw new Error(`Spawn request '${spawnRequestId}' is already bound to PID ${record.pid}`);
      }
      if (identity && ((record.launchNonce !== undefined && record.launchNonce !== identity.launchNonce)
        || (record.runnerInstanceId !== undefined && record.runnerInstanceId !== identity.runnerInstanceId))) {
        throw new Error(`Spawn request '${spawnRequestId}' is already bound to different launch identity`);
      }
      // Terminal request outcomes are durable facts. An outer spawn catch can
      // race an exact exit settlement and must never reopen that result merely
      // because its local absence flag was captured before the settlement.
      if (record.result.type !== 'pending') return cloneResult(record.result);
      const collision = Object.entries(nextState.requests).find(([id, item]) => (
        id !== spawnRequestId && item.result.type === 'pending' && item.pid === pid
      ));
      if (collision) throw new Error(`PID ${pid} is already bound to spawn request '${collision[0]}'`);

      record.pid = pid;
      if (identity) {
        record.launchNonce = identity.launchNonce;
        record.runnerInstanceId = identity.runnerInstanceId;
      }
      delete record.reclaimableAt;
      record.result = { type: 'pending', spawnRequestId };
      record.updatedAt = this.now();
      await this.persistLocked(nextState);
      return cloneResult(record.result);
    });
  }

  async complete(spawnRequestId: string, result: Exclude<SpawnSessionResult, { type: 'pending' }>): Promise<SpawnSessionResult> {
    assertSpawnRequestId(spawnRequestId);
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const record = nextState.requests[spawnRequestId];
      if (!record) throw new Error(`Spawn request '${spawnRequestId}' not found`);
      if (record.result.type !== 'pending') return cloneResult(record.result);
      record.result = cloneResult(result);
      record.updatedAt = this.now();
      await this.persistLocked(nextState);
      this.notify(spawnRequestId, record.result);
      return cloneResult(record.result);
    });
  }

  async completeSuccessByPid(pid: number, sessionId: string): Promise<SpawnSessionResult | null> {
    return await this.completeByPid(pid, { type: 'success', sessionId });
  }

  async completeSuccessFromWebhook(input: {
    pid: number;
    sessionId: string;
    launchNonce?: string;
    runnerInstanceId?: string;
  }): Promise<SpawnSessionResult | null> {
    if (!input.launchNonce || !input.runnerInstanceId) return null;
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const matches = Object.entries(nextState.requests).filter(([, record]) => {
        if (record.launchNonce !== input.launchNonce
          || record.runnerInstanceId !== input.runnerInstanceId) return false;
        if (record.pid !== undefined && record.pid !== input.pid) return false;
        if (record.result.type === 'error') {
          // A canonical managed webhook is stronger evidence than an earlier
          // process-exit result, but only when the durable launch identity is
          // exact. PID-only late updates remain unable to rewrite history.
          return true;
        }
        if (record.result.type === 'success') {
          return record.result.sessionId === input.sessionId;
        }
        return record.result.type === 'pending';
      });
      if (matches.length === 0) return null;
      if (matches.length > 1) throw new Error(`Webhook PID ${input.pid} matches multiple managed spawn requests`);
      const [spawnRequestId, record] = matches[0];
      if (record.result.type === 'success') return cloneResult(record.result);
      if (record.pid === undefined) {
        const collision = Object.entries(nextState.requests).find(([id, item]) => (
          id !== spawnRequestId && item.result.type === 'pending' && item.pid === input.pid
        ));
        if (collision) throw new Error(`PID ${input.pid} is already bound to spawn request '${collision[0]}'`);
        record.pid = input.pid;
      }
      record.result = { type: 'success', sessionId: input.sessionId };
      record.updatedAt = this.now();
      await this.persistLocked(nextState);
      this.notify(spawnRequestId, record.result);
      return cloneResult(record.result);
    });
  }

  async settleVerifiedEmptyLaunch(input: {
    launchNonce: string;
    runnerInstanceId: string;
    errorMessage: string;
  }): Promise<SpawnSessionResult | null> {
    if (!input.launchNonce || !input.runnerInstanceId) {
      throw new Error('Verified-empty settlement requires complete launch identity');
    }
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const matches = Object.entries(nextState.requests).filter(([, record]) => (
        record.launchNonce === input.launchNonce
        && record.runnerInstanceId === input.runnerInstanceId
      ));
      if (matches.length === 0) return null;
      if (matches.length > 1) {
        throw new Error(`Launch '${input.launchNonce}' is bound to multiple spawn requests`);
      }

      const [spawnRequestId, record] = matches[0];
      const timestamp = this.now();
      let changed = false;
      let notify = false;
      if (record.result.type === 'pending') {
        record.result = { type: 'error', errorMessage: input.errorMessage };
        delete record.reclaimableAt;
        notify = true;
        changed = true;
      } else if (record.result.type === 'success' && record.reclaimableAt === undefined) {
        record.reclaimableAt = timestamp;
        changed = true;
      }
      if (changed) {
        record.updatedAt = timestamp;
        await this.persistLocked(nextState);
      }
      if (notify) this.notify(spawnRequestId, record.result);
      return cloneResult(record.result);
    });
  }

  async completeErrorByPid(pid: number, errorMessage: string): Promise<SpawnSessionResult | null> {
    return await this.completeByPid(pid, { type: 'error', errorMessage });
  }

  async get(
    spawnRequestId: string,
    expectedFingerprint?: string,
    compatibleFingerprints: readonly string[] = []
  ): Promise<SpawnSessionResult | null> {
    assertSpawnRequestId(spawnRequestId);
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      const record = state.requests[spawnRequestId];
      if (record
        && expectedFingerprint !== undefined
        && record.fingerprint !== expectedFingerprint
        && !compatibleFingerprints.includes(record.fingerprint)) {
        throw new SpawnRequestConflictError(spawnRequestId);
      }
      return record ? cloneResult(record.result) : null;
    });
  }

  async listPending(): Promise<PendingSpawnRequest[]> {
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      return Object.entries(state.requests)
        .filter(([, record]) => record.result.type === 'pending')
        .map(([spawnRequestId, record]) => ({
          spawnRequestId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          ...(record.pid !== undefined ? { pid: record.pid } : {}),
          ...(record.launchNonce !== undefined ? { launchNonce: record.launchNonce } : {}),
          ...(record.runnerInstanceId !== undefined ? { runnerInstanceId: record.runnerInstanceId } : {}),
        }));
    });
  }

  async markSuccessesReclaimable(launchNonces: readonly string[]): Promise<number> {
    const proven = new Set(launchNonces.filter((launchNonce) => launchNonce.length > 0));
    if (proven.size === 0) return 0;
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const timestamp = this.now();
      let changed = 0;
      for (const record of Object.values(nextState.requests)) {
        if (record.result.type !== 'success'
          || !record.launchNonce
          || !proven.has(record.launchNonce)
          || record.reclaimableAt !== undefined) continue;
        record.reclaimableAt = timestamp;
        record.updatedAt = timestamp;
        changed += 1;
      }
      if (changed > 0) await this.persistLocked(nextState);
      return changed;
    });
  }

  async reconcilePending(
    resolve: (
      pending: PendingSpawnRequest,
    ) => Promise<Exclude<SpawnSessionResult, { type: 'pending' }> | null>,
  ): Promise<ReconciledSpawnRequest[]> {
    const pendingRequests = await this.listPending();
    const reconciled: ReconciledSpawnRequest[] = [];
    for (const pending of pendingRequests) {
      const resolution = await resolve(pending);
      if (!resolution) continue;
      const result = await this.complete(pending.spawnRequestId, resolution);
      if (result.type === 'pending') continue;
      reconciled.push({ spawnRequestId: pending.spawnRequestId, result });
    }
    return reconciled;
  }

  async waitForResult(spawnRequestId: string, timeoutMs: number): Promise<SpawnSessionResult> {
    const initial = await this.get(spawnRequestId);
    if (!initial) throw new Error(`Spawn request '${spawnRequestId}' not found`);
    if (initial.type !== 'pending' || timeoutMs <= 0) return initial;

    return await new Promise<SpawnSessionResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const settle = (result: SpawnSessionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const callbacks = this.waiters.get(spawnRequestId);
        callbacks?.delete(settle);
        if (callbacks?.size === 0) this.waiters.delete(spawnRequestId);
        resolve(cloneResult(result));
      };

      timer = setTimeout(() => settle({ type: 'pending', spawnRequestId }), timeoutMs);
      const callbacks = this.waiters.get(spawnRequestId) ?? new Set();
      callbacks.add(settle);
      this.waiters.set(spawnRequestId, callbacks);

      // Close the race between the first read and waiter registration.
      void this.get(spawnRequestId).then((current) => {
        if (current && current.type !== 'pending') settle(current);
      });
    });
  }

  private async completeByPid(
    pid: number,
    result: Exclude<SpawnSessionResult, { type: 'pending' }>
  ): Promise<SpawnSessionResult | null> {
    return await this.withLock(async () => {
      const state = await this.loadLocked();
      const nextState = cloneState(state);
      const matches = Object.entries(nextState.requests).filter(([, record]) => (
        record.result.type === 'pending' && record.pid === pid
      ));
      if (matches.length === 0) return null;
      if (matches.length > 1) throw new Error(`PID ${pid} is bound to multiple pending spawn requests`);
      const [spawnRequestId, record] = matches[0];
      record.result = cloneResult(result);
      record.updatedAt = this.now();
      await this.persistLocked(nextState);
      this.notify(spawnRequestId, record.result);
      return cloneResult(record.result);
    });
  }

  private notify(spawnRequestId: string, result: SpawnSessionResult): void {
    for (const waiter of this.waiters.get(spawnRequestId) ?? []) waiter(cloneResult(result));
  }

  private async loadLocked(): Promise<SpawnRequestState> {
    if (!this.state) {
      try {
        this.state = parseState(await readFile(this.path, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.state = {
          version: 1,
          requests: Object.create(null) as Record<string, SpawnRequestRecord>
        };
      }
    }
    const compacted = compactState({
      state: this.state,
      now: this.now(),
      terminalRetentionMs: this.terminalRetentionMs,
      maxTerminalRequests: this.maxTerminalRequests
    });
    if (compacted.changed) {
      await this.persistLocked(compacted.state);
    }
    return this.state!;
  }

  private async persistLocked(nextState: SpawnRequestState): Promise<void> {
    if (!this.state) throw new Error('Runner spawn request store is not loaded');
    const boundedState = compactState({
      state: nextState,
      now: this.now(),
      terminalRetentionMs: this.terminalRetentionMs,
      maxTerminalRequests: this.maxTerminalRequests
    }).state;
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = join(this.home, `.${STORE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(boundedState, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      if (process.platform !== 'win32') {
        const directory = await open(this.home, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      this.state = boundedState;
    } catch (error) {
      // A failure after rename is ambiguous. Force the next operation to
      // re-read disk rather than publishing an unconfirmed in-memory state.
      this.state = null;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return await result;
  }
}

export async function querySpawnRequest(
  store: Pick<SpawnRequestStore, 'get'>,
  spawnRequestId: string,
  expectedFingerprint?: string,
  compatibleFingerprints: readonly string[] = []
): Promise<QuerySpawnSessionResult> {
  try {
    return await store.get(
      spawnRequestId,
      expectedFingerprint,
      compatibleFingerprints
    ) ?? {
      type: 'not_found',
      spawnRequestId
    };
  } catch (error) {
    if (error instanceof SpawnRequestConflictError) {
      return { type: 'conflict', spawnRequestId };
    }
    throw error;
  }
}

export async function recoverCommittedSpawnResult(
  store: Pick<SpawnRequestStore, 'get'>,
  spawnRequestId: string
): Promise<SpawnSessionResult> {
  try {
    return await store.get(spawnRequestId) ?? { type: 'pending', spawnRequestId };
  } catch {
    // Admission commit means a child may be alive. A failed store read cannot
    // prove otherwise, so retain the original operation as queryable pending.
    return { type: 'pending', spawnRequestId };
  }
}
