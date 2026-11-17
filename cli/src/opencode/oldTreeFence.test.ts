import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
const { uptimeMock } = vi.hoisted(() => ({ uptimeMock: vi.fn<() => number>() }));

vi.mock('cross-spawn', () => ({ default: { sync: spawnSyncMock } }));
vi.mock('node:os', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:os')>(),
    uptime: uptimeMock
}));

import { stopTrackedAcpProcesses } from './opencodeRemoteLauncher';
import { monotonicTimeMs } from '@/utils/time';

const sleepSynchronously = (ms: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const completed = (stdout: string) => ({ status: 0, stdout: Buffer.from(stdout), stderr: Buffer.from('') });

describe('OpenCode v2 old-tree fence deadline', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        spawnSyncMock.mockReset();
        uptimeMock.mockReset();
    });

    it('keeps the cross-process monotonic clock at the upstream uptime definition', () => {
        uptimeMock.mockReturnValue(1_000.987);
        expect(monotonicTimeMs()).toBe(1_000_000);
    });

    it('fails closed within the two-second fence budget when a probe stalls', async () => {
        // The predecessor rounds each observation down independently. A 900ms
        // state probe can therefore still hand pgrep a fresh 2s timeout.
        let fakeUptime = 1_000.01;
        uptimeMock.mockImplementation(() => fakeUptime);
        let stateProbe = true;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'ps' && args.includes('stat=')) {
                if (stateProbe) {
                    stateProbe = false;
                    sleepSynchronously(900);
                    fakeUptime = 1_000.9;
                }
                return completed('S');
            }
            if (command === 'ps') return completed('generation');
            if (command === 'pgrep') {
                const options = spawnSyncMock.mock.calls.at(-1)?.[2] as { timeout: number };
                sleepSynchronously(options.timeout);
                fakeUptime = 1_002.9;
                return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
            }
            return completed('');
        });
        vi.spyOn(process, 'kill').mockReturnValue(true);

        const start = performance.now();
        await expect(stopTrackedAcpProcesses(
            [{ pid: 5544, startMarker: 'generation' }], 2_000, performance.now.bind(performance)
        )).resolves.toBe(false);
        expect(performance.now() - start).toBeLessThan(2_300);
    }, 8_000);
});
