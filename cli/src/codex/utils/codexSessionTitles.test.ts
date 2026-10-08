import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { CodexSessionTitles } from './codexSessionTitles';

const harness = vi.hoisted(() => ({
    handler: null as ((method: string, params: unknown) => void) | null,
    listModels: vi.fn(), initialize: vi.fn(), readThread: vi.fn(), readConfig: vi.fn(), startThread: vi.fn(),
    startTurn: vi.fn(), setThreadName: vi.fn(), unsubscribeThread: vi.fn(), disconnect: vi.fn()
}));

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        isInitialized = () => true;
        listModels = harness.listModels;
        initialize = harness.initialize;
        readThread = harness.readThread;
        readConfig = harness.readConfig;
        startThread = harness.startThread;
        startTurn = harness.startTurn;
        setThreadName = harness.setThreadName;
        unsubscribeThread = harness.unsubscribeThread;
        disconnect = harness.disconnect;
        setNotificationHandler(handler: typeof harness.handler) { harness.handler = handler; }
    }
}));

describe('CodexSessionTitles', () => {
    let metadata: Metadata;
    let threadId: string | null;
    let titles: CodexSessionTitles;

    function complete(text = '{"title":"Repair session titles"}', status = 'completed') {
        harness.handler?.('item/completed', { threadId: 'temporary', item: { type: 'agentMessage', text } });
        harness.handler?.('turn/completed', { threadId: 'temporary', turn: { status } });
    }

    beforeEach(() => {
        vi.resetAllMocks();
        metadata = { path: '/project' } as Metadata;
        threadId = 'parent';
        titles = new CodexSessionTitles({
            getMetadata: () => metadata,
            updateMetadata: update => { metadata = update(metadata); }
        }, '/project', () => threadId);
        harness.listModels.mockResolvedValue({ data: [] });
        harness.readThread.mockResolvedValue({ thread: { id: 'parent', name: null, modelProvider: 'openai' } });
        harness.readConfig.mockResolvedValue({ config: { mcp_servers: { hapi: {}, personal: {} } } });
        harness.startThread.mockResolvedValue({ thread: { id: 'temporary' }, sandbox: { type: 'readOnly' } });
        harness.unsubscribeThread.mockResolvedValue({});
        harness.disconnect.mockResolvedValue(undefined);
        harness.startTurn.mockImplementation(async () => { complete(); return { turn: { id: 'title-turn' } }; });
    });

    afterEach(async () => { await titles.stop(); vi.useRealTimers(); });

    it('hydrates native names, isolates child events and preserves manual display names', async () => {
        metadata.name = 'Manual name';
        harness.readThread.mockResolvedValue({ thread: { id: 'parent', name: 'Native name' } });
        await titles.refresh();
        titles.sync('child', 'Child name');
        expect(metadata.name).toBe('Manual name');
        expect(metadata.summary?.text).toBe('Native name');
        expect(harness.startThread).not.toHaveBeenCalled();
    });

    it('does not overwrite a newer native notification with a stale read response', async () => {
        harness.readThread.mockImplementation(async () => {
            titles.sync('parent', 'New native name');
            return { thread: { id: 'parent', name: 'Old native name' } };
        });
        await titles.refresh();
        expect(metadata.summary?.text).toBe('New native name');
    });

    it('generates once in a tool-disabled ephemeral thread, then persists and syncs the native name', async () => {
        await titles.generate('parent', 'Fix the title bug', 'current-model');
        await titles.generate('parent', 'Next turn', 'current-model');
        expect(harness.startThread).toHaveBeenCalledTimes(1);
        expect(harness.startThread.mock.calls[0][0]).toMatchObject({
            ephemeral: true, model: 'current-model', modelProvider: 'openai',
            sandbox: 'read-only', approvalPolicy: 'never', threadSource: 'feature:system',
            config: {
                'features.hooks': false, 'features.plugins': false, 'features.apps': false,
                'features.shell_tool': false, 'features.multi_agent_v2': false,
                mcp_servers: { hapi: { enabled: false }, personal: { enabled: false } }
            }
        });
        expect(harness.startTurn.mock.calls[0][0].threadId).toBe('temporary');
        expect(harness.setThreadName).toHaveBeenCalledWith('parent', 'Repair session titles', expect.any(AbortSignal));
        expect(metadata.summary?.text).toBe('Repair session titles');
        expect(harness.unsubscribeThread).toHaveBeenCalledWith('temporary');
        expect(harness.handler).toBeNull();
        expect(harness.disconnect).toHaveBeenCalledOnce();
    });

    it('does not generate over an existing native name', async () => {
        harness.readThread.mockResolvedValue({ thread: { id: 'parent', name: 'Already named' } });
        await titles.generate('parent', 'request');
        expect(metadata.summary?.text).toBe('Already named');
        expect(harness.startThread).not.toHaveBeenCalled();
    });

    it.each(['manual', 'native', 'switch'] as const)('ignores a late generated title after %s changes', async change => {
        harness.startTurn.mockImplementation(async () => {
            if (change === 'manual') metadata.name = 'User name';
            if (change === 'native') titles.sync('parent', 'Externally renamed');
            if (change === 'switch') threadId = 'another';
            complete();
            return { turn: { id: 'title-turn' } };
        });
        await titles.generate('parent', 'request');
        expect(harness.setThreadName).not.toHaveBeenCalled();
        expect(harness.unsubscribeThread).toHaveBeenCalledOnce();
    });

    it('rechecks persisted names before applying a generated title', async () => {
        harness.readThread.mockResolvedValueOnce({ thread: { id: 'parent' } })
            .mockResolvedValueOnce({ thread: { id: 'parent', name: 'Renamed elsewhere' } });
        await titles.generate('parent', 'request');
        expect(harness.setThreadName).not.toHaveBeenCalled();
        expect(metadata.summary?.text).toBe('Renamed elsewhere');
    });

    it.each(['not json', '{"title":""}', '{"title":42}'])('rejects invalid output %s without retrying each turn', async output => {
        harness.startTurn.mockImplementation(async () => { complete(output); });
        await titles.generate('parent', 'request');
        await titles.generate('parent', 'next');
        expect(harness.setThreadName).not.toHaveBeenCalled();
        expect(harness.startTurn).toHaveBeenCalledOnce();
        expect(harness.unsubscribeThread).toHaveBeenCalledOnce();
    });

    it('fails closed if effective MCP config cannot be read or permissions are wider than requested', async () => {
        harness.readConfig.mockRejectedValueOnce(new Error('config unavailable'));
        await titles.generate('parent', 'request');
        expect(harness.startThread).not.toHaveBeenCalled();
        threadId = 'other';
        harness.startThread.mockResolvedValue({ thread: { id: 'temporary' }, sandbox: { type: 'dangerFullAccess' } });
        await titles.generate('other', 'request');
        expect(harness.startTurn).not.toHaveBeenCalled();
        expect(harness.unsubscribeThread).toHaveBeenCalledOnce();
    });

    it('times out a stalled title turn without retrying or changing the name', async () => {
        vi.useFakeTimers();
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), ms);
            return controller.signal;
        });
        harness.startTurn.mockResolvedValue({ turn: { id: 'title-turn' } });
        const pending = titles.generate('parent', 'request');
        await vi.waitFor(() => expect(harness.startTurn).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(30_000);
        await pending;
        expect(harness.setThreadName).not.toHaveBeenCalled();
        expect(harness.unsubscribeThread).toHaveBeenCalledOnce();
        timeout.mockRestore();
    });

    it('cancels a stalled turn at shutdown and releases the temporary thread', async () => {
        vi.useFakeTimers();
        harness.startTurn.mockResolvedValue({ turn: { id: 'title-turn' } });
        const pending = titles.generate('parent', 'request');
        await vi.waitFor(() => expect(harness.startTurn).toHaveBeenCalledOnce());
        await titles.stop();
        await pending;
        expect(harness.setThreadName).not.toHaveBeenCalled();
        expect(harness.unsubscribeThread).toHaveBeenCalledOnce();
    });
});
