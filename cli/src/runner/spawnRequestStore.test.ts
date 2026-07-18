import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/modules/common/rpcTypes';
import {
  SpawnRequestConflictError,
  SpawnRequestStore,
  fingerprintLegacySpawnSessionOptions,
  fingerprintSpawnSessionOptions,
  getSpawnRequestStorePath,
  querySpawnRequest,
  recoverCommittedSpawnResult
} from './spawnRequestStore';

const homes: string[] = [];

type StoreLimits = {
  now?: () => number;
  terminalRetentionMs?: number;
  maxTerminalRequests?: number;
  maxPendingRequests?: number;
};

async function createStore(options: StoreLimits = {}): Promise<{ home: string; store: SpawnRequestStore }> {
  const home = await mkdtemp(join(tmpdir(), 'hapi-spawn-requests-'));
  homes.push(home);
  return { home, store: new SpawnRequestStore({ home, ...options }) };
}

function request(overrides: Partial<SpawnSessionOptions> = {}): SpawnSessionOptions {
  return {
    spawnRequestId: '11111111-1111-4111-8111-111111111111',
    directory: '/tmp/project',
    agent: 'codex',
    model: 'gpt-5.5',
    ...overrides
  };
}

function requestId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('SpawnRequestStore', () => {
  it('fingerprints semantically equivalent provider defaults as one spawn request', () => {
    const codexImplicit = request({ model: ' auto ' });
    const codexPersisted = request({
      model: undefined,
      modelReasoningEffort: ' default ',
      permissionMode: 'default'
    });
    expect(fingerprintSpawnSessionOptions(codexImplicit))
      .toBe(fingerprintSpawnSessionOptions(codexPersisted));

    const claudeLegacyYolo = request({
      agent: 'claude',
      model: ' auto ',
      effort: ' auto ',
      yolo: true
    });
    const claudePersisted = request({
      agent: 'claude',
      model: undefined,
      effort: undefined,
      permissionMode: 'bypassPermissions'
    });
    expect(fingerprintSpawnSessionOptions(claudeLegacyYolo))
      .toBe(fingerprintSpawnSessionOptions(claudePersisted));

    expect(fingerprintSpawnSessionOptions(request({ agent: 'grok', model: 'auto', effort: 'low' })))
      .not.toBe(fingerprintSpawnSessionOptions(request({ agent: 'grok', model: undefined, effort: 'high' })));

    expect(fingerprintSpawnSessionOptions(request({
      agent: 'cc-api',
      model: 'kimi-k2.7-code',
      effort: 'high'
    }))).not.toBe(fingerprintSpawnSessionOptions(request({
      agent: 'cc-api',
      model: 'kimi-k2.7-code',
      effort: undefined
    })));
    expect(fingerprintSpawnSessionOptions(request({ permissionMode: 'invalid-mode' })))
      .not.toBe(fingerprintSpawnSessionOptions(request({ permissionMode: 'default' })));
  });

  it('accepts an identical pre-canonicalization fingerprint during an in-place Runner upgrade', async () => {
    const { store } = await createStore();
    const options = request({ modelReasoningEffort: 'default', permissionMode: 'default' });
    const legacyFingerprint = fingerprintLegacySpawnSessionOptions(options);
    const canonicalFingerprint = fingerprintSpawnSessionOptions(options);
    expect(canonicalFingerprint).not.toBe(legacyFingerprint);

    await store.begin(options.spawnRequestId!, legacyFingerprint);
    await expect(store.begin(
      options.spawnRequestId!,
      canonicalFingerprint,
      [legacyFingerprint]
    )).resolves.toMatchObject({ created: false });
  });

  it('rejects invalid retention and capacity limits at construction', () => {
    for (const limits of [
      { terminalRetentionMs: -1 },
      { maxTerminalRequests: 1.5 },
      { maxPendingRequests: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expect(() => new SpawnRequestStore({ home: '/tmp/hapi-invalid-limits', ...limits }))
        .toThrow(/non-negative integer/);
    }
  });

  it('rejects non-UUID request keys before they can address object prototype fields', async () => {
    const { store } = await createStore();
    await expect(store.begin('__proto__', fingerprintSpawnSessionOptions(request())))
      .rejects.toThrow('valid UUID');
  });

  it('does not publish an in-memory request when atomic persistence fails', async () => {
    const { home, store } = await createStore();
    const options = request();
    await expect(store.get(options.spawnRequestId!)).resolves.toBeNull();
    await mkdir(getSpawnRequestStorePath(home));

    await expect(store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options))).rejects.toThrow();
    await rm(getSpawnRequestStorePath(home), { recursive: true, force: true });
    await expect(store.get(options.spawnRequestId!)).resolves.toBeNull();
  });

  it('replays identical requests without creating a second spawn record', async () => {
    const { store } = await createStore();
    const options = request();
    const fingerprint = fingerprintSpawnSessionOptions(options);

    await expect(store.begin(options.spawnRequestId!, fingerprint)).resolves.toEqual({
      created: true,
      result: { type: 'pending', spawnRequestId: options.spawnRequestId }
    });
    await expect(store.begin(options.spawnRequestId!, fingerprint)).resolves.toEqual({
      created: false,
      result: { type: 'pending', spawnRequestId: options.spawnRequestId }
    });
  });

  it('rejects conflicting reuse while retaining the original request', async () => {
    const { store } = await createStore();
    const original = request();
    await store.begin(original.spawnRequestId!, fingerprintSpawnSessionOptions(original));

    const conflicting = request({ directory: '/tmp/other' });
    await expect(store.begin(conflicting.spawnRequestId!, fingerprintSpawnSessionOptions(conflicting)))
      .rejects.toBeInstanceOf(SpawnRequestConflictError);
    await expect(store.get(original.spawnRequestId!)).resolves.toEqual({
      type: 'pending',
      spawnRequestId: original.spawnRequestId
    });
  });

  it('rejects a conflicting parameter-aware lookup without creating a new request', async () => {
    const { store } = await createStore();
    const original = request();
    const originalFingerprint = fingerprintSpawnSessionOptions(original);
    await store.begin(original.spawnRequestId!, originalFingerprint);

    const conflicting = request({ directory: '/tmp/other' });
    await expect(store.get(
      original.spawnRequestId!,
      fingerprintSpawnSessionOptions(conflicting)
    )).rejects.toBeInstanceOf(SpawnRequestConflictError);
    await expect(store.get(
      original.spawnRequestId!,
      originalFingerprint
    )).resolves.toEqual({
      type: 'pending',
      spawnRequestId: original.spawnRequestId
    });
  });

  it('returns a typed conflict for a parameter-aware Runner query', async () => {
    const { store } = await createStore();
    const original = request();
    await store.begin(original.spawnRequestId!, fingerprintSpawnSessionOptions(original));

    const result = await querySpawnRequest(
      store,
      original.spawnRequestId!,
      fingerprintSpawnSessionOptions(request({ directory: '/tmp/other' }))
    );

    expect(result).toEqual({
      type: 'conflict',
      spawnRequestId: original.spawnRequestId
    });
    await expect(store.get(
      original.spawnRequestId!,
      fingerprintSpawnSessionOptions(original)
    )).resolves.toEqual({
      type: 'pending',
      spawnRequestId: original.spawnRequestId
    });
  });

  it('returns authoritative not-found from a Runner query helper', async () => {
    const { store } = await createStore();
    const spawnRequestId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    await expect(querySpawnRequest(store, spawnRequestId)).resolves.toEqual({
      type: 'not_found',
      spawnRequestId
    });
  });

  it('returns pending when the bounded wait expires without inventing a failure', async () => {
    const { store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));

    await expect(store.waitForResult(options.spawnRequestId!, 5)).resolves.toEqual({
      type: 'pending',
      spawnRequestId: options.spawnRequestId
    });
  });

  it('does not invent a terminal error after child admission committed', async () => {
    const spawnRequestId = '12121212-1212-4212-8212-121212121212';
    await expect(recoverCommittedSpawnResult({
      get: async () => ({ type: 'pending', spawnRequestId })
    }, spawnRequestId)).resolves.toEqual({ type: 'pending', spawnRequestId });

    await expect(recoverCommittedSpawnResult({
      get: async () => {
        throw new Error('atomic store state is ambiguous after rename');
      }
    }, spawnRequestId)).resolves.toEqual({ type: 'pending', spawnRequestId });

    await expect(recoverCommittedSpawnResult({
      get: async () => ({ type: 'success', sessionId: 'session-already-reported' })
    }, spawnRequestId)).resolves.toEqual({
      type: 'success',
      sessionId: 'session-already-reported'
    });
  });

  it('accepts a webhook at 16.5 seconds while an identical replay remains single-spawn', async () => {
    vi.useFakeTimers();
    const { store } = await createStore();
    const options = request();
    const fingerprint = fingerprintSpawnSessionOptions(options);
    await store.begin(options.spawnRequestId!, fingerprint);
    await store.attachPid(options.spawnRequestId!, 4242);
    const boundedWait = store.waitForResult(options.spawnRequestId!, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(boundedWait).resolves.toEqual({
      type: 'pending',
      spawnRequestId: options.spawnRequestId
    });
    await expect(store.begin(options.spawnRequestId!, fingerprint)).resolves.toEqual({
      created: false,
      result: { type: 'pending', spawnRequestId: options.spawnRequestId }
    });
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(store.completeSuccessByPid(4242, 'session-late')).resolves.toEqual({
      type: 'success',
      sessionId: 'session-late'
    });
    await expect(store.begin(options.spawnRequestId!, fingerprint)).resolves.toEqual({
      created: false,
      result: { type: 'success', sessionId: 'session-late' }
    });
  });

  it('keeps the first terminal error even if a late success races afterward', async () => {
    const { store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
    await store.attachPid(options.spawnRequestId!, 5252);

    await expect(store.completeErrorByPid(5252, 'child exited before webhook')).resolves.toEqual({
      type: 'error',
      errorMessage: 'child exited before webhook'
    });
    await expect(store.completeSuccessByPid(5252, 'session-too-late')).resolves.toBeNull();
    await expect(store.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'error',
      errorMessage: 'child exited before webhook'
    });
  });

  it('never downgrades a durable terminal error while preserving an ambiguous managed spawn', async () => {
    const { store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
    await store.attachPid(options.spawnRequestId!, 5253, {
      launchNonce: 'launch-ambiguous',
      runnerInstanceId: 'runner-ambiguous'
    });
    await store.completeErrorByPid(5253, 'bookkeeping failed before absence proof');

    await expect(store.preservePendingForAmbiguousSpawn(options.spawnRequestId!, 5253, {
      launchNonce: 'launch-wrong',
      runnerInstanceId: 'runner-ambiguous'
    })).rejects.toThrow(/different launch identity/);
    await expect(store.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'error',
      errorMessage: 'bookkeeping failed before absence proof'
    });
    await expect(store.preservePendingForAmbiguousSpawn(options.spawnRequestId!, 5253, {
      launchNonce: 'launch-ambiguous',
      runnerInstanceId: 'runner-ambiguous'
    })).resolves.toEqual({
      type: 'error',
      errorMessage: 'bookkeeping failed before absence proof'
    });
    await expect(store.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'error',
      errorMessage: 'bookkeeping failed before absence proof'
    });
  });

  it('promotes an exact managed webhook over an earlier terminal error', async () => {
    const { store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
    await store.attachPid(options.spawnRequestId!, 5262, {
      launchNonce: 'launch-exact-webhook',
      runnerInstanceId: 'runner-exact-webhook'
    });
    await store.completeErrorByPid(5262, 'empty group was observed first');

    await expect(store.completeSuccessFromWebhook({
      pid: 5262,
      sessionId: 'unrelated-session',
      launchNonce: 'wrong-launch',
      runnerInstanceId: 'runner-exact-webhook'
    })).resolves.toBeNull();
    await expect(store.completeSuccessFromWebhook({
      pid: 5262,
      sessionId: 'canonical-session-arrived-late',
      launchNonce: 'launch-exact-webhook',
      runnerInstanceId: 'runner-exact-webhook'
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'canonical-session-arrived-late'
    });
    await expect(store.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'success',
      sessionId: 'canonical-session-arrived-late'
    });
  });

  it('acknowledges an exact replay of durable webhook success and rejects a different session', async () => {
    const { store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
    await store.attachPid(options.spawnRequestId!, 5264, {
      launchNonce: 'launch-success-replay',
      runnerInstanceId: 'runner-success-replay'
    });
    const canonical = {
      pid: 5264,
      sessionId: 'session-success-replay',
      launchNonce: 'launch-success-replay',
      runnerInstanceId: 'runner-success-replay'
    };

    await expect(store.completeSuccessFromWebhook(canonical)).resolves.toEqual({
      type: 'success',
      sessionId: canonical.sessionId
    });
    await expect(store.completeSuccessFromWebhook(canonical)).resolves.toEqual({
      type: 'success',
      sessionId: canonical.sessionId
    });
    await expect(store.completeSuccessFromWebhook({
      ...canonical,
      sessionId: 'different-session'
    })).resolves.toBeNull();
    await expect(store.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'success',
      sessionId: canonical.sessionId
    });
  });

  it('settles a verified-empty launch by exact identity without requiring a PID backlink', async () => {
    const { home, store } = await createStore();
    const pendingRequest = request();
    await store.begin(pendingRequest.spawnRequestId!, fingerprintSpawnSessionOptions(pendingRequest));
    await store.attachLaunchIdentity(pendingRequest.spawnRequestId!, {
      launchNonce: 'launch-empty-pending',
      runnerInstanceId: 'runner-empty-pending'
    });

    await expect(store.settleVerifiedEmptyLaunch({
      launchNonce: 'launch-empty-pending',
      runnerInstanceId: 'runner-empty-pending',
      errorMessage: 'managed child was proven absent'
    })).resolves.toEqual({
      type: 'error',
      errorMessage: 'managed child was proven absent'
    });

    const successfulRequest = request({
      spawnRequestId: '26262626-2626-4262-8262-262626262626'
    });
    await store.begin(successfulRequest.spawnRequestId!, fingerprintSpawnSessionOptions(successfulRequest));
    await store.attachPid(successfulRequest.spawnRequestId!, 6264, {
      launchNonce: 'launch-empty-success',
      runnerInstanceId: 'runner-empty-success'
    });
    await store.complete(successfulRequest.spawnRequestId!, {
      type: 'success',
      sessionId: 'session-empty-success'
    });
    await expect(store.settleVerifiedEmptyLaunch({
      launchNonce: 'launch-empty-success',
      runnerInstanceId: 'runner-empty-success',
      errorMessage: 'must not overwrite canonical success'
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'session-empty-success'
    });
    await expect(store.settleVerifiedEmptyLaunch({
      launchNonce: 'wrong-launch',
      runnerInstanceId: 'runner-empty-success',
      errorMessage: 'wrong identity'
    })).resolves.toBeNull();

    const persisted = JSON.parse(await readFile(getSpawnRequestStorePath(home), 'utf8'));
    expect(persisted.requests[successfulRequest.spawnRequestId!].reclaimableAt).toEqual(expect.any(Number));
  });

  it('refuses to complete a managed spawn request from PID-only webhook evidence', async () => {
    const { store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
    await store.attachPid(options.spawnRequestId!, 5263);

    await expect(store.completeSuccessFromWebhook({
      pid: 5263,
      sessionId: 'pid-reuse-candidate'
    })).resolves.toBeNull();
    await expect(store.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'pending',
      spawnRequestId: options.spawnRequestId
    });
  });

  it('durably pre-binds launch identity and lets an exact early webhook bind the PID', async () => {
    const { home, store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
    await store.attachLaunchIdentity(options.spawnRequestId!, {
      launchNonce: 'launch-before-child',
      runnerInstanceId: 'runner-before-child'
    });

    const reopened = new SpawnRequestStore({ home });
    await expect(reopened.listPending()).resolves.toEqual([expect.objectContaining({
      spawnRequestId: options.spawnRequestId,
      launchNonce: 'launch-before-child',
      runnerInstanceId: 'runner-before-child'
    })]);
    await expect(reopened.completeSuccessFromWebhook({
      pid: 5272,
      sessionId: 'wrong-session',
      launchNonce: 'wrong-launch',
      runnerInstanceId: 'runner-before-child'
    })).resolves.toBeNull();
    await expect(reopened.completeSuccessFromWebhook({
      pid: 5272,
      sessionId: 'session-before-pid-attachment',
      launchNonce: 'launch-before-child',
      runnerInstanceId: 'runner-before-child'
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'session-before-pid-attachment'
    });
    await expect(reopened.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'success',
      sessionId: 'session-before-pid-attachment'
    });
    const persisted = JSON.parse(await readFile(getSpawnRequestStorePath(home), 'utf8'));
    expect(persisted.requests[options.spawnRequestId!].pid).toBe(5272);
  });

  it('rejects launch identity rebinding before PID attachment', async () => {
    const { store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
    await store.attachLaunchIdentity(options.spawnRequestId!, {
      launchNonce: 'launch-original',
      runnerInstanceId: 'runner-original'
    });

    await expect(store.attachLaunchIdentity(options.spawnRequestId!, {
      launchNonce: 'launch-replacement',
      runnerInstanceId: 'runner-original'
    })).rejects.toThrow(/different launch identity/);
    await expect(store.completeSuccessFromWebhook({
      pid: 5273,
      sessionId: 'wrong-session',
      launchNonce: 'launch-replacement',
      runnerInstanceId: 'runner-original'
    })).resolves.toBeNull();
    await expect(store.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'pending',
      spawnRequestId: options.spawnRequestId
    });
  });

  it('preserves canonical success across webhook and restart-reconciliation races', async () => {
    const { store } = await createStore();
    const webhookFirst = request();
    const webhookFirstFingerprint = fingerprintSpawnSessionOptions(webhookFirst);
    await store.begin(webhookFirst.spawnRequestId!, webhookFirstFingerprint);
    await store.attachPid(webhookFirst.spawnRequestId!, 5353, {
      launchNonce: 'launch-webhook-first',
      runnerInstanceId: 'runner-before-restart'
    });
    let releaseResolver!: () => void;
    let markResolverEntered!: () => void;
    const resolverEntered = new Promise<void>((resolve) => { markResolverEntered = resolve; });
    const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
    const reconciliation = store.reconcilePending(async () => {
      markResolverEntered();
      await resolverGate;
      return { type: 'error', errorMessage: 'restart absence proof' };
    });
    await resolverEntered;
    await store.completeSuccessFromWebhook({
      pid: 5353,
      sessionId: 'session-webhook-first',
      launchNonce: 'launch-webhook-first',
      runnerInstanceId: 'runner-before-restart'
    });
    releaseResolver();
    await expect(reconciliation).resolves.toEqual([{
      spawnRequestId: webhookFirst.spawnRequestId,
      result: { type: 'success', sessionId: 'session-webhook-first' }
    }]);
    await expect(store.begin(webhookFirst.spawnRequestId!, webhookFirstFingerprint)).resolves.toEqual({
      created: false,
      result: { type: 'success', sessionId: 'session-webhook-first' }
    });

    const reconciliationFirst = request({
      spawnRequestId: '22222222-2222-4222-8222-222222222222'
    });
    const reconciliationFirstFingerprint = fingerprintSpawnSessionOptions(reconciliationFirst);
    await store.begin(reconciliationFirst.spawnRequestId!, reconciliationFirstFingerprint);
    await store.attachPid(reconciliationFirst.spawnRequestId!, 5454, {
      launchNonce: 'launch-reconciliation-first',
      runnerInstanceId: 'runner-before-restart'
    });
    await store.reconcilePending(async () => ({
      type: 'error',
      errorMessage: 'restart absence proof'
    }));
    await expect(store.completeSuccessFromWebhook({
      pid: 5454,
      sessionId: 'session-too-late',
      launchNonce: 'launch-reconciliation-first',
      runnerInstanceId: 'runner-before-restart'
    })).resolves.toEqual({ type: 'success', sessionId: 'session-too-late' });
    await expect(store.begin(
      reconciliationFirst.spawnRequestId!,
      reconciliationFirstFingerprint
    )).resolves.toEqual({
      created: false,
      result: { type: 'success', sessionId: 'session-too-late' }
    });
  });

  it('persists terminal outcomes atomically across store restarts without persisting secrets', async () => {
    const { home, store } = await createStore();
    const options = request({ token: 'super-secret-token' });
    const fingerprint = fingerprintSpawnSessionOptions(options);
    await store.begin(options.spawnRequestId!, fingerprint);
    await store.attachPid(options.spawnRequestId!, 6262, {
      launchNonce: 'launch-persisted',
      runnerInstanceId: 'runner-original'
    });

    const reopened = new SpawnRequestStore({ home });
    await expect(reopened.completeSuccessFromWebhook({
      pid: 6262,
      sessionId: 'wrong-session',
      launchNonce: 'wrong-launch',
      runnerInstanceId: 'runner-original'
    })).resolves.toBeNull();
    await expect(reopened.completeSuccessFromWebhook({
      pid: 6262,
      sessionId: 'session-persisted',
      launchNonce: 'launch-persisted',
      runnerInstanceId: 'runner-original'
    })).resolves.toEqual({ type: 'success', sessionId: 'session-persisted' });
    await expect(reopened.begin(options.spawnRequestId!, fingerprint)).resolves.toEqual({
      created: false,
      result: { type: 'success', sessionId: 'session-persisted' }
    });

    const path = getSpawnRequestStorePath(home);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain('super-secret-token');
  });

  it('reconciles a persisted pending request after restart and never spawns it again', async () => {
    const { home, store } = await createStore();
    const options = request();
    const fingerprint = fingerprintSpawnSessionOptions(options);
    await store.begin(options.spawnRequestId!, fingerprint);
    await store.attachPid(options.spawnRequestId!, 7373, {
      launchNonce: 'launch-before-restart',
      runnerInstanceId: 'runner-before-restart'
    });

    const reopened = new SpawnRequestStore({ home });
    const resolved = await reopened.reconcilePending(async (pending) => {
      expect(pending).toMatchObject({
        spawnRequestId: options.spawnRequestId,
        pid: 7373,
        launchNonce: 'launch-before-restart',
        runnerInstanceId: 'runner-before-restart'
      });
      return {
        type: 'error',
        errorMessage: 'Managed child was proven absent after Runner restart'
      };
    });

    expect(resolved).toEqual([{
      spawnRequestId: options.spawnRequestId,
      result: {
        type: 'error',
        errorMessage: 'Managed child was proven absent after Runner restart'
      }
    }]);
    await expect(reopened.begin(options.spawnRequestId!, fingerprint)).resolves.toEqual({
      created: false,
      result: {
        type: 'error',
        errorMessage: 'Managed child was proven absent after Runner restart'
      }
    });
    await expect(reopened.reconcilePending(async () => {
      throw new Error('terminal requests must not be revisited');
    })).resolves.toEqual([]);
  });

  it('keeps ambiguous persisted requests pending during restart reconciliation', async () => {
    const { home, store } = await createStore();
    const options = request();
    await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));

    const reopened = new SpawnRequestStore({ home });
    await expect(reopened.reconcilePending(async () => null)).resolves.toEqual([]);
    await expect(reopened.get(options.spawnRequestId!)).resolves.toEqual({
      type: 'pending',
      spawnRequestId: options.spawnRequestId
    });
  });

  it('atomically expires old terminal errors after restart without pruning pending requests', async () => {
    let now = 0;
    const limits = {
      now: () => now,
      terminalRetentionMs: 1_000,
      maxTerminalRequests: 10,
      maxPendingRequests: 10
    };
    const { home, store } = await createStore(limits);
    const expired = request({ spawnRequestId: requestId(1) });
    const stillPending = request({ spawnRequestId: requestId(2) });
    const expiredFingerprint = fingerprintSpawnSessionOptions(expired);
    await store.begin(expired.spawnRequestId!, expiredFingerprint);
    await store.complete(expired.spawnRequestId!, { type: 'error', errorMessage: 'proven terminal error' });
    await store.begin(stillPending.spawnRequestId!, fingerprintSpawnSessionOptions(stillPending));

    now = 1_001;
    const reopened = new SpawnRequestStore({ home, ...limits });
    await expect(reopened.get(expired.spawnRequestId!)).resolves.toBeNull();
    await expect(reopened.get(stillPending.spawnRequestId!)).resolves.toEqual({
      type: 'pending',
      spawnRequestId: stillPending.spawnRequestId
    });
    expect(await readFile(getSpawnRequestStorePath(home), 'utf8')).not.toContain(expired.spawnRequestId!);
    await expect(reopened.begin(expired.spawnRequestId!, expiredFingerprint)).resolves.toMatchObject({
      created: true,
      result: { type: 'pending', spawnRequestId: expired.spawnRequestId }
    });
  });

  it('retains an old successful request while its managed launch may still be active', async () => {
    let now = 0;
    const limits = {
      now: () => now,
      terminalRetentionMs: 1_000,
      maxTerminalRequests: 0,
      maxPendingRequests: 10
    };
    const { home, store } = await createStore(limits);
    const active = request({ spawnRequestId: requestId(20) });
    const fingerprint = fingerprintSpawnSessionOptions(active);
    await store.begin(active.spawnRequestId!, fingerprint);
    await store.attachPid(active.spawnRequestId!, 2020, {
      launchNonce: 'launch-active-success',
      runnerInstanceId: 'runner-active-success'
    });
    await store.complete(active.spawnRequestId!, { type: 'success', sessionId: 'session-still-active' });

    now = 10_000;
    const reopened = new SpawnRequestStore({ home, ...limits });
    await expect(reopened.get(active.spawnRequestId!)).resolves.toEqual({
      type: 'success',
      sessionId: 'session-still-active'
    });
    await expect(reopened.begin(active.spawnRequestId!, fingerprint)).resolves.toMatchObject({
      created: false,
      result: { type: 'success', sessionId: 'session-still-active' }
    });
  });

  it('expires a successful request only after its launch is proven empty', async () => {
    let now = 0;
    const limits = {
      now: () => now,
      terminalRetentionMs: 1_000,
      maxTerminalRequests: 10,
      maxPendingRequests: 10
    };
    const { home, store } = await createStore(limits);
    const stopped = request({ spawnRequestId: requestId(21) });
    await store.begin(stopped.spawnRequestId!, fingerprintSpawnSessionOptions(stopped));
    await store.attachPid(stopped.spawnRequestId!, 2121, {
      launchNonce: 'launch-proven-empty',
      runnerInstanceId: 'runner-proven-empty'
    });
    await store.complete(stopped.spawnRequestId!, { type: 'success', sessionId: 'session-stopped' });

    now = 100;
    await expect(store.markSuccessesReclaimable(['launch-proven-empty'])).resolves.toBe(1);
    now = 1_101;

    const reopened = new SpawnRequestStore({ home, ...limits });
    await expect(reopened.get(stopped.spawnRequestId!)).resolves.toBeNull();
  });

  it('caps terminal history deterministically while retaining every pending request', async () => {
    let now = 0;
    const { store } = await createStore({
      now: () => now,
      terminalRetentionMs: 10_000,
      maxTerminalRequests: 2,
      maxPendingRequests: 10
    });
    const pendingRequest = request({ spawnRequestId: requestId(10) });
    await store.begin(pendingRequest.spawnRequestId!, fingerprintSpawnSessionOptions(pendingRequest));
    for (let index = 1; index <= 3; index += 1) {
      now = index;
      const options = request({ spawnRequestId: requestId(index) });
      await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
      await store.complete(options.spawnRequestId!, { type: 'error', errorMessage: `terminal-${index}` });
    }

    await expect(store.get(requestId(1))).resolves.toBeNull();
    await expect(store.get(requestId(2))).resolves.toEqual({ type: 'error', errorMessage: 'terminal-2' });
    await expect(store.get(requestId(3))).resolves.toEqual({ type: 'error', errorMessage: 'terminal-3' });
    await expect(store.get(pendingRequest.spawnRequestId!)).resolves.toEqual({
      type: 'pending',
      spawnRequestId: pendingRequest.spawnRequestId
    });
    const evicted = request({ spawnRequestId: requestId(1) });
    await expect(store.begin(evicted.spawnRequestId!, fingerprintSpawnSessionOptions(evicted)))
      .resolves.toMatchObject({
        created: true,
        result: { type: 'pending', spawnRequestId: evicted.spawnRequestId }
      });
  });

  it('uses request ID as the deterministic terminal-cap tie breaker', async () => {
    const { store } = await createStore({
      now: () => 100,
      terminalRetentionMs: 10_000,
      maxTerminalRequests: 2,
      maxPendingRequests: 10
    });
    for (const index of [3, 1, 2]) {
      const options = request({ spawnRequestId: requestId(index) });
      await store.begin(options.spawnRequestId!, fingerprintSpawnSessionOptions(options));
      await store.complete(options.spawnRequestId!, { type: 'error', errorMessage: `terminal-${index}` });
    }

    await expect(store.get(requestId(1))).resolves.toEqual({ type: 'error', errorMessage: 'terminal-1' });
    await expect(store.get(requestId(2))).resolves.toEqual({ type: 'error', errorMessage: 'terminal-2' });
    await expect(store.get(requestId(3))).resolves.toBeNull();
  });

  it('expires and reuses a terminal request on a later write without reopening the store', async () => {
    let now = 0;
    const { store } = await createStore({
      now: () => now,
      terminalRetentionMs: 1_000,
      maxTerminalRequests: 10,
      maxPendingRequests: 10
    });
    const options = request({ spawnRequestId: requestId(1) });
    const fingerprint = fingerprintSpawnSessionOptions(options);
    await store.begin(options.spawnRequestId!, fingerprint);
    await store.complete(options.spawnRequestId!, { type: 'error', errorMessage: 'expired-error' });

    now = 1_001;
    await expect(store.begin(options.spawnRequestId!, fingerprint)).resolves.toMatchObject({
      created: true,
      result: { type: 'pending', spawnRequestId: options.spawnRequestId }
    });
  });

  it('rejects new unique requests at pending capacity but still permits replay and recovery', async () => {
    const { store } = await createStore({
      terminalRetentionMs: 10_000,
      maxTerminalRequests: 2,
      maxPendingRequests: 2
    });
    const first = request({ spawnRequestId: requestId(1) });
    const second = request({ spawnRequestId: requestId(2) });
    const third = request({ spawnRequestId: requestId(3) });
    const firstFingerprint = fingerprintSpawnSessionOptions(first);
    await store.begin(first.spawnRequestId!, firstFingerprint);
    await store.begin(second.spawnRequestId!, fingerprintSpawnSessionOptions(second));

    await expect(store.begin(first.spawnRequestId!, firstFingerprint)).resolves.toMatchObject({
      created: false,
      result: { type: 'pending', spawnRequestId: first.spawnRequestId }
    });
    await expect(store.begin(third.spawnRequestId!, fingerprintSpawnSessionOptions(third)))
      .rejects.toThrow(/pending spawn request capacity/i);

    await store.complete(first.spawnRequestId!, { type: 'error', errorMessage: 'terminal' });
    await expect(store.begin(third.spawnRequestId!, fingerprintSpawnSessionOptions(third))).resolves.toMatchObject({
      created: true,
      result: { type: 'pending', spawnRequestId: third.spawnRequestId }
    });
  });
});
