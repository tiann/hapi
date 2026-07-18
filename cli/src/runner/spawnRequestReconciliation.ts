import type { SpawnSessionResult } from '@/modules/common/rpcTypes';

import {
  hasProvenEmptyProcessGroup,
  type LaunchRecord,
  type OwnershipJournal
} from './ownershipJournal';
import type { PendingSpawnRequest, SpawnRequestStore } from './spawnRequestStore';
import { proveRecordedProcessGroupEmpty, type RecordedProcessGroupEvidence } from './startupAbsence';

type TerminalSpawnResult = Exclude<SpawnSessionResult, { type: 'pending' }>;

export type StoppedLaunchProofResult = {
  launchNonce: string;
  outcome: 'proven-empty' | 'retained-unproven';
};

type CanonicalManagedWebhook = {
  pid: number;
  sessionId: string;
  launchNonce: string;
  runnerInstanceId: string;
};

export async function settleCanonicalManagedWebhook(options: {
  pid: number;
  sessionId: string;
  launchNonce?: string;
  runnerInstanceId?: string;
  recordIdentity: (input: CanonicalManagedWebhook) => Promise<boolean>;
  completeSuccess: (input: CanonicalManagedWebhook) => Promise<boolean>;
}): Promise<boolean> {
  if (!options.launchNonce || !options.runnerInstanceId) return false;
  const input: CanonicalManagedWebhook = {
    pid: options.pid,
    sessionId: options.sessionId,
    launchNonce: options.launchNonce,
    runnerInstanceId: options.runnerInstanceId
  };
  if (!await options.recordIdentity(input)) return false;
  return await options.completeSuccess(input);
}

export async function settleSpawnRequestAfterExit(options: {
  proveProcessGroupEmpty: () => Promise<boolean>;
  completeTerminalError: () => Promise<void>;
}): Promise<'pending' | 'terminal'> {
  if (!await options.proveProcessGroupEmpty()) return 'pending';
  await options.completeTerminalError();
  return 'terminal';
}

export async function reconcileStoppedLaunchProofs(options: {
  journal: Pick<OwnershipJournal, 'snapshot' | 'terminalizeAndReleaseLeases'>;
  readGroup: (pgid: number) => Promise<RecordedProcessGroupEvidence>;
  now?: () => number;
}): Promise<StoppedLaunchProofResult[]> {
  const snapshot = await options.journal.snapshot();
  const results: StoppedLaunchProofResult[] = [];
  for (const launch of Object.values(snapshot.launches)) {
    if (launch.lifecycle !== 'stopped' || hasProvenEmptyProcessGroup(launch)) continue;
    const recordedPgids = new Set<number>();
    if (launch.pgid) recordedPgids.add(launch.pgid);
    for (const lease of Object.values(snapshot.leases)) {
      if (lease.launchNonce === launch.launchNonce && lease.pgid) recordedPgids.add(lease.pgid);
    }
    const [pgid] = recordedPgids;
    const processGroupProvenEmpty = recordedPgids.size === 1 && await proveRecordedProcessGroupEmpty({
      launchPgid: pgid,
      readGroup: options.readGroup
    });
    if (!processGroupProvenEmpty) {
      results.push({ launchNonce: launch.launchNonce, outcome: 'retained-unproven' });
      continue;
    }
    await options.journal.terminalizeAndReleaseLeases(launch.launchNonce, {
      exitCode: launch.exitCode ?? null,
      exitedAt: launch.exitedAt ?? new Date((options.now ?? Date.now)()).toISOString()
    }, true);
    results.push({ launchNonce: launch.launchNonce, outcome: 'proven-empty' });
  }
  return results;
}

export async function settleProvenEmptyLaunchRequests(options: {
  launches: Record<string, LaunchRecord>;
  settle: (launch: LaunchRecord) => Promise<void>;
}): Promise<string[]> {
  const settled: string[] = [];
  for (const launch of Object.values(options.launches)) {
    if (!hasProvenEmptyProcessGroup(launch)) continue;
    await options.settle(launch);
    settled.push(launch.launchNonce);
  }
  return settled;
}

export function isAdmittedLaunchProvenAbsent(
  launch: LaunchRecord,
  evidence: { complete: boolean; matches: readonly unknown[] }
): boolean {
  return launch.lifecycle === 'admitted'
    && launch.pid === undefined
    && evidence.complete
    && evidence.matches.length === 0;
}

export async function reconcileAdmittedLaunchAbsence(options: {
  launches: Record<string, LaunchRecord>;
  findEvidence: (launch: LaunchRecord) => Promise<{ complete: boolean; matches: readonly unknown[] }>;
  terminalize: (launchNonce: string) => Promise<void>;
}): Promise<string[]> {
  const terminalized: string[] = [];
  for (const launch of Object.values(options.launches)) {
    if (launch.lifecycle !== 'admitted' || launch.pid !== undefined) continue;
    const evidence = await options.findEvidence(launch);
    if (!isAdmittedLaunchProvenAbsent(launch, evidence)) continue;
    await options.terminalize(launch.launchNonce);
    terminalized.push(launch.launchNonce);
  }
  return terminalized;
}

export async function reconcileNonDestructiveLaunchAbsence(options: {
  launches: Record<string, LaunchRecord>;
  excludedLaunchNonces?: ReadonlySet<string>;
  findEvidence: (launch: LaunchRecord) => Promise<{ complete: boolean; matches: readonly unknown[] }>;
  readGroup: (pgid: number) => Promise<RecordedProcessGroupEvidence>;
  terminalize: (launchNonce: string) => Promise<void>;
  groupProbeAttempts?: number;
  groupProbeDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<string[]> {
  const terminalized: string[] = [];
  for (const launch of Object.values(options.launches)) {
    if (launch.lifecycle === 'stopped' || options.excludedLaunchNonces?.has(launch.launchNonce)) continue;
    const evidence = await options.findEvidence(launch);
    if (!evidence.complete || evidence.matches.length !== 0) continue;
    const admittedAbsent = isAdmittedLaunchProvenAbsent(launch, evidence);
    let recordedGroupEmpty = false;
    const attempts = Math.max(1, options.groupProbeAttempts ?? 1);
    for (let attempt = 1; !admittedAbsent && attempt <= attempts; attempt += 1) {
      recordedGroupEmpty = await proveRecordedProcessGroupEmpty({
        launchPgid: launch.pgid,
        readGroup: options.readGroup
      });
      if (recordedGroupEmpty || attempt === attempts) break;
      await (options.sleep?.(options.groupProbeDelayMs ?? 0)
        ?? new Promise((resolve) => setTimeout(resolve, options.groupProbeDelayMs ?? 0)));
    }
    if (!admittedAbsent && !recordedGroupEmpty) continue;
    await options.terminalize(launch.launchNonce);
    terminalized.push(launch.launchNonce);
  }
  return terminalized;
}

export async function restorePendingLaunchBindings(options: {
  store: Pick<SpawnRequestStore, 'listPending' | 'attachLaunchIdentity' | 'attachPid'>;
  launches: Record<string, LaunchRecord>;
}): Promise<number> {
  let restored = 0;
  for (const pending of await options.store.listPending()) {
    const candidates = Object.values(options.launches)
      .filter((launch) => launch.spawnRequestId === pending.spawnRequestId);
    let launch: LaunchRecord | undefined;
    if (pending.launchNonce && pending.runnerInstanceId) {
      launch = candidates.find((candidate) => (
        candidate.launchNonce === pending.launchNonce
        && candidate.runnerInstanceId === pending.runnerInstanceId
      ));
    } else if (!pending.launchNonce && !pending.runnerInstanceId) {
      const active = candidates.filter((candidate) => candidate.lifecycle !== 'stopped');
      if (active.length === 1) launch = active[0];
      else if (active.length === 0 && candidates.length === 1) launch = candidates[0];
    }
    if (!launch) continue;
    const identity = {
      launchNonce: launch.launchNonce,
      runnerInstanceId: launch.runnerInstanceId
    };
    if (pending.launchNonce !== launch.launchNonce
      || pending.runnerInstanceId !== launch.runnerInstanceId) {
      await options.store.attachLaunchIdentity(pending.spawnRequestId, identity);
      restored += 1;
    }
    if (launch.pid !== undefined && pending.pid === undefined) {
      await options.store.attachPid(pending.spawnRequestId, launch.pid, identity);
      restored += 1;
    }
  }
  return restored;
}

export function resolvePersistedPendingSpawn(
  pending: PendingSpawnRequest,
  launch: LaunchRecord | undefined,
): TerminalSpawnResult | null {
  if (!pending.launchNonce && !pending.runnerInstanceId) {
    return {
      type: 'error',
      errorMessage: pending.pid === undefined
        ? 'Managed spawn was not durably reserved before Runner restart'
        : 'Managed spawn lacks durable launch identity after Runner restart'
    };
  }
  if (!pending.launchNonce || !pending.runnerInstanceId || !launch) {
    return {
      type: 'error',
      errorMessage: 'Managed spawn launch record is unavailable after Runner restart'
    };
  }
  if (launch.launchNonce !== pending.launchNonce
    || launch.runnerInstanceId !== pending.runnerInstanceId) {
    return null;
  }
  if (launch.lifecycle === 'stopped' && hasProvenEmptyProcessGroup(launch)) {
    if (pending.pid !== undefined && launch.pid !== undefined && launch.pid !== pending.pid) return null;
    if (launch.hapiSessionId) return { type: 'success', sessionId: launch.hapiSessionId };
    return {
      type: 'error',
      errorMessage: 'Managed spawn ended before session registration after Runner restart'
    };
  }
  if (pending.pid !== undefined && launch.pid !== pending.pid) return null;
  if (pending.pid === undefined && launch.pid === undefined
    && !(launch.lifecycle === 'stopped' && hasProvenEmptyProcessGroup(launch))) return null;
  if (launch.hapiSessionId) {
    return { type: 'success', sessionId: launch.hapiSessionId };
  }
  return null;
}
