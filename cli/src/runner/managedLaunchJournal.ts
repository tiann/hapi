import { createHash, randomUUID } from 'node:crypto';
import { createLaunchSigningMaterial } from './managedOutcomeMailbox';
import type { OwnershipJournal } from './ownershipJournal';
import { readProcessGroupEvidence, readProcessIdentity, type ProcessIdentity } from './processIdentity';

const SPAWN_IDENTITY_SETTLE_ATTEMPTS = 20;
const SPAWN_IDENTITY_SETTLE_INTERVAL_MS = 25;

export type PreparedManagedLaunch = {
  launchNonce: string;
  runnerInstanceId: string;
  privateKey: string;
  resumeProfileFingerprint?: string;
  nativeResumeId?: string;
};

type Options = {
  journal: OwnershipJournal;
  runnerInstanceId: string;
  runnerPid: number;
  runnerBirthToken: string;
  helperPid: number;
  helperBirthToken: string;
  bootId: string;
  runtimeRealpath: string;
  readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  readGroupEvidence?: typeof readProcessGroupEvidence;
};

export class ManagedLaunchJournal {
  private readonly options: Options;
  private readonly pidToNonce = new Map<number, string>();

  constructor(options: Options) {
    this.options = options;
  }

  async reserve(
    provider: string,
    nativeProfile?: { nativeResumeId?: string; resumeProfileFingerprint: string },
    spawnRequestId?: string
  ): Promise<PreparedManagedLaunch> {
    const launchNonce = randomUUID();
    const signing = createLaunchSigningMaterial();
    await this.options.journal.reserveLaunch({
      launchNonce,
      ...(spawnRequestId ? { spawnRequestId } : {}),
      runnerInstanceId: this.options.runnerInstanceId,
      runnerPid: this.options.runnerPid,
      runnerBirthToken: this.options.runnerBirthToken,
      helperPid: this.options.helperPid,
      helperBirthToken: this.options.helperBirthToken,
      bootId: this.options.bootId,
      provider,
      runtimeRealpath: this.options.runtimeRealpath,
      argvNonce: launchNonce,
      launchPublicKey: signing.publicKey,
      resumeProfileFingerprint: nativeProfile?.resumeProfileFingerprint,
      createdAt: new Date().toISOString()
    });
    if (nativeProfile?.nativeResumeId) {
      const nativeIdentity = {
        nativeResumeId: nativeProfile.nativeResumeId,
        resumeProfileFingerprint: nativeProfile.resumeProfileFingerprint
      };
      const leaseKey = this.nativeLeaseKey(provider, nativeIdentity);
      await this.options.journal.acquireNativeLease(leaseKey, launchNonce);
      await this.options.journal.recordNativeIdentity(launchNonce, nativeIdentity);
    }
    return {
      launchNonce,
      runnerInstanceId: this.options.runnerInstanceId,
      privateKey: signing.privateKey,
      resumeProfileFingerprint: nativeProfile?.resumeProfileFingerprint,
      nativeResumeId: nativeProfile?.nativeResumeId
    };
  }

  async commitSpawn(launch: PreparedManagedLaunch, pid: number): Promise<ProcessIdentity> {
    this.pidToNonce.set(pid, launch.launchNonce);
    try {
      const identity = await this.readSettledSpawnIdentity(launch, pid);
      if (!identity) throw new Error(`spawned process identity unavailable for PID ${pid}`);
      if (identity.evidenceSource === 'ps') throw new Error(`spawned process kernel identity unavailable for PID ${pid}`);
      await this.options.journal.commitSpawn(launch.launchNonce, {
        pid: identity.pid,
        uid: identity.uid,
        birthToken: identity.birthToken,
        pgid: identity.pgid
      });
      if (identity.executableRealpath !== this.options.runtimeRealpath) {
        throw new Error(`spawned process runtime identity mismatch for PID ${pid}`);
      }
      if (!this.hasManagedFlag(identity.argv, '--hapi-launch-nonce', launch.launchNonce)
        || !this.hasManagedFlag(identity.argv, '--hapi-runner-instance', this.options.runnerInstanceId)) {
        throw new Error(`spawned process ownership arguments mismatch for PID ${pid}`);
      }
      return identity;
    } catch (error) {
      const lifecycle = (await this.options.journal.snapshot()).launches[launch.launchNonce]?.lifecycle;
      if (lifecycle !== 'spawned') this.pidToNonce.delete(pid);
      throw error;
    }
  }

  async recordSpawnFailure(launch: PreparedManagedLaunch, exitCode: number | null, processGroupProvenEmpty = false): Promise<void> {
    const before = await this.options.journal.snapshot();
    if (!processGroupProvenEmpty || !['admitted', 'spawned', 'stopping', 'ambiguous'].includes(before.launches[launch.launchNonce]?.lifecycle ?? '')) return;
    this.pidToNonce.forEach((nonce, pid) => {
      if (nonce === launch.launchNonce) this.pidToNonce.delete(pid);
    });
    await this.options.journal.terminalizeAndReleaseLeases(
      launch.launchNonce,
      { exitCode, exitedAt: new Date().toISOString() },
      true
    );
  }

  async terminalizeVerifiedAbsent(launchNonce: string): Promise<void> {
    const before = await this.options.journal.snapshot();
    const record = before.launches[launchNonce];
    if (!record || record.lifecycle === 'stopped') return;
    this.pidToNonce.forEach((nonce, pid) => {
      if (nonce === launchNonce) this.pidToNonce.delete(pid);
    });
    await this.options.journal.terminalizeAndReleaseLeases(
      launchNonce,
      { exitCode: null, exitedAt: new Date().toISOString() },
      true
    );
  }

  async adopt(record: import('./ownershipJournal').LaunchRecord, identity: ProcessIdentity): Promise<void> {
    if (identity.evidenceSource === 'ps' || identity.pid <= 0
      || identity.executableRealpath !== record.runtimeRealpath
      || !this.hasManagedFlag(identity.argv, '--hapi-launch-nonce', record.launchNonce)
      || !this.hasManagedFlag(identity.argv, '--hapi-runner-instance', record.runnerInstanceId)) {
      throw new Error(`adopted process identity mismatch for launch ${record.launchNonce}`);
    }
    if (record.lifecycle === 'admitted') {
      await this.options.journal.commitSpawn(record.launchNonce, {
        pid: identity.pid, uid: identity.uid, birthToken: identity.birthToken, pgid: identity.pgid
      });
    } else if (record.pid !== identity.pid || record.uid !== identity.uid
      || record.birthToken !== identity.birthToken || record.pgid !== identity.pgid) {
      throw new Error(`adopted journal binding mismatch for launch ${record.launchNonce}`);
    }
    this.pidToNonce.set(identity.pid, record.launchNonce);
  }

  async writeRecycleIntent(pid: number): Promise<ProcessIdentity> {
    const nonce = this.pidToNonce.get(pid);
    if (!nonce) throw new Error(`PID ${pid} is not a journaled launch`);
    const snapshot = await this.options.journal.snapshot();
    const record = snapshot.launches[nonce];
    const identity = await (this.options.readIdentity ?? readProcessIdentity)(pid);
    if (!record || !identity || identity.evidenceSource === 'ps' || record.pid !== identity.pid || record.birthToken !== identity.birthToken
      || record.pgid !== identity.pgid || identity.executableRealpath !== record.runtimeRealpath
      || !this.hasManagedFlag(identity.argv, '--hapi-launch-nonce', record.argvNonce)
      || !this.hasManagedFlag(identity.argv, '--hapi-runner-instance', record.runnerInstanceId)) {
      throw new Error(`managed recycle identity mismatch for PID ${pid}`);
    }
    await this.options.journal.writeRecycleIntent(nonce, {
      pid,
      birthToken: identity.birthToken,
      reason: 'runner-recycle'
    });
    return identity;
  }

  async writeSpawnRejectionIntent(pid: number): Promise<ProcessIdentity> {
    const nonce = this.pidToNonce.get(pid);
    if (!nonce) throw new Error(`PID ${pid} is not a journaled launch`);
    const snapshot = await this.options.journal.snapshot();
    const record = snapshot.launches[nonce];
    const identity = await (this.options.readIdentity ?? readProcessIdentity)(pid);
    if (!record || !identity || identity.evidenceSource === 'ps' || record.pid !== identity.pid || record.uid !== identity.uid
      || record.birthToken !== identity.birthToken || record.pgid !== identity.pgid
      || identity.executableRealpath !== record.runtimeRealpath
      || !this.hasManagedFlag(identity.argv, '--hapi-launch-nonce', record.argvNonce)
      || !this.hasManagedFlag(identity.argv, '--hapi-runner-instance', record.runnerInstanceId)) {
      throw new Error(`rejected spawn identity mismatch for PID ${pid}`);
    }
    await this.options.journal.writeRecycleIntent(nonce, {
      pid,
      birthToken: identity.birthToken,
      reason: 'spawn-rejected'
    });
    return identity;
  }

  async recordWebhook(pid: number, hapiSessionId: string): Promise<void> {
    const nonce = this.pidToNonce.get(pid);
    if (nonce) await this.options.journal.recordWebhook(nonce, hapiSessionId);
  }

  async recordWebhookByIdentity(input: {
    pid: number;
    launchNonce: string;
    runnerInstanceId: string;
    hapiSessionId: string;
  }): Promise<boolean> {
    const snapshot = await this.options.journal.snapshot();
    const record = snapshot.launches[input.launchNonce];
    if (!record || record.pid !== input.pid || record.runnerInstanceId !== input.runnerInstanceId) {
      return false;
    }
    await this.options.journal.recordWebhook(input.launchNonce, input.hapiSessionId);
    return true;
  }

  async recordNativeIdentity(pid: number, identity: { nativeResumeId: string; resumeProfileFingerprint: string }): Promise<void> {
    const nonce = this.pidToNonce.get(pid);
    if (!nonce) throw new Error(`PID ${pid} is not a journaled launch`);
    const snapshot = await this.options.journal.snapshot();
    const record = snapshot.launches[nonce];
    const processIdentity = await (this.options.readIdentity ?? readProcessIdentity)(pid);
    if (!record || !processIdentity || processIdentity.evidenceSource === 'ps' || record.pid !== processIdentity.pid
      || record.birthToken !== processIdentity.birthToken || record.pgid !== processIdentity.pgid
      || processIdentity.executableRealpath !== record.runtimeRealpath
      || !this.hasManagedFlag(processIdentity.argv, '--hapi-launch-nonce', record.argvNonce)
      || !this.hasManagedFlag(processIdentity.argv, '--hapi-runner-instance', record.runnerInstanceId)) {
      throw new Error(`native identity process binding mismatch for PID ${pid}`);
    }
    if (record.resumeProfileFingerprint && record.resumeProfileFingerprint !== identity.resumeProfileFingerprint) {
      throw new Error(`native identity mismatch for resumed launch ${nonce}`);
    }
    if (record.nativeResumeId && record.nativeResumeId !== identity.nativeResumeId) {
      if (!record.nativeIdentityConfirmedAt) throw new Error(`native identity mismatch for resumed launch ${nonce}`);
      const previousLeaseKey = this.nativeLeaseKey(record.provider, {
        nativeResumeId: record.nativeResumeId,
        resumeProfileFingerprint: record.resumeProfileFingerprint ?? identity.resumeProfileFingerprint
      });
      const nextLeaseKey = this.nativeLeaseKey(record.provider, identity);
      await this.options.journal.rebindNativeIdentity(nonce, previousLeaseKey, nextLeaseKey, identity);
      return;
    }
    const leaseKey = this.nativeLeaseKey(record.provider, identity);
    await this.options.journal.acquireNativeLease(leaseKey, nonce);
    await this.options.journal.recordNativeIdentity(nonce, identity);
    await this.options.journal.confirmNativeIdentity(nonce, identity);
  }

  async recordExit(pid: number, exitCode: number | null): Promise<boolean> {
    const nonce = this.pidToNonce.get(pid);
    if (!nonce) return false;
    this.pidToNonce.delete(pid);
    const before = await this.options.journal.snapshot();
    const pgid = before.launches[nonce]?.pgid;
    if (!pgid) {
      await this.options.journal.recordExit(nonce, { exitCode, exitedAt: new Date().toISOString() });
      return false;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const group = await (this.options.readGroupEvidence ?? readProcessGroupEvidence)(pgid);
      if (group.complete && group.members.length === 0) {
        await this.options.journal.terminalizeAndReleaseLeases(
          nonce,
          { exitCode, exitedAt: new Date().toISOString() },
          true
        );
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.options.journal.recordExit(nonce, { exitCode, exitedAt: new Date().toISOString() });
    return false;
  }

  launchNonceForPid(pid: number): string | undefined {
    return this.pidToNonce.get(pid);
  }

  async recordForcedOutcome(launchNonce: string, reason: 'runner-recycle-sigkill'): Promise<void> {
    await this.options.journal.appendOutcome(launchNonce, {
      lifecycleState: 'stopped',
      stoppedBy: 'runner-forced',
      stopReasonCode: reason
    });
  }

  private hasManagedFlag(argv: string[], flag: string, value: string): boolean {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] === value;
  }

  private hasManagedIdentity(identity: ProcessIdentity, launch: PreparedManagedLaunch): boolean {
    return this.hasManagedFlag(identity.argv, '--hapi-launch-nonce', launch.launchNonce)
      && this.hasManagedFlag(identity.argv, '--hapi-runner-instance', this.options.runnerInstanceId);
  }

  private sameKernelProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
    return right.evidenceSource !== 'ps'
      && left.pid === right.pid
      && left.uid === right.uid
      && left.birthToken === right.birthToken
      && left.pgid === right.pgid
      && left.executableRealpath === right.executableRealpath;
  }

  private async readSettledSpawnIdentity(
    launch: PreparedManagedLaunch,
    pid: number
  ): Promise<ProcessIdentity | null> {
    const readIdentity = this.options.readIdentity ?? readProcessIdentity;
    let identity = await readIdentity(pid);
    if (!identity || identity.evidenceSource === 'ps'
      || identity.executableRealpath !== this.options.runtimeRealpath
      || this.hasManagedIdentity(identity, launch)) {
      return identity;
    }

    // Bun can expose the detached child between process creation and exec on
    // Linux. Retry only while the immutable kernel binding remains identical;
    // PID reuse, runtime changes, and fallback evidence still fail closed.
    const initialIdentity = identity;
    for (let attempt = 1; attempt < SPAWN_IDENTITY_SETTLE_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, SPAWN_IDENTITY_SETTLE_INTERVAL_MS));
      const candidate = await readIdentity(pid);
      if (!candidate || candidate.evidenceSource === 'ps') continue;
      if (!this.sameKernelProcess(initialIdentity, candidate)) {
        throw new Error(`spawned process kernel identity changed before ownership arguments settled for PID ${pid}`);
      }
      identity = candidate;
      if (this.hasManagedIdentity(identity, launch)) return identity;
    }
    return identity;
  }

  private nativeLeaseKey(provider: string, identity: { nativeResumeId: string; resumeProfileFingerprint: string }): string {
    return createHash('sha256')
      .update(JSON.stringify([provider, identity.resumeProfileFingerprint, identity.nativeResumeId]))
      .digest('hex');
  }
}
