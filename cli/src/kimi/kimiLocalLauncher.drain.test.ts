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

it('forwards the final silent wire append when Kimi exits before the trailing scan', async () => {
    vi.useFakeTimers();
    const path = mkdtempSync(join(tmpdir(), 'kimi-local-drain-'));
    const located = { sessionId: 'native', wirePath: join(path, 'wire.jsonl'), statePath: join(path, 'state.json') };
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
            cleanup: async () => { onLocated(located); }
        }));
        run.mockImplementation(async () => {
            vi.mocked(createKimiWireLocator).mock.calls[0]![0].onLocated(located);
            await vi.mocked(createKimiWireScanner).mock.results[0]!.value;
            const firstDelivered = new Promise<void>(resolve => session.sendAgentMessage.mockImplementationOnce(resolve));
            append('first');
            vi.mocked(startFileWatcher).mock.calls[0]![1](located.wirePath);
            await firstDelivered;
            append('tail');
            return 'exit';
        });
        await expect(kimiLocalLauncher(session as never, {})).resolves.toBe('exit');
        expect(session.sendAgentMessage.mock.calls).toEqual([
            [{ type: 'message', message: 'first' }],
            [{ type: 'message', message: 'tail' }]
        ]);
        expect(session.onSessionFound).toHaveBeenCalledTimes(1);
        expect(createKimiWireScanner).toHaveBeenCalledTimes(1);
    } finally {
        vi.useRealTimers();
        rmSync(path, { recursive: true, force: true });
    }
});
