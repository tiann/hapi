import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { startRunnerLockHelper, type RunnerLockHandle, type RunnerLockHelperCommand } from './lockHelper';
import { ensureInstallationId, OwnershipJournal } from './ownershipJournal';
import { readProcessIdentity, type ProcessIdentity } from './processIdentity';
import { RECONCILIATION_DEFAULTS } from './runnerConstants';

const execFileAsync = promisify(execFile);

async function readBootId(): Promise<string> {
  if (process.platform === 'linux') {
    const value = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '');
    if (value.trim()) return value.trim();
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
    if (stdout.trim()) return stdout.trim();
  }
  throw new Error('stable boot identity is unavailable on this platform');
}

export type VerifiedRunnerOwnership = {
  installationId: string;
  runnerInstanceId: string;
  runnerIdentity: ProcessIdentity;
  helper: RunnerLockHandle;
  journal: OwnershipJournal;
  bootId: string;
  runtimeRealpath: string;
  reconciliationEnforcementAllowed: boolean;
  markHealthyHeartbeat(): void;
  markHeartbeatUnhealthy(): void;
  close(reason: string): Promise<void>;
};

export async function startVerifiedRunnerOwnership(options: {
  home: string;
  runnerInstanceId: string;
  helperCommand?: RunnerLockHelperCommand;
  healthyResetMs?: number;
}): Promise<VerifiedRunnerOwnership> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('verified runner ownership is unavailable on this platform');
  }
  const home = resolve(options.home);
  const helper = await startRunnerLockHelper({ lockPath: join(home, 'runner.lock'), command: options.helperCommand });
  try {
    const runnerIdentity = await readProcessIdentity(process.pid);
    if (!runnerIdentity) throw new Error('runner process identity unavailable');
    const runtimeRealpath = await realpath(process.execPath);
    const installationId = await ensureInstallationId(home);
    const writerId = `${installationId}:${options.runnerInstanceId}`;
    const journal = await OwnershipJournal.open({ home, writerId, assertOwner: helper.assertHealthy });
    if (journal.health !== 'healthy') throw new Error('ownership journal is corrupt');
    helper.assertHealthy();
    await journal.claimWriterAfterKernelLock();
    helper.assertHealthy();
    const bootId = await readBootId();
    const beforeAttempt = await journal.snapshot();
    const failureCutoff = Date.now() - RECONCILIATION_DEFAULTS.failureWindowMs;
    const recentFailedStarts = Object.values(beforeAttempt.startAttempts).filter((attempt) =>
      attempt.status === 'open' && Date.parse(attempt.openedAt) >= failureCutoff
    ).length;
    const reconciliationEnforcementAllowed = recentFailedStarts < RECONCILIATION_DEFAULTS.failureThreshold;
    const attemptId = randomUUID();
    await journal.openStartAttempt({
      attemptId,
      runnerPid: runnerIdentity.pid,
      runnerBirthToken: runnerIdentity.birthToken,
      helperPid: helper.helperPid,
      helperBirthToken: helper.helperBirthToken,
      bootId,
      runnerInstanceId: options.runnerInstanceId
    });
    let healthy = false;
    let healthyTimer: NodeJS.Timeout | null = null;
    let healthyCompletion: Promise<void> | null = null;
    let closed = false;
    return {
      installationId,
      runnerInstanceId: options.runnerInstanceId,
      runnerIdentity,
      helper,
      journal,
      bootId,
      runtimeRealpath,
      reconciliationEnforcementAllowed,
      markHealthyHeartbeat: () => {
        if (healthy || healthyTimer) return;
        healthyTimer = setTimeout(() => {
          healthy = true;
          healthyTimer = null;
          healthyCompletion = journal.completeStartAttempt(attemptId, 'continuous-ready-healthy-window');
          void healthyCompletion.catch(() => {});
        }, options.healthyResetMs ?? RECONCILIATION_DEFAULTS.healthyResetMs);
        healthyTimer.unref();
      },
      markHeartbeatUnhealthy: () => {
        if (healthy || !healthyTimer) return;
        clearTimeout(healthyTimer);
        healthyTimer = null;
      },
      close: async (reason) => {
        if (closed) return;
        closed = true;
        if (healthyTimer) clearTimeout(healthyTimer);
        try {
          helper.assertHealthy();
          // The healthy-window timer owns durable completion. Shutdown must await
          // that exact write instead of racing it with a second completion.
          if (healthyCompletion) {
            await healthyCompletion;
          } else if (healthy) {
            const snapshot = await journal.snapshot();
            if (snapshot.startAttempts[attemptId]?.status === 'open') {
              await journal.completeStartAttempt(attemptId, reason);
            }
          } else if (reason !== 'exception') {
            await journal.cancelStartAttempt(attemptId, reason);
          }
        } finally {
          await helper.close();
        }
      }
    };
  } catch (error) {
    await helper.close();
    throw error;
  }
}
