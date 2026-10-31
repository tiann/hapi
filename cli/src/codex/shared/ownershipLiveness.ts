import spawn from 'cross-spawn';
import { windowsProcessListCimCommand } from '@/utils/process';

/** A complete, fresh snapshot; absence is usable only after strict validation. */
export function readOwnershipProcessSnapshot(): ReadonlyMap<number, string | null> {
    const result = spawn.sync('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowsProcessListCimCommand()], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 * 1024
    });
    if (result.error || result.status !== 0) throw new Error('Cannot verify native ownership process snapshot');
    const raw = String(result.stdout ?? '').trim();
    if (!raw) throw new Error('Empty native ownership process snapshot');
    const parsed: unknown = JSON.parse(raw);
    const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const markers = new Map<number, string | null>();
    for (const value of rows) {
        if (!value || typeof value !== 'object') throw new Error('Invalid native ownership process snapshot');
        const row = value as Record<string, unknown>;
        if (typeof row.ProcessId !== 'number' || !Number.isInteger(row.ProcessId) || row.ProcessId < 0
            || markers.has(row.ProcessId)) throw new Error('Invalid native ownership process identity');
        markers.set(row.ProcessId, typeof row.CreationDate === 'string' && row.CreationDate.length > 0 ? row.CreationDate : null);
    }
    // The scanner process is alive throughout enumeration. Missing it means
    // a truncated/unverifiable listing, not proof that other owners exited.
    if (!markers.has(process.pid)) throw new Error('Incomplete native ownership process snapshot');
    return markers;
}

export function snapshotGenerationMayBeAlive(snapshot: ReadonlyMap<number, string | null>, pid: number, marker?: string): boolean {
    if (!snapshot.has(pid)) return false;
    const current = snapshot.get(pid);
    return !current || !marker || current === marker;
}
