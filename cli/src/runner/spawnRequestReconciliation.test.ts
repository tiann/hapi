import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OwnershipJournal, type LaunchRecord, type LaunchReservation } from './ownershipJournal';
import {
  SpawnRequestStore,
  fingerprintSpawnSessionOptions,
  type PendingSpawnRequest
} from './spawnRequestStore';
import {
  isAdmittedLaunchProvenAbsent,
  reconcileAdmittedLaunchAbsence,
  reconcileNonDestructiveLaunchAbsence,
  reconcileStoppedLaunchProofs,
  resolvePersistedPendingSpawn,
  restorePendingLaunchBindings,
  settleProvenEmptyLaunchRequests
} from './spawnRequestReconciliation';
import * as spawnRequestReconciliation from './spawnRequestReconciliation';

const homes: string[] = [];

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'hapi-spawn-reconciliation-'));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const pending: PendingSpawnRequest = {
  spawnRequestId: '11111111-1111-4111-8111-111111111111',
  createdAt: 1,
  updatedAt: 2,
  pid: 4242,
  launchNonce: 'launch-before-restart',
  runnerInstanceId: 'runner-before-restart'
};

function launch(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    launchNonce: 'launch-before-restart',
    runnerInstanceId: 'runner-before-restart',
    runnerPid: 100,
    runnerBirthToken: 'runner-birth',
    helperPid: 101,
    helperBirthToken: 'helper-birth',
    bootId: 'boot',
    provider: 'codex',
    runtimeRealpath: '/runtime',
    argvNonce: 'launch-before-restart',
    launchPublicKey: 'public-key',
    createdAt: new Date(0).toISOString(),
    lifecycle: 'spawned',
    pid: 4242,
    uid: 501,
    birthToken: 'child-birth',
    pgid: 4242,
    ...overrides
  };
}

function reservation(overrides: Partial<LaunchReservation> = {}): LaunchReservation {
  const record = launch(overrides);
  return {
    launchNonce: record.launchNonce,
    ...(record.spawnRequestId ? { spawnRequestId: record.spawnRequestId } : {}),
    runnerInstanceId: record.runnerInstanceId,
    runnerPid: record.runnerPid,
    runnerBirthToken: record.runnerBirthToken,
    helperPid: record.helperPid,
    helperBirthToken: record.helperBirthToken,
    bootId: record.bootId,
    provider: record.provider,
    runtimeRealpath: record.runtimeRealpath,
    argvNonce: record.argvNonce,
    launchPublicKey: record.launchPublicKey,
    createdAt: record.createdAt
  };
}

function provenStoppedLaunch(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return launch({
    lifecycle: 'stopped',
    exitedAt: new Date(1).toISOString(),
    processGroupProvenEmptyAt: new Date(2).toISOString(),
    ...overrides
  });
}

describe('resolvePersistedPendingSpawn', () => {
  it('recovers success when the durable launch journal already knows the HAPI session', () => {
    expect(resolvePersistedPendingSpawn(pending, launch({
      lifecycle: 'running',
      hapiSessionId: 'session-after-webhook'
    }))).toEqual({ type: 'success', sessionId: 'session-after-webhook' });
  });

  it('terminalizes a request after startup proved its managed launch stopped without a webhook', () => {
    expect(resolvePersistedPendingSpawn(pending, provenStoppedLaunch())).toEqual({
      type: 'error',
      errorMessage: 'Managed spawn ended before session registration after Runner restart'
    });
  });

  it('keeps an unproven stopped launch pending but still prefers a durable webhook success', () => {
    expect(resolvePersistedPendingSpawn(pending, launch({
      lifecycle: 'stopped',
      exitedAt: new Date(1).toISOString()
    }))).toBeNull();
    expect(resolvePersistedPendingSpawn(pending, launch({
      lifecycle: 'stopped',
      exitedAt: new Date(1).toISOString(),
      hapiSessionId: 'session-before-exit',
      processGroupProvenEmptyAt: new Date(2).toISOString()
    }))).toEqual({ type: 'success', sessionId: 'session-before-exit' });
  });

  it('rejects a malformed persisted process-group proof marker', () => {
    expect(resolvePersistedPendingSpawn(pending, launch({
      lifecycle: 'stopped',
      exitedAt: new Date(1).toISOString(),
      processGroupProvenEmptyAt: 'not-a-timestamp'
    }))).toBeNull();
  });

  it('keeps running or ambiguous launch evidence pending', () => {
    expect(resolvePersistedPendingSpawn(pending, launch({ lifecycle: 'spawned' }))).toBeNull();
    expect(resolvePersistedPendingSpawn(pending, launch({ lifecycle: 'ambiguous' }))).toBeNull();
  });

  it('terminalizes a request that restart cannot bind to any durable launch', () => {
    expect(resolvePersistedPendingSpawn({
      ...pending,
      pid: undefined,
      launchNonce: undefined,
      runnerInstanceId: undefined
    }, undefined)).toEqual({
      type: 'error',
      errorMessage: 'Managed spawn was not durably reserved before Runner restart'
    });
    expect(resolvePersistedPendingSpawn(pending, undefined)).toEqual({
      type: 'error',
      errorMessage: 'Managed spawn launch record is unavailable after Runner restart'
    });
    expect(resolvePersistedPendingSpawn({
      ...pending,
      launchNonce: undefined,
      runnerInstanceId: undefined
    }, undefined)).toEqual({
      type: 'error',
      errorMessage: 'Managed spawn lacks durable launch identity after Runner restart'
    });
  });

  it('fails closed on a launch, runner, or PID identity mismatch', () => {
    expect(resolvePersistedPendingSpawn(pending, provenStoppedLaunch({ launchNonce: 'other-launch' }))).toBeNull();
    expect(resolvePersistedPendingSpawn(pending, provenStoppedLaunch({ runnerInstanceId: 'other-runner' }))).toBeNull();
    expect(resolvePersistedPendingSpawn(pending, provenStoppedLaunch({ pid: 9999 }))).toBeNull();
  });

  it('recovers by durable launch identity when the request-store PID was not attached before restart', () => {
    expect(resolvePersistedPendingSpawn(
      { ...pending, pid: undefined },
      launch({ lifecycle: 'running', hapiSessionId: 'session-before-pid-attachment' })
    )).toEqual({ type: 'success', sessionId: 'session-before-pid-attachment' });
    expect(resolvePersistedPendingSpawn(
      { ...pending, pid: undefined },
      provenStoppedLaunch()
    )).toEqual({
      type: 'error',
      errorMessage: 'Managed spawn ended before session registration after Runner restart'
    });
  });

  it('terminalizes an exact proven-empty launch even when an older request-store PID backlink is stale', () => {
    expect(resolvePersistedPendingSpawn(
      pending,
      provenStoppedLaunch({ pid: undefined })
    )).toEqual({
      type: 'error',
      errorMessage: 'Managed spawn ended before session registration after Runner restart'
    });
  });

  it('terminalizes a pre-spawn crash only after an exact admitted-launch scan proves absence', () => {
    const admitted = launch({ lifecycle: 'admitted', pid: undefined, pgid: undefined });
    expect(isAdmittedLaunchProvenAbsent(admitted, { complete: false, matches: [] })).toBe(false);
    expect(isAdmittedLaunchProvenAbsent(admitted, { complete: true, matches: [{}] })).toBe(false);
    expect(isAdmittedLaunchProvenAbsent(admitted, { complete: true, matches: [] })).toBe(true);

    expect(resolvePersistedPendingSpawn(
      { ...pending, pid: undefined },
      provenStoppedLaunch({ pid: undefined, pgid: undefined })
    )).toEqual({
      type: 'error',
      errorMessage: 'Managed spawn ended before session registration after Runner restart'
    });
  });

  it('terminalizes an admitted no-PID launch from non-destructive absence proof independently of enforcement', async () => {
    const admitted = launch({
      lifecycle: 'admitted',
      pid: undefined,
      pgid: undefined,
      spawnRequestId: pending.spawnRequestId
    });
    const terminalized: string[] = [];

    await expect(reconcileAdmittedLaunchAbsence({
      launches: { [admitted.launchNonce]: admitted },
      findEvidence: async () => ({ complete: true, matches: [] }),
      terminalize: async (launchNonce) => { terminalized.push(launchNonce); }
    })).resolves.toEqual([admitted.launchNonce]);
    expect(terminalized).toEqual([admitted.launchNonce]);
  });

  it('promotes and settles an unproven stopped launch when a later sweep proves its group empty', async () => {
    const home = await createHome();
    const store = new SpawnRequestStore({ home });
    await store.begin(pending.spawnRequestId, fingerprintSpawnSessionOptions({
      spawnRequestId: pending.spawnRequestId,
      directory: '/tmp/project',
      agent: 'codex'
    }));
    await store.attachPid(pending.spawnRequestId, pending.pid!, {
      launchNonce: pending.launchNonce!,
      runnerInstanceId: pending.runnerInstanceId!
    });
    const originalJournal = await OwnershipJournal.open({ home, writerId: 'owner-before-restart' });
    await originalJournal.reserveLaunch(reservation());
    await originalJournal.commitSpawn(pending.launchNonce!, {
      pid: pending.pid!, uid: 501, birthToken: 'child-birth', pgid: pending.pid!
    });
    await originalJournal.recordExit(pending.launchNonce!, {
      exitCode: 1,
      exitedAt: '2026-07-14T00:00:00.000Z'
    });

    const restartedJournal = await OwnershipJournal.open({ home, writerId: 'owner-after-restart' });
    await restartedJournal.claimWriterAfterKernelLock();
    await expect(reconcileStoppedLaunchProofs({
      journal: restartedJournal,
      readGroup: async (pgid) => {
        expect(pgid).toBe(pending.pid);
        return { complete: true, members: [] };
      },
      now: () => Date.parse('2026-07-14T00:01:00.000Z')
    })).resolves.toEqual([{
      launchNonce: pending.launchNonce,
      outcome: 'proven-empty'
    }]);

    const snapshot = await restartedJournal.snapshot();
    expect(snapshot.launches[pending.launchNonce!])
      .toMatchObject({ processGroupProvenEmptyAt: expect.any(String) });
    const settled: string[] = [];
    await expect(settleProvenEmptyLaunchRequests({
      launches: snapshot.launches,
      settle: async (launch) => {
        settled.push(launch.launchNonce);
        await store.settleVerifiedEmptyLaunch({
          launchNonce: launch.launchNonce,
          runnerInstanceId: launch.runnerInstanceId,
          errorMessage: 'late group became empty in the same Runner lifecycle'
        });
      }
    })).resolves.toEqual([pending.launchNonce]);
    expect(settled).toEqual([pending.launchNonce]);
    await expect(store.get(pending.spawnRequestId)).resolves.toEqual({
      type: 'error',
      errorMessage: 'late group became empty in the same Runner lifecycle'
    });
  });

  it('retains leases when stopped-launch group evidence is incomplete or non-empty', async () => {
    for (const evidence of [
      { complete: false, members: [] },
      { complete: true, members: [{}] }
    ]) {
      const home = await createHome();
      const journal = await OwnershipJournal.open({ home, writerId: 'owner' });
      await journal.reserveLaunch(reservation());
      await journal.commitSpawn(pending.launchNonce!, {
        pid: pending.pid!, uid: 501, birthToken: 'child-birth', pgid: pending.pid!
      });
      await journal.acquireNativeLease('native-lease', pending.launchNonce!);
      await journal.recordExit(pending.launchNonce!, {
        exitCode: 1,
        exitedAt: '2026-07-14T00:00:00.000Z'
      });

      await expect(reconcileStoppedLaunchProofs({
        journal,
        readGroup: async () => evidence
      })).resolves.toEqual([{
        launchNonce: pending.launchNonce,
        outcome: 'retained-unproven'
      }]);
      const snapshot = await journal.snapshot();
      expect(snapshot.launches[pending.launchNonce!].processGroupProvenEmptyAt).toBeUndefined();
      expect(snapshot.leases['native-lease']).toBeDefined();
    }
  });

  it('retains a stopped launch when durable launch and lease group identities conflict', async () => {
    const home = await createHome();
    const journal = await OwnershipJournal.open({ home, writerId: 'owner' });
    await journal.reserveLaunch(reservation());
    await journal.commitSpawn(pending.launchNonce!, {
      pid: pending.pid!, uid: 501, birthToken: 'child-birth', pgid: pending.pid!
    });
    await journal.acquireNativeLease('native-lease', pending.launchNonce!);
    await journal.recordExit(pending.launchNonce!, {
      exitCode: 1,
      exitedAt: '2026-07-14T00:00:00.000Z'
    });
    const journalPath = join(home, 'runner-sessions.v1.json');
    const persisted = JSON.parse(await readFile(journalPath, 'utf8')) as {
      leases: Record<string, { pgid?: number }>;
    };
    persisted.leases['native-lease'].pgid = pending.pid! + 1;
    await writeFile(journalPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    const reopened = await OwnershipJournal.open({ home, writerId: 'owner' });

    await expect(reconcileStoppedLaunchProofs({
      journal: reopened,
      readGroup: async () => {
        throw new Error('conflicting durable identities must not be probed selectively');
      }
    })).resolves.toEqual([{
      launchNonce: pending.launchNonce,
      outcome: 'retained-unproven'
    }]);
    expect((await reopened.snapshot()).leases['native-lease']).toBeDefined();
  });

  it('closes a durable pending request after restart proves its launch absent', async () => {
    const home = await createHome();
    const fingerprint = fingerprintSpawnSessionOptions({
      spawnRequestId: pending.spawnRequestId,
      directory: '/tmp/project',
      agent: 'codex'
    });
    const originalStore = new SpawnRequestStore({ home });
    await originalStore.begin(pending.spawnRequestId, fingerprint);
    await originalStore.attachPid(pending.spawnRequestId, pending.pid!, {
      launchNonce: pending.launchNonce!,
      runnerInstanceId: pending.runnerInstanceId!
    });

    const originalJournal = await OwnershipJournal.open({ home, writerId: 'owner-before-restart' });
    await originalJournal.reserveLaunch(reservation());
    await originalJournal.commitSpawn(pending.launchNonce!, {
      pid: pending.pid!, uid: 501, birthToken: 'child-birth', pgid: pending.pid!
    });

    const restartedJournal = await OwnershipJournal.open({ home, writerId: 'owner-after-restart' });
    await restartedJournal.claimWriterAfterKernelLock();
    await restartedJournal.terminalizeAndReleaseLeases(pending.launchNonce!, {
      exitCode: null,
      exitedAt: '2026-07-14T00:00:00.000Z'
    }, true);
    const snapshot = await restartedJournal.snapshot();
    const restartedStore = new SpawnRequestStore({ home });
    await restartedStore.reconcilePending(async (request) => (
      resolvePersistedPendingSpawn(request, snapshot.launches[request.launchNonce!])
    ));

    await expect(restartedStore.begin(pending.spawnRequestId, fingerprint)).resolves.toEqual({
      created: false,
      result: {
        type: 'error',
        errorMessage: 'Managed spawn ended before session registration after Runner restart'
      }
    });
  });

  it('recovers a durable webhook result when restart interrupted the request-store update', async () => {
    const home = await createHome();
    const fingerprint = fingerprintSpawnSessionOptions({
      spawnRequestId: pending.spawnRequestId,
      directory: '/tmp/project',
      agent: 'codex'
    });
    const originalStore = new SpawnRequestStore({ home });
    await originalStore.begin(pending.spawnRequestId, fingerprint);
    await originalStore.attachPid(pending.spawnRequestId, pending.pid!, {
      launchNonce: pending.launchNonce!,
      runnerInstanceId: pending.runnerInstanceId!
    });

    const originalJournal = await OwnershipJournal.open({ home, writerId: 'owner-before-restart' });
    await originalJournal.reserveLaunch(reservation());
    await originalJournal.commitSpawn(pending.launchNonce!, {
      pid: pending.pid!, uid: 501, birthToken: 'child-birth', pgid: pending.pid!
    });
    await originalJournal.recordWebhook(pending.launchNonce!, 'session-from-durable-journal');

    const restartedJournal = await OwnershipJournal.open({ home, writerId: 'owner-after-restart' });
    await restartedJournal.claimWriterAfterKernelLock();
    const snapshot = await restartedJournal.snapshot();
    const restartedStore = new SpawnRequestStore({ home });
    await restartedStore.reconcilePending(async (request) => (
      resolvePersistedPendingSpawn(request, snapshot.launches[request.launchNonce!])
    ));

    await expect(restartedStore.begin(pending.spawnRequestId, fingerprint)).resolves.toEqual({
      created: false,
      result: { type: 'success', sessionId: 'session-from-durable-journal' }
    });
  });

  it('repairs the request-to-launch link when restart interrupted pre-spawn store binding', async () => {
    const home = await createHome();
    const fingerprint = fingerprintSpawnSessionOptions({
      spawnRequestId: pending.spawnRequestId,
      directory: '/tmp/project',
      agent: 'codex'
    });
    const store = new SpawnRequestStore({ home });
    await store.begin(pending.spawnRequestId, fingerprint);

    const journal = await OwnershipJournal.open({ home, writerId: 'owner-before-restart' });
    await journal.reserveLaunch(reservation({
      spawnRequestId: pending.spawnRequestId
    }));
    await journal.terminalizeAndReleaseLeases(pending.launchNonce!, {
      exitCode: null,
      exitedAt: '2026-07-14T00:00:00.000Z'
    }, true);
    const snapshot = await journal.snapshot();

    await expect(restorePendingLaunchBindings({
      store,
      launches: snapshot.launches
    })).resolves.toBe(1);
    await expect(store.listPending()).resolves.toEqual([expect.objectContaining({
      spawnRequestId: pending.spawnRequestId,
      launchNonce: pending.launchNonce,
      runnerInstanceId: pending.runnerInstanceId
    })]);
    await store.reconcilePending(async (request) => (
      resolvePersistedPendingSpawn(request, snapshot.launches[request.launchNonce!])
    ));
    await expect(store.get(pending.spawnRequestId)).resolves.toEqual({
      type: 'error',
      errorMessage: 'Managed spawn ended before session registration after Runner restart'
    });
  });

  it('repairs the request PID backlink from an adopted durable launch', async () => {
    const home = await createHome();
    const fingerprint = fingerprintSpawnSessionOptions({
      spawnRequestId: pending.spawnRequestId,
      directory: '/tmp/project',
      agent: 'codex'
    });
    const store = new SpawnRequestStore({ home });
    await store.begin(pending.spawnRequestId, fingerprint);
    await store.attachLaunchIdentity(pending.spawnRequestId, {
      launchNonce: pending.launchNonce!,
      runnerInstanceId: pending.runnerInstanceId!
    });

    await expect(restorePendingLaunchBindings({
      store,
      launches: { [pending.launchNonce!]: launch({ spawnRequestId: pending.spawnRequestId }) }
    })).resolves.toBe(1);
    await expect(store.listPending()).resolves.toEqual([
      expect.objectContaining({
        spawnRequestId: pending.spawnRequestId,
        pid: pending.pid,
        launchNonce: pending.launchNonce,
        runnerInstanceId: pending.runnerInstanceId
      })
    ]);
  });

  it('selects the one active launch when historical stopped launches retain the same recycled request ID', async () => {
    const home = await createHome();
    const fingerprint = fingerprintSpawnSessionOptions({
      spawnRequestId: pending.spawnRequestId,
      directory: '/tmp/project',
      agent: 'codex'
    });
    const store = new SpawnRequestStore({ home });
    await store.begin(pending.spawnRequestId, fingerprint);
    const oldLaunch = provenStoppedLaunch({
      launchNonce: 'old-proven-launch',
      runnerInstanceId: 'old-runner',
      spawnRequestId: pending.spawnRequestId
    });
    const replacement = launch({
      launchNonce: 'replacement-launch',
      runnerInstanceId: 'replacement-runner',
      spawnRequestId: pending.spawnRequestId,
      lifecycle: 'admitted',
      pid: undefined,
      uid: undefined,
      birthToken: undefined,
      pgid: undefined
    });

    await expect(restorePendingLaunchBindings({
      store,
      launches: {
        [oldLaunch.launchNonce]: oldLaunch,
        [replacement.launchNonce]: replacement
      }
    })).resolves.toBe(1);
    await expect(store.listPending()).resolves.toEqual([
      expect.objectContaining({
        spawnRequestId: pending.spawnRequestId,
        launchNonce: replacement.launchNonce,
        runnerInstanceId: replacement.runnerInstanceId
      })
    ]);
    expect((await store.listPending())[0]).not.toHaveProperty('pid');
  });

  it('terminalizes spawned and stopping launches from proof-only absence independently of enforcement mode', async () => {
    const spawned = launch({ launchNonce: 'spawned-empty', pgid: 7001 });
    const stopping = launch({ launchNonce: 'stopping-empty', lifecycle: 'stopping', pgid: 7002 });
    const retained = launch({ launchNonce: 'retained-live', pgid: 7003 });
    const terminalized: string[] = [];

    await expect(reconcileNonDestructiveLaunchAbsence({
      launches: {
        [spawned.launchNonce]: spawned,
        [stopping.launchNonce]: stopping,
        [retained.launchNonce]: retained
      },
      findEvidence: async () => ({ complete: true, matches: [] }),
      readGroup: async (pgid) => ({
        complete: true,
        members: pgid === retained.pgid ? [{}] : []
      }),
      terminalize: async (launchNonce) => { terminalized.push(launchNonce); }
    })).resolves.toEqual(['spawned-empty', 'stopping-empty']);
    expect(terminalized).toEqual(['spawned-empty', 'stopping-empty']);
  });

  it('retries a transiently non-empty recorded group before retaining an absent launch', async () => {
    const record = launch({ launchNonce: 'transient-group', pgid: 7004 });
    let reads = 0;
    const terminalized: string[] = [];

    await expect(reconcileNonDestructiveLaunchAbsence({
      launches: { [record.launchNonce]: record },
      findEvidence: async () => ({ complete: true, matches: [] }),
      readGroup: async () => ({ complete: true, members: ++reads < 3 ? [{}] : [] }),
      terminalize: async (launchNonce) => { terminalized.push(launchNonce); },
      groupProbeAttempts: 3,
      groupProbeDelayMs: 0
    })).resolves.toEqual([record.launchNonce]);
    expect(reads).toBe(3);
    expect(terminalized).toEqual([record.launchNonce]);
  });
});

describe('settleSpawnRequestAfterExit', () => {
  it('keeps the request pending until process-group absence is proven', async () => {
    const settle = (spawnRequestReconciliation as unknown as {
      settleSpawnRequestAfterExit?: (options: {
        proveProcessGroupEmpty: () => Promise<boolean>;
        completeTerminalError: () => Promise<void>;
      }) => Promise<'pending' | 'terminal'>;
    }).settleSpawnRequestAfterExit;
    expect(typeof settle).toBe('function');
    if (!settle) return;
    let terminalWrites = 0;

    await expect(settle({
      proveProcessGroupEmpty: async () => false,
      completeTerminalError: async () => { terminalWrites += 1; }
    })).resolves.toBe('pending');
    expect(terminalWrites).toBe(0);

    await expect(settle({
      proveProcessGroupEmpty: async () => true,
      completeTerminalError: async () => { terminalWrites += 1; }
    })).resolves.toBe('terminal');
    expect(terminalWrites).toBe(1);
  });
});

describe('settleCanonicalManagedWebhook', () => {
  it('requires durable exact identity before publishing webhook success', async () => {
    const settle = (spawnRequestReconciliation as unknown as {
      settleCanonicalManagedWebhook?: (options: {
        pid: number;
        sessionId: string;
        launchNonce?: string;
        runnerInstanceId?: string;
        recordIdentity: (input: {
          pid: number;
          sessionId: string;
          launchNonce: string;
          runnerInstanceId: string;
        }) => Promise<boolean>;
        completeSuccess: (input: {
          pid: number;
          sessionId: string;
          launchNonce: string;
          runnerInstanceId: string;
        }) => Promise<boolean>;
      }) => Promise<boolean>;
    }).settleCanonicalManagedWebhook;
    expect(typeof settle).toBe('function');
    if (!settle) return;
    const calls: string[] = [];
    const callbacks = {
      recordIdentity: async () => { calls.push('journal'); return true; },
      completeSuccess: async () => { calls.push('store'); return true; }
    };

    await expect(settle({
      pid: 6262,
      sessionId: 'missing-identity',
      recordIdentity: callbacks.recordIdentity,
      completeSuccess: callbacks.completeSuccess
    })).resolves.toBe(false);
    expect(calls).toEqual([]);

    await expect(settle({
      pid: 6262,
      sessionId: 'wrong-identity',
      launchNonce: 'launch-wrong',
      runnerInstanceId: 'runner-1',
      recordIdentity: async () => false,
      completeSuccess: callbacks.completeSuccess
    })).resolves.toBe(false);
    expect(calls).toEqual([]);

    await expect(settle({
      pid: 6262,
      sessionId: 'journal-write-failed',
      launchNonce: 'launch-1',
      runnerInstanceId: 'runner-1',
      recordIdentity: async () => { throw new Error('journal persistence failed'); },
      completeSuccess: callbacks.completeSuccess
    })).rejects.toThrow('journal persistence failed');
    expect(calls).toEqual([]);

    await expect(settle({
      pid: 6262,
      sessionId: 'canonical-session',
      launchNonce: 'launch-1',
      runnerInstanceId: 'runner-1',
      recordIdentity: callbacks.recordIdentity,
      completeSuccess: callbacks.completeSuccess
    })).resolves.toBe(true);
    expect(calls).toEqual(['journal', 'store']);

    calls.length = 0;
    await expect(settle({
      pid: 6262,
      sessionId: 'missing-store-record',
      launchNonce: 'launch-1',
      runnerInstanceId: 'runner-1',
      recordIdentity: callbacks.recordIdentity,
      completeSuccess: async () => { calls.push('store-miss'); return false; }
    })).resolves.toBe(false);
    expect(calls).toEqual(['journal', 'store-miss']);
  });
});
