export type LegacyProcessObservation = {
  pid: number;
  birthToken: string | null;
  pgid: number | null;
  provider: string | null;
  hapiSessionId: string | null;
  nativeId: string | null;
  activeTurnEvidence: 'active' | 'none' | 'unknown';
  journalLaunchNonce: string | null;
};

export type LegacyJournalReference = {
  launchNonce: string;
};

export type LegacyInventoryEntry = LegacyProcessObservation & {
  ownerClassification: 'journaled-reference' | 'legacy-unjournaled';
  killable: false;
  reason: string;
};

/**
 * Builds a read-only migration inventory. It deliberately cannot authorize a
 * signal: verified journal reconciliation owns that decision, and legacy
 * unjournaled processes always require manual review.
 */
export function buildLegacyInventory(
  observations: LegacyProcessObservation[],
  journal: LegacyJournalReference[]
): LegacyInventoryEntry[] {
  const journalNonces = new Set(journal.map((record) => record.launchNonce));
  return observations
    .map((observation): LegacyInventoryEntry => {
      const journaled = observation.journalLaunchNonce !== null && journalNonces.has(observation.journalLaunchNonce);
      return {
        ...observation,
        ownerClassification: journaled ? 'journaled-reference' : 'legacy-unjournaled',
        killable: false,
        reason: journaled
          ? 'matching journal reference; use verified reconciliation, not legacy cleanup'
          : 'no matching ownership journal record'
      };
    })
    .sort((left, right) => left.pid - right.pid);
}

function field(value: string | number | null): string {
  return value === null ? '-' : String(value).replace(/[\r\n|]/g, '_').slice(0, 160);
}

export function renderLegacyInventoryReport(entries: LegacyInventoryEntry[]): string {
  if (entries.length === 0) return 'No candidate HAPI session processes found.';
  return entries.map((entry) => [
    `PID ${entry.pid}`,
    `birth=${field(entry.birthToken)}`,
    `PGID=${field(entry.pgid)}`,
    `provider=${field(entry.provider)}`,
    `hapiSession=${field(entry.hapiSessionId)}`,
    `nativeId=${field(entry.nativeId)}`,
    `activeTurn=${entry.activeTurnEvidence}`,
    `owner=${entry.ownerClassification}`,
    `killable=no`,
    `reason=${field(entry.reason)}`
  ].join(' | ')).join('\n');
}
