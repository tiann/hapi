import type { LaunchRecord } from './ownershipJournal';
import { isCompleteOwnedProcessGroup, type ProcessIdentity } from './processIdentity';

export type ReconciliationClassification = 'current' | 'stale-killable' | 'exited' | 'external' | 'legacy' | 'ambiguous';

export interface ReconciliationEvidence {
  leader: ProcessIdentity | null;
  group: ProcessIdentity[];
  groupComplete?: boolean;
  ownerAlive: boolean;
  conflictingClaim?: boolean;
  hubStopEligible: boolean;
}

export interface ClassificationContext {
  flow: 'normal' | 'startup';
  currentRunnerInstanceId: string;
  currentUid: number;
  hubAvailable: boolean;
  helperHealthy: boolean;
}

function hasExactFlag(argv: string[], flag: string, value: string): boolean {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag && argv[index + 1] === value) return true;
  }
  return false;
}

function identityMatches(record: LaunchRecord, leader: ProcessIdentity, currentUid: number): boolean {
  return leader.evidenceSource !== 'ps'
    && record.pid === leader.pid
    && record.uid === currentUid
    && leader.uid === record.uid
    && record.birthToken === leader.birthToken
    && record.pgid === leader.pgid
    && record.runtimeRealpath === leader.executableRealpath
    && hasExactFlag(leader.argv, '--hapi-launch-nonce', record.argvNonce)
    && hasExactFlag(leader.argv, '--hapi-runner-instance', record.runnerInstanceId);
}

export function classifyLaunch(
  record: LaunchRecord,
  evidence: ReconciliationEvidence,
  context: ClassificationContext
): { classification: ReconciliationClassification; reason: string } {
  if (evidence.groupComplete !== true) {
    return { classification: 'ambiguous', reason: 'process group enumeration was incomplete' };
  }
  if (!evidence.leader) {
    return evidence.group.length === 0
      ? { classification: 'exited', reason: 'recorded process group is empty' }
      : { classification: 'ambiguous', reason: 'wrapper leader exited while descendants remain' };
  }
  if (evidence.conflictingClaim) return { classification: 'ambiguous', reason: 'conflicting journal claim' };
  if (!identityMatches(record, evidence.leader, context.currentUid)) {
    return { classification: 'ambiguous', reason: 'mandatory live identity evidence mismatch' };
  }
  if (!isCompleteOwnedProcessGroup(evidence.leader, { members: evidence.group, complete: true })) {
    return { classification: 'ambiguous', reason: 'process group membership evidence is incomplete or mismatched' };
  }
  if (!context.helperHealthy) return { classification: 'ambiguous', reason: 'runner lock helper is unhealthy' };

  if (context.flow === 'normal') {
    if (record.runnerInstanceId !== context.currentRunnerInstanceId) {
      return { classification: 'external', reason: 'launch belongs to another runner owner' };
    }
    const intent = record.recycleIntent;
    if (!intent || intent.reason !== 'runner-recycle' || intent.pid !== record.pid || intent.birthToken !== record.birthToken) {
      return { classification: 'ambiguous', reason: 'matching durable recycle intent is absent' };
    }
    return { classification: 'current', reason: 'current owner and recycle intent match' };
  }

  if (!context.hubAvailable) return { classification: 'ambiguous', reason: 'hub outcome path unavailable' };
  if (!evidence.hubStopEligible) return { classification: 'ambiguous', reason: 'canonical hub stop barrier is not satisfied' };
  if (record.runnerInstanceId === context.currentRunnerInstanceId) {
    return { classification: 'current', reason: 'launch belongs to current runner' };
  }
  if (evidence.ownerAlive) return { classification: 'external', reason: 'different owner remains alive' };
  return { classification: 'stale-killable', reason: 'different owner is proven gone and identity matches' };
}

export function selectReconciliationCandidates(records: LaunchRecord[], cap: number): LaunchRecord[] {
  return [...records]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.launchNonce.localeCompare(right.launchNonce))
    .slice(0, Math.max(0, cap));
}

export interface ReconciliationAdapters {
  currentRunnerInstanceId: string;
  currentUid: number;
  hubAvailable: boolean;
  helperHealthy: boolean;
  readEvidence(record: LaunchRecord): Promise<ReconciliationEvidence>;
  writeIntent(record: LaunchRecord, reason: 'stale-owner-term' | 'stale-owner-sigkill'): Promise<void>;
  signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  waitForSettlement(record: LaunchRecord): Promise<boolean>;
  readKillSwitch(): Promise<boolean>;
  deadlineAt: number;
  now?: () => number;
  cap?: number;
}

export interface ReconciliationResult {
  launchNonce: string;
  classification: ReconciliationClassification;
  outcome: 'reported' | 'deadline' | 'term-blocked-kill-switch' | 'term-only-kill-switch' | 'stopped-term' | 'stopped-kill' | 'ambiguous-after-term' | 'ambiguous-after-kill';
}

export async function reconcileLaunches(records: LaunchRecord[], adapters: ReconciliationAdapters): Promise<ReconciliationResult[]> {
  const now = adapters.now ?? Date.now;
  if (!adapters.hubAvailable || !adapters.helperHealthy) {
    return records.map((record) => ({ launchNonce: record.launchNonce, classification: 'ambiguous', outcome: 'reported' }));
  }

  const scanCap = Math.max(0, adapters.cap ?? 4);
  const selected = selectReconciliationCandidates(records, records.length);
  const selectedNonces = new Set(selected.map((record) => record.launchNonce));
  const classified: Array<{ record: LaunchRecord; classification: ReturnType<typeof classifyLaunch> }> = [];
  for (const record of selected) {
    classified.push({
      record,
      classification: classifyLaunch(record, await adapters.readEvidence(record), {
      flow: 'startup',
      currentRunnerInstanceId: adapters.currentRunnerInstanceId,
      currentUid: adapters.currentUid,
      hubAvailable: adapters.hubAvailable,
      helperHealthy: adapters.helperHealthy
      })
    });
  }
  const candidates = selectReconciliationCandidates(
    classified.filter((item) => item.classification.classification === 'stale-killable').map((item) => item.record),
    scanCap
  );
  const results: ReconciliationResult[] = records
    .filter((record) => !selectedNonces.has(record.launchNonce))
    .map((record) => ({ launchNonce: record.launchNonce, classification: 'ambiguous', outcome: 'reported' }));
  results.push(...classified
    .filter((item) => item.classification.classification !== 'stale-killable')
    .map((item) => ({ launchNonce: item.record.launchNonce, classification: item.classification.classification, outcome: 'reported' } as ReconciliationResult)));

  const destructive = await Promise.all(candidates.map(async (record): Promise<ReconciliationResult> => {
    if (now() >= adapters.deadlineAt) return { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'deadline' };
    if (await adapters.readKillSwitch()) return { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'reported' };
    const beforeTerm = classifyLaunch(record, await adapters.readEvidence(record), {
      flow: 'startup', currentRunnerInstanceId: adapters.currentRunnerInstanceId,
      currentUid: adapters.currentUid, hubAvailable: adapters.hubAvailable, helperHealthy: adapters.helperHealthy
    });
    if (beforeTerm.classification !== 'stale-killable') {
      return { launchNonce: record.launchNonce, classification: beforeTerm.classification, outcome: 'ambiguous-after-term' };
    }
    await adapters.writeIntent(record, 'stale-owner-term');
    const afterTermIntent = classifyLaunch(record, await adapters.readEvidence(record), {
      flow: 'startup', currentRunnerInstanceId: adapters.currentRunnerInstanceId,
      currentUid: adapters.currentUid, hubAvailable: adapters.hubAvailable, helperHealthy: adapters.helperHealthy
    });
    if (afterTermIntent.classification !== 'stale-killable') {
      return { launchNonce: record.launchNonce, classification: afterTermIntent.classification, outcome: 'ambiguous-after-term' };
    }
    if (await adapters.readKillSwitch()) {
      return { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'term-blocked-kill-switch' };
    }
    await adapters.signalGroup(record.pgid!, 'SIGTERM');
    if (await adapters.waitForSettlement(record)) {
      return { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'stopped-term' };
    }
    if (now() >= adapters.deadlineAt) return { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'deadline' };
    if (await adapters.readKillSwitch()) {
      return { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'term-only-kill-switch' };
    }

    const revalidated = classifyLaunch(record, await adapters.readEvidence(record), {
      flow: 'startup',
      currentRunnerInstanceId: adapters.currentRunnerInstanceId,
      currentUid: adapters.currentUid,
      hubAvailable: adapters.hubAvailable,
      helperHealthy: adapters.helperHealthy
    });
    if (revalidated.classification !== 'stale-killable') {
      return { launchNonce: record.launchNonce, classification: revalidated.classification, outcome: 'ambiguous-after-term' };
    }
    await adapters.writeIntent(record, 'stale-owner-sigkill');
    const afterKillIntent = classifyLaunch(record, await adapters.readEvidence(record), {
      flow: 'startup', currentRunnerInstanceId: adapters.currentRunnerInstanceId,
      currentUid: adapters.currentUid, hubAvailable: adapters.hubAvailable, helperHealthy: adapters.helperHealthy
    });
    if (afterKillIntent.classification !== 'stale-killable') {
      return { launchNonce: record.launchNonce, classification: afterKillIntent.classification, outcome: 'ambiguous-after-kill' };
    }
    if (await adapters.readKillSwitch()) {
      return { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'term-only-kill-switch' };
    }
    await adapters.signalGroup(record.pgid!, 'SIGKILL');
    return await adapters.waitForSettlement(record)
      ? { launchNonce: record.launchNonce, classification: 'stale-killable', outcome: 'stopped-kill' }
      : { launchNonce: record.launchNonce, classification: 'ambiguous', outcome: 'ambiguous-after-kill' };
  }));

  return [...results, ...destructive];
}
