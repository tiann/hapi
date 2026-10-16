import { describe, expect, it, vi } from 'vitest';
const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock('cross-spawn', () => ({ default: { sync } }));
import { readOwnershipProcessSnapshot, snapshotGenerationMayBeAlive } from './ownershipLiveness';
function result(stdout: string, status: number | null = 0) { return { stdout, status }; }
describe('native ownership process snapshot', () => {
    it.each(['', '[]', '{}', 'null', '[{"ProcessId":42},{}]'])('rejects incomplete or invalid data: %s', raw => {
        sync.mockReturnValue(result(raw));expect(readOwnershipProcessSnapshot).toThrow();
    });
    it('fails closed on scanner failure even with partial valid output', () => {
        sync.mockReturnValue(result(JSON.stringify([{ ProcessId: process.pid }]), null));
        expect(readOwnershipProcessSnapshot).toThrow();
    });
    it('takes one OS snapshot for many ownership decisions and preserves unknown identities', () => {
        sync.mockClear();sync.mockReturnValue(result(JSON.stringify([
            { ProcessId: process.pid, CreationDate: 'self' }, { ProcessId: 42, CreationDate: 'old' }, { ProcessId: 43, CreationDate: null }
        ])));
        const snapshot = readOwnershipProcessSnapshot();
        for (let id = 1_000_000; id < 1_000_245; id++) expect(snapshotGenerationMayBeAlive(snapshot,id,'ended')).toBe(false);
        expect(snapshotGenerationMayBeAlive(snapshot,42,'old')).toBe(true);
        expect(snapshotGenerationMayBeAlive(snapshot,42,'different')).toBe(false);
        expect(snapshotGenerationMayBeAlive(snapshot,43,'known')).toBe(true);
        expect(snapshotGenerationMayBeAlive(snapshot,42)).toBe(true);
        expect(sync).toHaveBeenCalledTimes(1);
    });
});
