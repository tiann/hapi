import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ windows: vi.fn(() => true), snapshot: vi.fn(), alive: vi.fn((_pid: number) => false), marker: vi.fn<() => string | null>(() => null) }));
vi.mock('@/utils/process', () => ({ isWindows: mocks.windows, isProcessAlive: mocks.alive, getProcessStartMarker: mocks.marker }));
vi.mock('@/utils/windowsProcessStop', () => ({ readWindowsProcessTable: mocks.snapshot }));
import { type CodexRuntimeRecord } from '@/codex/shared/registry';
import { readStopRuntimeCandidates } from './stopRuntimes';
import { wrapperHasActiveSiblingRoots } from './sharedSessionStop';

describe('stop runtime candidates', () => {
    const records: CodexRuntimeRecord[] = [{ id: 'retired', pid: 42, marker: 'original', endpoint: '', command: '', args: [], codexHome: '', hub: '', authHash: '', sessions: { sibling: { active: true, threadId: 'thread', namespace: 'test' } } }];
    beforeEach(() => { vi.clearAllMocks(); mocks.windows.mockReturnValue(true); });
    it('retains potentially live siblings on a failed snapshot without blocking unrelated targets', async () => {
        mocks.snapshot.mockResolvedValue(null);
        const candidates = await readStopRuntimeCandidates(records, 'claude-session');
        expect(candidates).toEqual(records);
        expect(wrapperHasActiveSiblingRoots(candidates, 'claude-session', 99)).toBe(false);
        expect(wrapperHasActiveSiblingRoots(candidates, 'claude-session', 42)).toBe(true);
        expect(mocks.alive).not.toHaveBeenCalled();
    });
    it('filters a stale active binding when a complete snapshot has no live PIDs', async () => {
        mocks.snapshot.mockResolvedValue(new Map());
        expect(await readStopRuntimeCandidates(records, 'claude-session')).toEqual([]);
        expect(mocks.alive).not.toHaveBeenCalled();
    });
    it('reuses exact positive generations, but retries negative and unknown matches', async () => {
        const knownLive = new Set<string>();
        const owner = records[0];
        const other = { ...owner, id: 'other', pid: 43 };
        mocks.snapshot.mockResolvedValueOnce(new Map([[42, { marker: owner.marker }], [43, { marker: null }]]));
        expect(await readStopRuntimeCandidates([owner, other], 'target', knownLive)).toEqual([owner, other]);
        mocks.snapshot.mockResolvedValueOnce(new Map());
        expect(await readStopRuntimeCandidates([owner, other], 'target', knownLive)).toEqual([owner]);
        expect(mocks.snapshot).toHaveBeenLastCalledWith(10_000, [43]);
    });
    it('reuses proven POSIX generations across registry reads', async () => {
        mocks.windows.mockReturnValue(false);
        mocks.alive.mockReturnValue(true);
        const owner = { ...records[0], marker: 'posix-marker' };
        mocks.marker.mockImplementation(() => owner.marker);
        const knownLive = new Set<string>();
        expect(await readStopRuntimeCandidates([owner], 'target', knownLive)).toEqual([owner]);
        expect(await readStopRuntimeCandidates([owner], 'target', knownLive)).toEqual([owner]);
        expect(mocks.alive).toHaveBeenCalledTimes(1);
        expect(mocks.marker).toHaveBeenCalledTimes(1);
    });
    it('filters proven retired generations using one complete snapshot', async () => {
        mocks.snapshot.mockResolvedValue(new Map([[42, { parentPid: 0, marker: 'replacement', name: 'codex', commandLine: 'codex' }]]));
        expect(await readStopRuntimeCandidates(records, 'claude-session')).toEqual([]);
        expect(mocks.alive).not.toHaveBeenCalled();
    });
});
