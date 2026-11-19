export type ExitedProcessGroup = { pgid: number; startMarker: string }

export class ExitedProcessGroups {
  private readonly bySessionId = new Map<string, ExitedProcessGroup>();

  constructor(private readonly maxAliases = 1024) {}

  get(id: string): ExitedProcessGroup | undefined {
    return this.bySessionId.get(id);
  }

  delete(id: string): void {
    this.bySessionId.delete(id);
  }

  remember(group: ExitedProcessGroup, ids: Iterable<string | undefined>): void {
    for (const id of ids) {
      if (!id) continue;
      this.bySessionId.delete(id);
      this.bySessionId.set(id, group);
      if (this.bySessionId.size > this.maxAliases) {
        this.bySessionId.delete(this.bySessionId.keys().next().value!);
      }
    }
  }

  prune(isGone: (pgid: number) => boolean): void {
    const probes = new Map<number, boolean>();
    for (const [id, { pgid }] of this.bySessionId) {
      let gone = probes.get(pgid);
      if (gone === undefined) {
        gone = isGone(pgid);
        probes.set(pgid, gone);
      }
      if (gone) this.bySessionId.delete(id);
    }
  }

  forget(group: ExitedProcessGroup): void {
    for (const [id, current] of this.bySessionId) {
      if (current.pgid === group.pgid && current.startMarker === group.startMarker) {
        this.bySessionId.delete(id);
      }
    }
  }
}
