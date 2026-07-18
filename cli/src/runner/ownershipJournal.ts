import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type LaunchLifecycle = 'admitted' | 'spawned' | 'running' | 'stopping' | 'stopped' | 'ambiguous';
export type JournalHealth = 'healthy' | 'corrupt';

export interface LaunchReservation {
  launchNonce: string;
  spawnRequestId?: string;
  runnerInstanceId: string;
  runnerPid: number;
  runnerBirthToken: string;
  helperPid: number;
  helperBirthToken: string;
  bootId: string;
  provider: string;
  runtimeRealpath: string;
  argvNonce: string;
  launchPublicKey: string;
  resumeProfileFingerprint?: string;
  createdAt: string;
}

export interface SpawnIdentity {
  pid: number;
  uid: number;
  birthToken: string;
  pgid: number;
}

export interface LaunchRecord extends LaunchReservation, Partial<SpawnIdentity> {
  lifecycle: LaunchLifecycle;
  hapiSessionId?: string;
  nativeResumeId?: string;
  resumeProfileFingerprint?: string;
  nativeIdentityConfirmedAt?: string;
  recycleIntent?: { pid: number; birthToken: string; reason: string; writtenAt: string };
  exitCode?: number | null;
  exitedAt?: string;
  processGroupProvenEmptyAt?: string;
}

export function hasProvenEmptyProcessGroup(
  launch: Pick<LaunchRecord, 'processGroupProvenEmptyAt'>
): boolean {
  return typeof launch.processGroupProvenEmptyAt === 'string'
    && Number.isFinite(Date.parse(launch.processGroupProvenEmptyAt));
}

export interface ManagedOutcome {
  lifecycleState: 'running' | 'archived' | 'stopped' | 'unhealthy';
  stoppedBy?: 'runner-recycle' | 'runner-forced';
  stopReasonCode?: 'runner-recycle' | 'runner-recycle-sigkill' | 'stale-owner-term' | 'stale-owner-sigkill' | 'ambiguous-turn-delivery';
}

export type JournalOutcomeItem = ManagedOutcome & {
  outcomeId: string;
  launchNonce: string;
  writtenAt: string;
};

export interface StartAttemptInput {
  attemptId: string;
  runnerPid: number;
  runnerBirthToken: string;
  helperPid: number;
  helperBirthToken: string;
  bootId: string;
  runnerInstanceId: string;
}

interface StartAttempt extends StartAttemptInput {
  status: 'open' | 'complete' | 'canceled';
  openedAt: string;
  completedAt?: string;
  completionReason?: string;
}

export interface OwnershipJournalState {
  schemaVersion: 1;
  installationId: string;
  writerId: string;
  pendingHandoff?: { fromWriterId: string; toWriterId: string; writtenAt: string };
  launches: Record<string, LaunchRecord>;
  leases: Record<string, { launchNonce: string; acquiredAt: string; pid?: number; birthToken?: string; pgid?: number }>;
  outbox: JournalOutcomeItem[];
  startAttempts: Record<string, StartAttempt>;
  updatedAt: string;
}

type JournalOptions = {
  home: string;
  writerId: string;
  now?: () => number;
  assertOwner?: () => void;
};

const JOURNAL_NAME = 'runner-sessions.v1.json';
const INSTALLATION_ID_NAME = 'installation-id';
const TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60_000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertState(value: unknown): asserts value is OwnershipJournalState {
  if (!value || typeof value !== 'object') throw new Error('journal is not an object');
  const state = value as Partial<OwnershipJournalState>;
  if (state.schemaVersion !== 1 || typeof state.installationId !== 'string' || typeof state.writerId !== 'string') {
    throw new Error('journal header is invalid');
  }
  if (!state.launches || !state.leases || !Array.isArray(state.outbox) || !state.startAttempts) {
    throw new Error('journal collections are invalid');
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.${JOURNAL_NAME}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  await fsyncDirectory(parent);
}

export async function ensureInstallationId(home: string): Promise<string> {
  const path = join(home, INSTALLATION_ID_NAME);
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (!existing) throw new Error('empty installation id');
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const id = randomUUID();
  const temporary = join(home, `.${INSTALLATION_ID_NAME}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${id}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    await fsyncDirectory(home);
    return id;
  } catch (error) {
    const existing = await readFile(path, 'utf8').then((contents) => contents.trim()).catch(() => '');
    if (existing) return existing;
    throw error;
  }
}

export class OwnershipJournal {
  readonly home: string;
  readonly path: string;
  readonly writerId: string;
  health: JournalHealth;

  private state: OwnershipJournalState | null;
  private readonly now: () => number;
  private readonly assertOwner?: () => void;
  private operation: Promise<void> = Promise.resolve();

  private constructor(options: JournalOptions, state: OwnershipJournalState | null, health: JournalHealth) {
    this.home = resolve(options.home);
    this.path = join(this.home, JOURNAL_NAME);
    this.writerId = options.writerId;
    this.now = options.now ?? Date.now;
    this.assertOwner = options.assertOwner;
    this.state = state;
    this.health = health;
  }

  static async open(options: JournalOptions): Promise<OwnershipJournal> {
    const home = resolve(options.home);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const installationId = await ensureInstallationId(home);
    const path = join(home, JOURNAL_NAME);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      assertState(parsed);
      return new OwnershipJournal(options, parsed, 'healthy');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return new OwnershipJournal(options, null, 'corrupt');
      }
    }

    const now = new Date((options.now ?? Date.now)()).toISOString();
    const state: OwnershipJournalState = {
      schemaVersion: 1,
      installationId,
      writerId: options.writerId,
      launches: {},
      leases: {},
      outbox: [],
      startAttempts: {},
      updatedAt: now
    };
    await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
    return new OwnershipJournal(options, state, 'healthy');
  }

  async snapshot(): Promise<OwnershipJournalState> {
    this.assertOwner?.();
    if (!this.state || this.health !== 'healthy') throw new Error('ownership journal is corrupt');
    return clone(this.state);
  }

  /** Called only while the caller holds and has revalidated the canonical kernel lock. */
  async claimWriterAfterKernelLock(): Promise<void> {
    await this.serial(async () => {
      this.assertOwner?.();
      await this.reload();
      const state = this.requireHealthy();
      state.writerId = this.writerId;
      delete state.pendingHandoff;
      state.updatedAt = this.timestamp();
      await this.persist();
      this.assertOwner?.();
    });
  }

  async quarantineAndReset(): Promise<string> {
    return this.serial(async () => {
      if (this.health !== 'corrupt') throw new Error('ownership journal is not corrupt');
      const quarantine = `${this.path}.corrupt.${this.now()}.${randomUUID()}`;
      await rename(this.path, quarantine);
      await fsyncDirectory(this.home);
      const installationId = await ensureInstallationId(this.home);
      const now = this.timestamp();
      this.state = {
        schemaVersion: 1,
        installationId,
        writerId: this.writerId,
        launches: {}, leases: {}, outbox: [], startAttempts: {}, updatedAt: now
      };
      this.health = 'healthy';
      try {
        await this.persist();
      } catch (error) {
        this.health = 'corrupt';
        this.state = null;
        throw error;
      }
      return quarantine;
    });
  }

  async reserveLaunch(input: LaunchReservation): Promise<void> {
    await this.mutate((state) => {
      if (state.launches[input.launchNonce]) throw new Error(`launch ${input.launchNonce} is already reserved`);
      state.launches[input.launchNonce] = { ...input, lifecycle: 'admitted' };
    });
    const bindingPath = join(this.home, 'launch-bindings', `${input.launchNonce}.json`);
    await mkdir(dirname(bindingPath), { recursive: true, mode: 0o700 });
    await atomicWrite(bindingPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: this.state!.installationId,
      launchNonce: input.launchNonce,
      runnerInstanceId: input.runnerInstanceId,
      publicKey: input.launchPublicKey
    }, null, 2)}\n`);
  }

  async commitSpawn(launchNonce: string, identity: SpawnIdentity): Promise<void> {
    await this.mutate((state) => {
      const launch = this.launch(state, launchNonce);
      if (launch.lifecycle !== 'admitted') throw new Error(`invalid lifecycle transition ${launch.lifecycle} -> spawned`);
      Object.assign(launch, identity, { lifecycle: 'spawned' as const });
      for (const lease of Object.values(state.leases)) {
        if (lease.launchNonce === launchNonce) Object.assign(lease, {
          pid: identity.pid,
          birthToken: identity.birthToken,
          pgid: identity.pgid
        });
      }
    });
  }

  async recordWebhook(launchNonce: string, hapiSessionId: string): Promise<void> {
    await this.mutate((state) => {
      const launch = this.launch(state, launchNonce);
      if (launch.hapiSessionId && launch.hapiSessionId !== hapiSessionId) {
        throw new Error(`managed launch ${launchNonce} already reported a different HAPI session`);
      }
      if (!['spawned', 'running', 'stopped'].includes(launch.lifecycle)) {
        throw new Error(`invalid lifecycle transition ${launch.lifecycle} -> running`);
      }
      launch.hapiSessionId = hapiSessionId;
      if (launch.lifecycle !== 'stopped') launch.lifecycle = 'running';
    });
  }

  async recordNativeIdentity(launchNonce: string, identity: { nativeResumeId: string; resumeProfileFingerprint: string }): Promise<void> {
    await this.mutate((state) => Object.assign(this.launch(state, launchNonce), identity));
  }

  async confirmNativeIdentity(launchNonce: string, identity: { nativeResumeId: string; resumeProfileFingerprint: string }): Promise<void> {
    await this.mutate((state) => {
      const launch = this.launch(state, launchNonce);
      if (launch.nativeResumeId !== identity.nativeResumeId
        || launch.resumeProfileFingerprint !== identity.resumeProfileFingerprint) {
        throw new Error('native identity confirmation mismatch');
      }
      launch.nativeIdentityConfirmedAt = this.timestamp();
    });
  }

  async rebindNativeIdentity(
    launchNonce: string,
    previousLeaseKey: string,
    nextLeaseKey: string,
    identity: { nativeResumeId: string; resumeProfileFingerprint: string }
  ): Promise<void> {
    await this.mutate((state) => {
      const launch = this.launch(state, launchNonce);
      if (!launch.nativeIdentityConfirmedAt) throw new Error('native identity is not confirmed');
      if (launch.resumeProfileFingerprint !== identity.resumeProfileFingerprint) {
        throw new Error('native identity profile mismatch');
      }
      const previous = state.leases[previousLeaseKey];
      if (!previous || previous.launchNonce !== launchNonce) throw new Error('previous native lease owner mismatch');
      const next = state.leases[nextLeaseKey];
      if (next && next.launchNonce !== launchNonce) throw new Error(`native lease ${nextLeaseKey} is already owned`);
      state.leases[nextLeaseKey] = {
        ...previous,
        acquiredAt: next?.acquiredAt ?? previous.acquiredAt
      };
      if (previousLeaseKey !== nextLeaseKey) delete state.leases[previousLeaseKey];
      Object.assign(launch, identity, { nativeIdentityConfirmedAt: this.timestamp() });
    });
  }

  async writeRecycleIntent(launchNonce: string, intent: { pid: number; birthToken: string; reason: string }): Promise<void> {
    await this.mutate((state) => {
      const launch = this.launch(state, launchNonce);
      if (launch.pid !== intent.pid || launch.birthToken !== intent.birthToken) throw new Error('recycle intent identity mismatch');
      launch.lifecycle = 'stopping';
      launch.recycleIntent = { ...intent, writtenAt: this.timestamp() };
    });
  }

  async recordExit(launchNonce: string, exit: { exitCode: number | null; exitedAt: string }): Promise<void> {
    await this.mutate((state) => {
      const launch = this.launch(state, launchNonce);
      if (!['admitted', 'spawned', 'running', 'stopping', 'ambiguous'].includes(launch.lifecycle)) {
        throw new Error(`invalid lifecycle transition ${launch.lifecycle} -> stopped`);
      }
      Object.assign(launch, exit, { lifecycle: 'stopped' as const });
    });
  }

  async terminalizeAndReleaseLeases(
    launchNonce: string,
    exit: { exitCode: number | null; exitedAt: string },
    processGroupProvenEmpty: boolean
  ): Promise<void> {
    if (!processGroupProvenEmpty) throw new Error('terminalization requires a proven empty process group');
    await this.mutate((state) => {
      const launch = this.launch(state, launchNonce);
      if (!['admitted', 'spawned', 'running', 'stopping', 'ambiguous', 'stopped'].includes(launch.lifecycle)) {
        throw new Error(`invalid lifecycle transition ${launch.lifecycle} -> stopped`);
      }
      Object.assign(launch, exit, {
        lifecycle: 'stopped' as const,
        processGroupProvenEmptyAt: this.timestamp()
      });
      for (const [key, lease] of Object.entries(state.leases)) {
        if (lease.launchNonce === launchNonce) delete state.leases[key];
      }
    });
  }

  async appendOutcome(launchNonce: string, outcome: ManagedOutcome, outcomeId: string = randomUUID()): Promise<void> {
    await this.mutate((state) => {
      this.launch(state, launchNonce);
      const existing = state.outbox.find((item) => item.outcomeId === outcomeId);
      if (existing) {
        const existingOutcome: ManagedOutcome = {
          lifecycleState: existing.lifecycleState,
          stoppedBy: existing.stoppedBy,
          stopReasonCode: existing.stopReasonCode
        };
        if (existing.launchNonce !== launchNonce || JSON.stringify(existingOutcome) !== JSON.stringify(outcome)) {
          throw new Error(`outcome idempotency conflict for ${outcomeId}`);
        }
        return;
      }
      state.outbox.push({ ...outcome, outcomeId, launchNonce, writtenAt: this.timestamp() });
    });
  }

  async acknowledgeOutcome(outcomeId: string): Promise<boolean> {
    let removed = false;
    await this.mutate((state) => {
      const index = state.outbox.findIndex((item) => item.outcomeId === outcomeId);
      if (index >= 0) {
        state.outbox.splice(index, 1);
        removed = true;
      }
    });
    return removed;
  }

  async acquireNativeLease(key: string, launchNonce: string): Promise<void> {
    await this.mutate((state) => {
      const existing = state.leases[key];
      if (existing && existing.launchNonce !== launchNonce) throw new Error(`native lease ${key} is already owned`);
      const launch = this.launch(state, launchNonce);
      state.leases[key] = {
        launchNonce,
        acquiredAt: existing?.acquiredAt ?? this.timestamp(),
        ...(launch.pid && launch.birthToken && launch.pgid
          ? { pid: launch.pid, birthToken: launch.birthToken, pgid: launch.pgid }
          : {})
      };
    });
  }

  async releaseNativeLease(key: string, launchNonce: string, processGroupProvenEmpty: boolean): Promise<void> {
    await this.mutate((state) => {
      const existing = state.leases[key];
      if (!existing || existing.launchNonce !== launchNonce) throw new Error(`native lease ${key} owner mismatch`);
      if (!processGroupProvenEmpty) throw new Error('native lease requires a proven empty process group');
      delete state.leases[key];
    });
  }

  async openStartAttempt(input: StartAttemptInput): Promise<void> {
    await this.mutate((state) => {
      if (state.startAttempts[input.attemptId]) throw new Error(`start attempt ${input.attemptId} already exists`);
      state.startAttempts[input.attemptId] = { ...input, status: 'open', openedAt: this.timestamp() };
    });
  }

  async completeStartAttempt(attemptId: string, reason: string): Promise<void> {
    await this.mutate((state) => {
      const attempt = state.startAttempts[attemptId];
      if (!attempt) throw new Error(`start attempt ${attemptId} is missing`);
      if (attempt.status !== 'open') throw new Error(`start attempt ${attemptId} is already complete`);
      attempt.status = 'complete';
      attempt.completedAt = this.timestamp();
      attempt.completionReason = reason;
    });
  }

  async cancelStartAttempt(attemptId: string, reason: string): Promise<void> {
    await this.mutate((state) => {
      const attempt = state.startAttempts[attemptId];
      if (!attempt) throw new Error(`start attempt ${attemptId} is missing`);
      if (attempt.status !== 'open') return;
      attempt.status = 'canceled';
      attempt.completedAt = this.timestamp();
      attempt.completionReason = reason;
    });
  }

  async authorizeHandoff(toWriterId: string): Promise<void> {
    await this.mutate((state) => {
      state.pendingHandoff = { fromWriterId: this.writerId, toWriterId, writtenAt: this.timestamp() };
    });
  }

  async acceptHandoff(fromWriterId: string): Promise<void> {
    await this.serial(async () => {
      await this.reload();
      const state = this.requireHealthy();
      const handoff = state.pendingHandoff;
      if (!handoff || handoff.fromWriterId !== fromWriterId || handoff.toWriterId !== this.writerId || state.writerId !== fromWriterId) {
        throw new Error('owner handoff evidence does not match');
      }
      state.writerId = this.writerId;
      delete state.pendingHandoff;
      state.updatedAt = this.timestamp();
      await this.persist();
    });
  }

  async compact(): Promise<string[]> {
    const removed: string[] = [];
    await this.mutate((state) => {
      const cutoff = this.now() - TERMINAL_RETENTION_MS;
      const launchesWithPendingOutcomes = new Set(state.outbox.map((item) => item.launchNonce));
      for (const [nonce, launch] of Object.entries(state.launches)) {
        if (launch.lifecycle === 'stopped'
          && launch.exitedAt
          && hasProvenEmptyProcessGroup(launch)
          && !launchesWithPendingOutcomes.has(nonce)
          && Date.parse(launch.exitedAt) < cutoff) {
          delete state.launches[nonce];
          removed.push(nonce);
        }
      }
    });
    return removed;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private launch(state: OwnershipJournalState, nonce: string): LaunchRecord {
    const launch = state.launches[nonce];
    if (!launch) throw new Error(`launch ${nonce} is missing`);
    return launch;
  }

  private requireHealthy(): OwnershipJournalState {
    if (this.health !== 'healthy' || !this.state) throw new Error('ownership journal is corrupt');
    return this.state;
  }

  private async reload(): Promise<void> {
    if (this.health !== 'healthy') throw new Error('ownership journal is corrupt');
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      assertState(parsed);
      this.state = parsed;
    } catch (error) {
      this.health = 'corrupt';
      this.state = null;
      throw new Error(`ownership journal became corrupt: ${(error as Error).message}`);
    }
  }

  private async mutate(change: (state: OwnershipJournalState) => void): Promise<void> {
    await this.serial(async () => {
      this.assertOwner?.();
      await this.reload();
      const state = this.requireHealthy();
      if (state.writerId !== this.writerId) throw new Error(`ownership journal owner is ${state.writerId}, not ${this.writerId}`);
      change(state);
      state.updatedAt = this.timestamp();
      await this.persist();
      this.assertOwner?.();
    });
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.requireHealthy(), null, 2)}\n`);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolveOperation) => { release = resolveOperation; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
