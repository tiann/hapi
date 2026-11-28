import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startFileWatcher } from '@/modules/watcher/startFileWatcher';
import { kimiLocalLauncher } from './kimiLocalLauncher';
import { createKimiWireLocator } from './utils/kimiWireLocator';
import { createKimiWireScanner } from './utils/kimiWireScanner';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class { run = run; }
}));
vi.mock('./utils/kimiWireLocator', () => ({ createKimiWireLocator: vi.fn() }));
vi.mock('./utils/kimiSessionTitleWatcher', () => ({
    createKimiSessionTitleWatcher: async () => ({ cleanup: async () => {} })
}));
vi.mock('./utils/kimiWireScanner', { spy: true });
vi.mock('@/modules/watcher/startFileWatcher', () => ({ startFileWatcher: vi.fn() }));

it.each(['pending trailing scan', 'idle watcher'])('forwards the silent append on exit with a %s', async (mode) => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const path = mkdtempSync(join(tmpdir(), 'kimi-local-drain-'));
    const located = { sessionId: 'native', wirePath: join(path, 'wire.jsonl'), statePath: join(path, 'state.json') };
    let locatedOnce = false;
    const locate = () => {
        if (locatedOnce) return;
        locatedOnce = true;
        vi.mocked(createKimiWireLocator).mock.calls[0]![0].onLocated(located);
    };
    const session = { path, client: {}, getModel: () => undefined, onSessionFound: vi.fn(), sendAgentMessage: vi.fn() };
    const append = (text: string) => appendFileSync(located.wirePath, JSON.stringify({
        type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } }
    }) + '\n');
    try {
        writeFileSync(located.wirePath, '');
        vi.mocked(startFileWatcher).mockImplementation((_file, _changed, health) => {
            health!(true);
            return Object.assign(() => {}, { verifyIdentity: vi.fn() });
        });
        vi.mocked(createKimiWireLocator).mockImplementation(({ onLocated }) => ({
            ready: Promise.resolve(),
            cleanup: async () => { locate(); }
        }));
        run.mockImplementation(async () => {
            locate();
            await vi.mocked(createKimiWireScanner).mock.results[0]!.value;
            if (mode === 'idle watcher') {
                await vi.advanceTimersByTimeAsync(10_000);
                append('tail');
                await vi.advanceTimersByTimeAsync(2_001);
                expect(session.sendAgentMessage).not.toHaveBeenCalled();
                return 'exit';
            }
            const firstDelivered = new Promise<void>(resolve => session.sendAgentMessage.mockImplementationOnce(resolve));
            append('first');
            vi.mocked(startFileWatcher).mock.calls[0]![1](located.wirePath);
            await firstDelivered;
            append('tail');
            return 'exit';
        });
        await expect(kimiLocalLauncher(session as never, {})).resolves.toBe('exit');
        const messages = mode === 'idle watcher' ? ['tail'] : ['first', 'tail'];
        expect(session.sendAgentMessage.mock.calls).toEqual(messages.map(message => [{ type: 'message', message }]));
        expect(session.onSessionFound).toHaveBeenCalledTimes(1);
        expect(createKimiWireScanner).toHaveBeenCalledTimes(1);
    } finally {
        vi.useRealTimers();
        rmSync(path, { recursive: true, force: true });
    }
});
