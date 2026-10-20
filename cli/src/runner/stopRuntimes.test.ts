import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ windows: vi.fn(() => true), snapshot: vi.fn(), alive: vi.fn((_pid: number) => false), marker: vi.fn(() => null) }));
vi.mock('@/utils/process', () => ({ isWindows: mocks.windows, isProcessAlive: mocks.alive, getProcessStartMarker: mocks.marker }));
vi.mock('./orphanReap', () => ({ listWindowsProcessesWithCommandLine: mocks.snapshot }));
import { type CodexRuntimeRecord } from '@/codex/shared/registry';
import { readStopRuntimeCandidates } from './stopRuntimes';
import { wrapperHasActiveSiblingRoots } from './sharedSessionStop';

describe('stop runtime candidates', () => {
    const records: CodexRuntimeRecord[] = [{ id: 'retired', pid: 42, marker: 'original', endpoint: '', command: '', args: [], codexHome: '', hub: '', authHash: '', sessions: { sibling: { active: true, threadId: 'thread', namespace: 'test' } } }];
    beforeEach(() => { vi.clearAllMocks(); mocks.windows.mockReturnValue(true); });
    it.each(['failed', 'empty'])('retains potentially live siblings on a %s snapshot without blocking unrelated targets', kind => {
        mocks.snapshot.mockImplementation(() => { if (kind === 'failed') throw new Error('CIM unavailable'); return []; });
        const candidates = readStopRuntimeCandidates(records, 'claude-session');
        expect(candidates).toEqual(records);
        expect(wrapperHasActiveSiblingRoots(candidates, 'claude-session', 99)).toBe(false);
        expect(wrapperHasActiveSiblingRoots(candidates, 'claude-session', 42)).toBe(true);
        expect(mocks.alive).not.toHaveBeenCalled();
    });
    it('filters proven retired generations using one complete snapshot', () => {
        mocks.snapshot.mockReturnValue([{ pid: 42, startMarker: 'replacement' }]);
        expect(readStopRuntimeCandidates(records, 'claude-session')).toEqual([]);
        expect(mocks.alive).not.toHaveBeenCalled();
    });
});
