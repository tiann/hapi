import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import {
  createProcessEvidenceSweep,
  isCompleteOwnedProcessGroup,
  listProcessGroup,
  parseProcessTableSnapshot,
  readProcessIdentity,
  type ProcessIdentity
} from './processIdentity';
import {
  matchesIntegrationFixtureProcess,
  waitForExactIntegrationFixtureProcess
} from './integrationFixtureIdentity';

describe('process identity', () => {
  it('reads a stable identity for the current process', async () => {
    const first = await readProcessIdentity(process.pid);
    const second = await readProcessIdentity(process.pid);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.birthToken).toBe(second?.birthToken);
    expect(first?.uid).toBe(process.getuid?.());
    expect(first?.pgid).toBeGreaterThan(0);
    expect(first?.executableRealpath).toBe(await realpath(process.execPath));
  });

  it('returns null for a missing pid', async () => {
    expect(await readProcessIdentity(999_999)).toBeNull();
  });

  it('preserves internal runner identity arguments in argv evidence', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'setTimeout(() => {}, 5000)',
      '--',
      '--hapi-launch-nonce',
      'nonce-test',
      '--hapi-runner-instance',
      'runner-test'
    ]);

    try {
      const identity = await readProcessIdentity(child.pid!);
      expect(identity?.argv).toContain('--hapi-launch-nonce');
      expect(identity?.argv).toContain('nonce-test');
      expect(identity?.argv).toContain('--hapi-runner-instance');
      expect(identity?.argv).toContain('runner-test');
      expect((await listProcessGroup(identity!.pgid)).some((entry) => entry.pid === child.pid)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('authorizes group signalling only with complete same-owner evidence containing the verified leader', () => {
    const leader = {
      pid: 100, uid: 501, birthToken: 'birth', pgid: 100,
      executableRealpath: '/hapi', argv: ['hapi']
    };
    expect(isCompleteOwnedProcessGroup(leader, { complete: true, members: [leader] })).toBe(true);
    expect(isCompleteOwnedProcessGroup(leader, { complete: false, members: [leader] })).toBe(false);
    expect(isCompleteOwnedProcessGroup(leader, { complete: true, members: [{ ...leader, pid: 101, uid: 502 }] })).toBe(false);
    expect(isCompleteOwnedProcessGroup(leader, { complete: true, members: [{ ...leader, pid: 101 }] })).toBe(false);
  });

  it('captures one process table and reuses one identity read across a retained-launch sweep', async () => {
    let snapshotReads = 0;
    let identityReads = 0;
    const identity: ProcessIdentity = {
      pid: 4242,
      uid: 501,
      birthToken: 'birth-4242',
      pgid: 4242,
      executableRealpath: '/opt/hapi/bin/hapi',
      argv: [
        '/opt/hapi/bin/hapi',
        '--hapi-launch-nonce',
        'launch-42',
        '--hapi-runner-instance',
        'runner-42'
      ],
      evidenceSource: 'kernel'
    };
    const sweep = await createProcessEvidenceSweep({
      captureSnapshot: async () => {
        snapshotReads += 1;
        return {
          complete: true,
          rows: [{
            pid: identity.pid,
            pgid: identity.pgid,
            command: identity.argv.join(' ')
          }]
        };
      },
      readIdentity: async (pid) => {
        identityReads += 1;
        return pid === identity.pid ? identity : null;
      }
    });

    for (let index = 0; index < 256; index += 1) {
      const evidence = await sweep.findManagedProcessEvidence(`launch-${index}`, `runner-${index}`, 2);
      expect(evidence.matches).toHaveLength(index === 42 ? 1 : 0);
      await sweep.readProcessGroupEvidence(index + 4200);
    }

    expect(snapshotReads).toBe(1);
    expect(identityReads).toBe(1);
  });

  it('keeps Linux positive process groups complete when ps includes a valid PGID-zero kernel thread', () => {
    expect(parseProcessTableSnapshot([
      '      2       0 [kthreadd]',
      '   4242    4242 /opt/hapi/bin/hapi --hapi-launch-nonce launch-42 --hapi-runner-instance runner-42',
      ''
    ].join('\n'))).toEqual({
      complete: true,
      rows: [{
        pid: 4242,
        pgid: 4242,
        command: '/opt/hapi/bin/hapi --hapi-launch-nonce launch-42 --hapi-runner-instance runner-42'
      }]
    });
  });

  it('matches an integration fixture only by exact kernel birth, runtime, group, and managed argv', () => {
    const binding = {
      pid: 4242,
      birthToken: 'birth-4242',
      pgid: 4242,
      executableRealpath: '/opt/hapi/bin/hapi',
      launchNonce: 'launch-42',
      runnerInstanceId: 'runner-42'
    };
    const identity: ProcessIdentity = {
      pid: binding.pid,
      uid: 501,
      birthToken: binding.birthToken,
      pgid: binding.pgid,
      executableRealpath: binding.executableRealpath,
      argv: [
        binding.executableRealpath,
        '--hapi-launch-nonce',
        binding.launchNonce,
        '--hapi-runner-instance',
        binding.runnerInstanceId
      ],
      evidenceSource: 'kernel'
    };

    expect(matchesIntegrationFixtureProcess(binding, identity)).toBe(true);
    expect(matchesIntegrationFixtureProcess(binding, { ...identity, birthToken: 'reused-pid' })).toBe(false);
    expect(matchesIntegrationFixtureProcess(binding, { ...identity, executableRealpath: '/tmp/other' })).toBe(false);
    expect(matchesIntegrationFixtureProcess(binding, { ...identity, evidenceSource: 'ps' })).toBe(false);
    expect(matchesIntegrationFixtureProcess(binding, { ...identity, evidenceSource: undefined })).toBe(false);
    expect(matchesIntegrationFixtureProcess(binding, {
      ...identity,
      argv: identity.argv.map((value) => value === binding.launchNonce ? 'other-launch' : value)
    })).toBe(false);
  });

  it('retries transient untrusted ps evidence before accepting the exact kernel identity', async () => {
    const binding = {
      pid: 4242,
      birthToken: 'birth-4242',
      pgid: 4242,
      executableRealpath: '/opt/hapi/bin/hapi',
      launchNonce: 'launch-42',
      runnerInstanceId: 'runner-42'
    };
    const exact: ProcessIdentity = {
      pid: binding.pid,
      uid: 501,
      birthToken: binding.birthToken,
      pgid: binding.pgid,
      executableRealpath: binding.executableRealpath,
      argv: [
        binding.executableRealpath,
        '--hapi-launch-nonce',
        binding.launchNonce,
        '--hapi-runner-instance',
        binding.runnerInstanceId
      ],
      evidenceSource: 'kernel'
    };
    const reads = [{ ...exact, birthToken: 'ps-transient', evidenceSource: 'ps' as const }, exact];
    const sleeps: number[] = [];

    const resolved = await waitForExactIntegrationFixtureProcess(binding, {
      attempts: 2,
      intervalMs: 25,
      readIdentity: async () => reads.shift() ?? null,
      isAlive: () => true,
      sleep: async (delayMs) => { sleeps.push(delayMs); }
    });

    expect(resolved).toEqual(exact);
    expect(sleeps).toEqual([25]);
  });

  it('does not classify an EPERM liveness probe as a gone integration fixture', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw denied;
    }) as typeof process.kill);

    try {
      await expect(waitForExactIntegrationFixtureProcess({
        pid: 4242,
        birthToken: 'birth-4242',
        pgid: 4242,
        executableRealpath: '/opt/hapi/bin/hapi',
        launchNonce: 'launch-42',
        runnerInstanceId: 'runner-42'
      }, {
        attempts: 1,
        readIdentity: async () => null
      })).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      kill.mockRestore();
    }
  });
});
