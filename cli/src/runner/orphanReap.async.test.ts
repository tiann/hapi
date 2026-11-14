import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(), execFile: mocks.execFile,
}));
import { listWindowsProcessesWithCommandLineAsync } from './orphanReap';

describe('asynchronous Windows process listing', () => {
    beforeEach(() => vi.resetAllMocks());
    const complete = (error: Error | null, stdout: string) => {
        mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(error, stdout, ''));
    };
    it('preserves same-snapshot generations and unknown creation times', async () => {
        complete(null, '[{"ProcessId":0},{"ProcessId":42,"CreationDate":"generation"},{"ProcessId":43}]');
        expect(await listWindowsProcessesWithCommandLineAsync()).toEqual([
            { pid: 42, name: '', cmd: '', startMarker: 'generation' },
            { pid: 43, name: '', cmd: '', startMarker: null },
        ]);
    });
    it.each(['', '[]', '{}', 'null', '[{"ProcessId":42},{}]', '[{"ProcessId":0}]', 'truncated JSON'])
        ('rejects an unverifiable listing: %s', async stdout => {
            complete(null, stdout);
            await expect(listWindowsProcessesWithCommandLineAsync()).rejects.toThrow();
        });
    it.each(['spawn failed', 'query timed out', 'query signalled', 'stdout maxBuffer exceeded'])
        ('does not trust partial stdout after %s', async message => {
            complete(new Error(message), '[{"ProcessId":42,"CreationDate":"generation"}]');
            await expect(listWindowsProcessesWithCommandLineAsync()).rejects.toThrow(message);
        });
});
