import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { GroupMember } from '@/utils/process';

export type ExitedProcessGroup = { pgid: number; startMarker: string; confirmed?: boolean; members?: GroupMember[] }

export class ExitedProcessGroups {
  private readonly bySessionId = new Map<string, ExitedProcessGroup>();

  private saved: string;

  constructor(private readonly maxAliases = 1024, private readonly storage?: { file: string; machineId: string }) {
    this.saved = this.serialize();
    if (!storage) return;
    try {
      const saved = JSON.parse(readFileSync(storage.file, 'utf8'));
      if (saved.machineId !== storage.machineId || !Array.isArray(saved.receipts)) return;
      for (const row of saved.receipts.slice(-maxAliases)) {
        if (!Array.isArray(row)) continue;
        const [id, pgid, startMarker] = row;
        if (typeof id === 'string' && id && !id.startsWith('PID-') && Number.isSafeInteger(pgid) && pgid > 1
          && typeof startMarker === 'string' && startMarker) {
          this.bySessionId.set(id, { pgid, startMarker, confirmed: true });
        }
      }
      this.saved = this.serialize();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[runner] Could not read cleanup receipts', error);
    }
  }

  private serialize(): string {
    const receipts = [...this.bySessionId].flatMap(([id, group]) =>
      group.confirmed && !id.startsWith('PID-') ? [[id, group.pgid, group.startMarker]] : []);
    return JSON.stringify({ machineId: this.storage?.machineId, receipts });
  }

  persist(): boolean {
    if (!this.storage) return true;
    const snapshot = this.serialize();
    if (snapshot === this.saved) return true;
    const { file } = this.storage;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, snapshot, { mode: 0o600, flush: true });
      renameSync(tmp, file);
      this.saved = snapshot;
      return true;
    } catch (error) {
      console.warn('[runner] Could not persist cleanup receipts', error);
      return false;
    }
  }

  get(id: string): ExitedProcessGroup | undefined {
    return this.bySessionId.get(id);
  }

  delete(id: string): void {
    if (this.bySessionId.delete(id)) this.persist();
  }

  remember(group: ExitedProcessGroup, ids: Iterable<string | undefined>): void {
    for (const id of ids) {
      if (!id) continue;
      const prior = this.bySessionId.get(id);
      if (prior?.pgid === group.pgid && prior.startMarker === group.startMarker
        && (prior.confirmed || (prior.members?.length && !group.members?.length && !group.confirmed))) continue;
      this.bySessionId.delete(id);
      this.bySessionId.set(id, group);
      if (this.bySessionId.size > this.maxAliases) {
        this.bySessionId.delete(this.bySessionId.keys().next().value!);
      }
    }
    this.persist();
  }

  prune(isGone: (pgid: number) => boolean): void {
    const probes = new Map<number, boolean>();
    for (const [id, group] of this.bySessionId) {
      if (group.confirmed) continue;
      const { pgid } = group;
      let gone = probes.get(pgid);
      if (gone === undefined) {
        gone = isGone(pgid);
        probes.set(pgid, gone);
      }
      if (gone) this.bySessionId.set(id, { ...group, confirmed: true });
    }
    this.persist();
  }

  confirm(group: ExitedProcessGroup): void {
    for (const [id, current] of this.bySessionId) {
      if (current.pgid === group.pgid && current.startMarker === group.startMarker) {
        this.bySessionId.set(id, { ...current, confirmed: true });
      }
    }
    this.persist();
  }
}
