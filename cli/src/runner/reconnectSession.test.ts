import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reconnectRunnerSession } from './reconnectSession';

const state = vi.hoisted(() => ({ findRuntime: vi.fn(), control: vi.fn() }));
vi.mock('@/codex/shared/registry', () => ({ findRuntime: state.findRuntime }));
vi.mock('@/codex/shared/frontend', () => ({ runtimeControl: state.control }));

beforeEach(() => { vi.resetAllMocks(); });
const options = { directory: '/tmp', agent: 'codex' as const, existingSessionId: 'sid' };
const result = { type: 'success' as const, sessionId: 'sid' };

describe('reconnectRunnerSession', () => {
    it('reuses the verified runtime through a bounded reconnect control', async () => {
        const runtime = { id: 'runtime' };
        state.findRuntime.mockResolvedValue(runtime);
        state.control.mockResolvedValue({ connected: true });
        await expect(reconnectRunnerSession(options, result)).resolves.toEqual(result);
        expect(state.findRuntime).toHaveBeenCalledWith('sid', { strict: true });
        expect(state.control).toHaveBeenCalledExactlyOnceWith(runtime, 'hapi/reconnectSession', 'sid', { timeoutMs: 10_000 });
    });

    it.each([undefined, null, {}, { connected: false }])('does not accept an unconfirmed reconnect (%j)', async reply => {
        state.findRuntime.mockResolvedValue({ id: 'runtime' });
        state.control.mockResolvedValue(reply);
        await expect(reconnectRunnerSession(options, result)).resolves.toMatchObject({ type: 'error' });
    });

    it('preserves an execution whose runtime cannot be verified', async () => {
        state.findRuntime.mockResolvedValue(undefined);
        await expect(reconnectRunnerSession(options, result)).resolves.toMatchObject({ type: 'error' });
        expect(state.control).not.toHaveBeenCalled();
        state.findRuntime.mockRejectedValue(new Error('Cannot verify ownership record'));
        await expect(reconnectRunnerSession(options, result)).resolves.toMatchObject({ type: 'error', errorMessage: expect.stringContaining('Cannot verify') });
        expect(state.control).not.toHaveBeenCalled();
    });

    it('reports an unreachable or older runtime without stopping it', async () => {
        state.findRuntime.mockResolvedValue({ id: 'runtime' });
        state.control.mockRejectedValue(new Error('Unknown runtime control'));
        await expect(reconnectRunnerSession(options, result)).resolves.toMatchObject({ type: 'error', errorMessage: expect.stringContaining('execution was preserved') });
        expect(state.control.mock.calls.map(call => call[1])).toEqual(['hapi/reconnectSession']);
    });
});
