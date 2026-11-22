import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    windows: vi.fn(() => true), alive: vi.fn((_pid: number) => true), marker: vi.fn((_pid: number) => 'generation'), snapshot: vi.fn(),
}));
vi.mock('@/utils/process', () => ({ isWindows: mocks.windows, isProcessAlive: mocks.alive, getProcessStartMarker: mocks.marker }));
vi.mock('@/utils/windowsProcessStop', () => ({ readWindowsProcessTable: mocks.snapshot }));
import { observeHeartbeatProcesses } from './heartbeatProcesses';

describe('heartbeat process observations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.windows.mockReturnValue(true);
        mocks.alive.mockReturnValue(true);
        mocks.marker.mockReturnValue('generation');
        mocks.snapshot.mockResolvedValue(new Map([[42, { marker: 'generation' }]]));
    });
    afterEach(() => vi.restoreAllMocks());

    it('accepts a startup webhook while a 16-session Windows heartbeat is still querying processes', async () => {
        let completeSnapshot!: (value: Map<number, { marker: string | null }>) => void;
        mocks.snapshot.mockImplementation(() => new Promise(resolve => { completeSnapshot = resolve; }));
        let scanComplete = false;
        const server = createServer((_request, response) => { response.end('started'); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        const scan = observeHeartbeatProcesses(Array.from({ length: 16 }, (_, i) => 42 + i))
            .finally(() => { scanComplete = true; });
        try {
            const response = await fetch(`http://127.0.0.1:${address.port}/session-started`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2_000) });
            expect(await response.text()).toBe('started');
            expect(scanComplete).toBe(false);
        } finally {
            completeSnapshot?.(new Map([[42, { marker: 'generation' }]]));
            await scan;
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('uses one Windows snapshot for any number of PIDs and distinguishes absence from unknown generation', async () => {
        mocks.snapshot.mockResolvedValue(new Map([[42, { marker: 'generation' }], [43, { marker: null }]]));
        const states = await observeHeartbeatProcesses([42, 43, 44, 42]);
        expect(states.get(42)).toEqual({ alive: true, startMarker: 'generation' });
        expect(states.get(43)).toEqual({ alive: true, startMarker: null });
        expect(states.get(44)).toEqual({ alive: false, startMarker: null });
        expect(mocks.snapshot).toHaveBeenCalledTimes(1);
        expect(mocks.snapshot).toHaveBeenCalledWith(10_000, [42, 43, 44]);
        expect(mocks.alive).not.toHaveBeenCalled();
        expect(mocks.marker).not.toHaveBeenCalled();
    });

    it('rejects a failed Windows scan without falling back to blocking per-PID probes', async () => {
        mocks.snapshot.mockResolvedValue(null);
        await expect(observeHeartbeatProcesses([42])).rejects.toThrow('Windows heartbeat process snapshot failed');
        expect(mocks.alive).not.toHaveBeenCalled();
        expect(mocks.marker).not.toHaveBeenCalled();
    });

    it('does not launch a process query for an empty heartbeat', async () => {
        expect((await observeHeartbeatProcesses([])).size).toBe(0);
        expect(mocks.snapshot).not.toHaveBeenCalled();
    });

    it('retains POSIX liveness and generation observations', async () => {
        mocks.windows.mockReturnValue(false);
        mocks.alive.mockImplementation(pid => pid === 42);
        const states = await observeHeartbeatProcesses([42, 43]);
        expect(states.get(42)).toEqual({ alive: true, startMarker: 'generation' });
        expect(states.get(43)).toEqual({ alive: false, startMarker: null });
        expect(mocks.snapshot).not.toHaveBeenCalled();
        expect(mocks.marker).toHaveBeenCalledTimes(1);
    });
});
