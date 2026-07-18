import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnershipJournal, type LaunchReservation } from './ownershipJournal';

const homes: string[] = [];

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hapi-journal-'));
  homes.push(path);
  return path;
}

function reservation(overrides: Partial<LaunchReservation> = {}): LaunchReservation {
  return {
    launchNonce: 'launch-1',
    runnerInstanceId: 'runner-1',
    runnerPid: process.pid,
    runnerBirthToken: 'runner-birth',
    helperPid: process.pid + 1,
    helperBirthToken: 'helper-birth',
    bootId: 'boot-1',
    provider: 'codex',
    runtimeRealpath: '/opt/hapi/bin/codex',
    argvNonce: 'launch-1',
    launchPublicKey: 'ed25519-public-test',
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('OwnershipJournal', () => {
  it('persists atomic mode-0600 state independently per HAPI_HOME', async () => {
    const firstHome = await home();
    const secondHome = await home();
    const first = await OwnershipJournal.open({ home: firstHome, writerId: 'owner-a' });
    const second = await OwnershipJournal.open({ home: secondHome, writerId: 'owner-b' });

    await first.reserveLaunch(reservation());
    await second.reserveLaunch(reservation({ launchNonce: 'launch-2', argvNonce: 'launch-2' }));

    expect((await first.snapshot()).installationId).not.toBe((await second.snapshot()).installationId);
    expect(Object.keys((await first.snapshot()).launches)).toEqual(['launch-1']);
    expect(Object.keys((await second.snapshot()).launches)).toEqual(['launch-2']);
    expect((await stat(join(firstHome, 'runner-sessions.v1.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(firstHome, 'installation-id'))).mode & 0o777).toBe(0o600);
  });

  it('fails closed on corrupt evidence until explicitly quarantined', async () => {
    const path = await home();
    await writeFile(join(path, 'runner-sessions.v1.json'), '{broken', { mode: 0o600 });
    const journal = await OwnershipJournal.open({ home: path, writerId: 'owner-a' });

    expect(journal.health).toBe('corrupt');
    await expect(journal.reserveLaunch(reservation())).rejects.toThrow(/corrupt/);
    expect(await readFile(join(path, 'runner-sessions.v1.json'), 'utf8')).toBe('{broken');

    const quarantined = await journal.quarantineAndReset();
    expect(quarantined).toContain('.corrupt.');
    expect(journal.health).toBe('healthy');
    await journal.reserveLaunch(reservation());
  });

  it('rejects lifecycle downgrades and permits an explicit owner handoff', async () => {
    const path = await home();
    const owner = await OwnershipJournal.open({ home: path, writerId: 'owner-a' });
    await owner.reserveLaunch(reservation());
    await owner.commitSpawn('launch-1', {
      pid: 123, uid: 501, birthToken: 'child-birth', pgid: 123
    });
    await owner.recordWebhook('launch-1', 'hapi-session-1');
    await owner.recordExit('launch-1', { exitCode: 0, exitedAt: new Date().toISOString() });
    await expect(owner.commitSpawn('launch-1', {
      pid: 456, uid: 501, birthToken: 'reuse', pgid: 456
    })).rejects.toThrow(/transition/);

    const successor = await OwnershipJournal.open({ home: path, writerId: 'owner-b' });
    await expect(successor.appendOutcome('launch-1', { lifecycleState: 'stopped' })).rejects.toThrow(/owner/);
    await owner.authorizeHandoff('owner-b');
    await successor.acceptHandoff('owner-a');
    await successor.appendOutcome('launch-1', { lifecycleState: 'stopped', stoppedBy: 'runner-recycle' });
  });

  it('serializes native leases and only releases proven-empty owners', async () => {
    const path = await home();
    const journal = await OwnershipJournal.open({ home: path, writerId: 'owner-a' });
    await journal.reserveLaunch(reservation());
    await journal.commitSpawn('launch-1', { pid: 123, uid: 501, birthToken: 'birth', pgid: 123 });

    const key = 'codex:profile:native-1';
    await journal.acquireNativeLease(key, 'launch-1');
    expect((await journal.snapshot()).leases[key]).toMatchObject({
      launchNonce: 'launch-1', pid: 123, birthToken: 'birth', pgid: 123
    });
    await expect(journal.acquireNativeLease(key, 'launch-2')).rejects.toThrow(/lease/);
    await expect(journal.releaseNativeLease(key, 'launch-1', false)).rejects.toThrow(/proven empty/);
    await journal.releaseNativeLease(key, 'launch-1', true);
    expect((await journal.snapshot()).leases[key]).toBeUndefined();
  });

  it('terminalizes a verified-absent launch and releases all of its leases in one journal state', async () => {
    const path = await home();
    const provenAt = '2026-07-14T00:00:00.000Z';
    const journal = await OwnershipJournal.open({
      home: path,
      writerId: 'owner-a',
      now: () => Date.parse(provenAt)
    });
    await journal.reserveLaunch(reservation());
    await journal.acquireNativeLease('lease-1', 'launch-1');

    await journal.terminalizeAndReleaseLeases('launch-1', {
      exitCode: null, exitedAt: provenAt
    }, true);

    const snapshot = await journal.snapshot();
    expect(snapshot.launches['launch-1']).toMatchObject({
      lifecycle: 'stopped',
      exitCode: null,
      processGroupProvenEmptyAt: provenAt
    });
    expect(snapshot.leases).toEqual({});
  });

  it('durably records recycle intent, launch-bound outcomes, and start attempts', async () => {
    const path = await home();
    const journal = await OwnershipJournal.open({ home: path, writerId: 'owner-a' });
    await journal.reserveLaunch(reservation());
    await journal.commitSpawn('launch-1', { pid: 123, uid: 501, birthToken: 'birth', pgid: 123 });
    await journal.recordNativeIdentity('launch-1', { nativeResumeId: 'native-1', resumeProfileFingerprint: 'profile' });
    await journal.writeRecycleIntent('launch-1', { pid: 123, birthToken: 'birth', reason: 'runner-recycle' });
    await journal.appendOutcome('launch-1', { lifecycleState: 'unhealthy', stopReasonCode: 'ambiguous-turn-delivery' });
    await journal.openStartAttempt({ attemptId: 'attempt-1', runnerPid: 1, runnerBirthToken: 'r', helperPid: 2, helperBirthToken: 'h', bootId: 'b', runnerInstanceId: 'i' });
    await journal.completeStartAttempt('attempt-1', 'healthy');

    const snapshot = await journal.snapshot();
    expect(snapshot.launches['launch-1'].recycleIntent?.birthToken).toBe('birth');
    expect(snapshot.outbox[0]).toMatchObject({ launchNonce: 'launch-1', lifecycleState: 'unhealthy' });
    expect(snapshot.startAttempts['attempt-1'].status).toBe('complete');
    expect(JSON.stringify(snapshot)).not.toContain('credential');
  });

  it('compacts only proven-empty terminal records older than fourteen days', async () => {
    const path = await home();
    const now = Date.parse('2026-07-14T00:00:00.000Z');
    const journal = await OwnershipJournal.open({ home: path, writerId: 'owner-a', now: () => now });
    await journal.reserveLaunch(reservation({
      launchNonce: 'old-proven', argvNonce: 'old-proven', createdAt: '2026-06-01T00:00:00.000Z'
    }));
    await journal.commitSpawn('old-proven', { pid: 10, uid: 501, birthToken: 'old', pgid: 10 });
    await journal.terminalizeAndReleaseLeases('old-proven', {
      exitCode: 0, exitedAt: '2026-06-02T00:00:00.000Z'
    }, true);
    await journal.reserveLaunch(reservation({
      launchNonce: 'old-unproven', argvNonce: 'old-unproven', createdAt: '2026-06-01T00:00:00.000Z'
    }));
    await journal.commitSpawn('old-unproven', { pid: 11, uid: 501, birthToken: 'old', pgid: 11 });
    await journal.recordExit('old-unproven', {
      exitCode: 1, exitedAt: '2026-06-02T00:00:00.000Z'
    });
    await journal.reserveLaunch(reservation({ launchNonce: 'open', argvNonce: 'open', createdAt: '2026-06-01T00:00:00.000Z' }));

    expect(await journal.compact()).toEqual(['old-proven']);
    expect(Object.keys((await journal.snapshot()).launches)).toEqual(['old-unproven', 'open']);
  });

  it('retains an old proven-empty launch until every launch-bound outcome is acknowledged', async () => {
    const path = await home();
    const now = Date.parse('2026-07-14T00:00:00.000Z');
    const journal = await OwnershipJournal.open({ home: path, writerId: 'owner-a', now: () => now });
    await journal.reserveLaunch(reservation({
      launchNonce: 'old-with-outbox',
      argvNonce: 'old-with-outbox',
      createdAt: '2026-06-01T00:00:00.000Z'
    }));
    await journal.commitSpawn('old-with-outbox', {
      pid: 12,
      uid: 501,
      birthToken: 'old-outbox',
      pgid: 12
    });
    await journal.terminalizeAndReleaseLeases('old-with-outbox', {
      exitCode: 0,
      exitedAt: '2026-06-02T00:00:00.000Z'
    }, true);
    await journal.appendOutcome('old-with-outbox', {
      lifecycleState: 'stopped',
      stoppedBy: 'runner-recycle'
    }, 'durable-outcome');

    expect(await journal.compact()).toEqual([]);
    expect((await journal.snapshot()).launches['old-with-outbox']).toBeDefined();

    await expect(journal.acknowledgeOutcome('durable-outcome')).resolves.toBe(true);
    expect(await journal.compact()).toEqual(['old-with-outbox']);
    expect((await journal.snapshot()).launches['old-with-outbox']).toBeUndefined();
  });
});
