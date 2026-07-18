import { describe, expect, it } from 'vitest';
import type { LaunchRecord } from './ownershipJournal';
import type { ProcessIdentity } from './processIdentity';
import { classifyLaunch, reconcileLaunches, selectReconciliationCandidates } from './reconciliation';

function launch(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    launchNonce: 'nonce-1', runnerInstanceId: 'old-runner', runnerPid: 10, runnerBirthToken: 'rb',
    helperPid: 11, helperBirthToken: 'hb', bootId: 'boot', provider: 'codex',
    runtimeRealpath: '/opt/hapi/bin/hapi', argvNonce: 'nonce-1', launchPublicKey: 'key',
    createdAt: '2026-07-01T00:00:00.000Z', lifecycle: 'running',
    pid: 100, uid: 501, birthToken: 'birth-100', pgid: 100,
    ...overrides
  };
}

function live(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid: 100, uid: 501, birthToken: 'birth-100', pgid: 100,
    executableRealpath: '/opt/hapi/bin/hapi',
    argv: ['/opt/hapi/bin/hapi', '--hapi-launch-nonce', 'nonce-1', '--hapi-runner-instance', 'old-runner'],
    ...overrides
  };
}

describe('classifyLaunch', () => {
  it('authorizes startup only for a fully matched launch whose different owner is proven dead', () => {
    expect(classifyLaunch(launch(), { leader: live(), group: [live()], groupComplete: true, ownerAlive: false, hubStopEligible: true }, {
      flow: 'startup', currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true
    })).toMatchObject({ classification: 'stale-killable' });
  });

  it.each([
    ['pid', { pid: 101 }], ['birth', { birthToken: 'other' }], ['pgid', { pgid: 101 }],
    ['uid', { uid: 502 }], ['runtime', { executableRealpath: '/tmp/not-hapi' }],
    ['nonce', { argv: ['/opt/hapi/bin/hapi', '--hapi-launch-nonce', 'other', '--hapi-runner-instance', 'old-runner'] }],
    ['runner', { argv: ['/opt/hapi/bin/hapi', '--hapi-launch-nonce', 'nonce-1', '--hapi-runner-instance', 'other'] }]
  ])('fails closed when %s evidence mismatches', (_name, mismatch) => {
    expect(classifyLaunch(launch(), { leader: live(mismatch), group: [live(mismatch)], ownerAlive: false, hubStopEligible: true }, {
      flow: 'startup', currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true
    }).classification).toBe('ambiguous');
  });

  it('treats a dead wrapper leader with descendants as ambiguous', () => {
    expect(classifyLaunch(launch(), { leader: null, group: [live({ pid: 102 })], ownerAlive: false, hubStopEligible: true }, {
      flow: 'startup', currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true
    }).classification).toBe('ambiguous');
  });

  it('rejects complete-looking group evidence that omits the verified leader', () => {
    expect(classifyLaunch(launch(), { leader: live(), group: [live({ pid: 102 })], groupComplete: true, ownerAlive: false, hubStopEligible: true }, {
      flow: 'startup', currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true
    }).classification).toBe('ambiguous');
  });

  it('requires a flushed matching recycle intent for normal shutdown', () => {
    const current = launch({ runnerInstanceId: 'current' });
    const currentLeader = live({ argv: ['/opt/hapi/bin/hapi', '--hapi-launch-nonce', 'nonce-1', '--hapi-runner-instance', 'current'] });
    expect(classifyLaunch(current, { leader: currentLeader, group: [currentLeader], groupComplete: true, ownerAlive: true, hubStopEligible: true }, {
      flow: 'normal', currentRunnerInstanceId: 'current', currentUid: 501, hubAvailable: false, helperHealthy: true
    }).classification).toBe('ambiguous');
    current.recycleIntent = { pid: 100, birthToken: 'birth-100', reason: 'runner-recycle', writtenAt: new Date().toISOString() };
    expect(classifyLaunch(current, { leader: currentLeader, group: [currentLeader], groupComplete: true, ownerAlive: true, hubStopEligible: true }, {
      flow: 'normal', currentRunnerInstanceId: 'current', currentUid: 501, hubAvailable: false, helperHealthy: true
    }).classification).toBe('current');
  });
});

describe('reconciliation selection and execution', () => {
  it('selects at most four candidates oldest-first', () => {
    const records = Array.from({ length: 6 }, (_, index) => launch({
      launchNonce: `n-${index}`, argvNonce: `n-${index}`, createdAt: `2026-07-0${index + 1}T00:00:00.000Z`
    }));
    expect(selectReconciliationCandidates(records.reverse(), 4).map((entry) => entry.launchNonce)).toEqual(['n-0', 'n-1', 'n-2', 'n-3']);
  });

  it('revalidates before KILL and honors a kill switch changed after TERM', async () => {
    const signals: string[] = [];
    const result = await reconcileLaunches([launch()], {
      currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true,
      readEvidence: async () => ({ leader: live(), group: [live()], groupComplete: true, ownerAlive: false, hubStopEligible: true }),
      writeIntent: async () => undefined,
      signalGroup: async (_pgid, signal) => { signals.push(signal); },
      waitForSettlement: async () => false,
      readKillSwitch: async () => signals.includes('SIGTERM'),
      deadlineAt: Date.now() + 10_000
    });

    expect(signals).toEqual(['SIGTERM']);
    expect(result[0].outcome).toBe('term-only-kill-switch');
  });

  it('rechecks the kill switch after TERM intent and immediately before signalling', async () => {
    const signals: string[] = [];
    let revoked = false;
    const result = await reconcileLaunches([launch()], {
      currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true,
      readEvidence: async () => ({ leader: live(), group: [live()], groupComplete: true, ownerAlive: false, hubStopEligible: true }),
      writeIntent: async (_record, reason) => {
        if (reason === 'stale-owner-term') revoked = true;
      },
      signalGroup: async (_pgid, signal) => { signals.push(signal); },
      waitForSettlement: async () => false,
      readKillSwitch: async () => revoked,
      deadlineAt: Date.now() + 10_000
    });

    expect(signals).toEqual([]);
    expect(result[0].outcome).toBe('term-blocked-kill-switch');
  });

  it('rechecks the kill switch after KILL intent and immediately before signalling', async () => {
    const signals: string[] = [];
    let revoked = false;
    const result = await reconcileLaunches([launch()], {
      currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true,
      readEvidence: async () => ({ leader: live(), group: [live()], groupComplete: true, ownerAlive: false, hubStopEligible: true }),
      writeIntent: async (_record, reason) => {
        if (reason === 'stale-owner-sigkill') revoked = true;
      },
      signalGroup: async (_pgid, signal) => { signals.push(signal); },
      waitForSettlement: async () => false,
      readKillSwitch: async () => revoked,
      deadlineAt: Date.now() + 10_000
    });

    expect(signals).toEqual(['SIGTERM']);
    expect(result[0].outcome).toBe('term-only-kill-switch');
  });

  it('performs no destructive startup work when hub is down or helper is unhealthy', async () => {
    for (const context of [{ hubAvailable: false, helperHealthy: true }, { hubAvailable: true, helperHealthy: false }]) {
      let signalled = false;
      await reconcileLaunches([launch()], {
        currentRunnerInstanceId: 'new-runner', currentUid: 501, ...context,
        readEvidence: async () => ({ leader: live(), group: [live()], ownerAlive: false, hubStopEligible: true }),
        writeIntent: async () => undefined,
        signalGroup: async () => { signalled = true; },
        waitForSettlement: async () => true,
        readKillSwitch: async () => false,
        deadlineAt: Date.now() + 10_000
      });
      expect(signalled).toBe(false);
    }
  });

  it('classifies every record before applying the destructive signal cap', async () => {
    const records = Array.from({ length: 105 }, (_, index) => launch({
      launchNonce: `n-${index}`, argvNonce: `n-${index}`,
      createdAt: new Date(Date.parse('2026-07-01T00:00:00.000Z') + index * 1_000).toISOString()
    }));
    const signals: number[] = [];
    await reconcileLaunches(records, {
      currentRunnerInstanceId: 'new-runner', currentUid: 501, hubAvailable: true, helperHealthy: true,
      cap: 2,
      readEvidence: async (record) => {
        const index = Number(record.launchNonce.slice(2));
        if (index < 103) return { leader: null, group: [], groupComplete: false, ownerAlive: false, hubStopEligible: true };
        const identity = live({
          argv: ['/opt/hapi/bin/hapi', '--hapi-launch-nonce', record.launchNonce, '--hapi-runner-instance', 'old-runner']
        });
        return { leader: identity, group: [identity], groupComplete: true, ownerAlive: false, hubStopEligible: true };
      },
      writeIntent: async () => undefined,
      signalGroup: async (pgid) => { signals.push(pgid); },
      waitForSettlement: async () => true,
      readKillSwitch: async () => false,
      deadlineAt: Date.now() + 10_000
    });

    expect(signals).toHaveLength(2);
  });
});
