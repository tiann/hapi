// Regression test: a stale dequeue admission is released when the
// next batch collects after an aborted collectBatch.
import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { OpencodeMode } from './types';
import { OpenCodeRuntimeGate } from './rewind';
import { OpencodeSession } from './session';

function makeSession() {
    const gate = new OpenCodeRuntimeGate();
    const session = new OpencodeSession({
        api: {} as never,
        client: { keepAlive: vi.fn(), emitMessagesConsumed: vi.fn() } as never,
        path: '/tmp/hapi-opencode-dequeue-test',
        logPath: '/tmp/hapi-opencode-dequeue-test.log',
        sessionId: 'dequeue-release-test',
        messageQueue: new MessageQueue2<OpencodeMode>((mode) => JSON.stringify(mode)),
        onModeChange: vi.fn(),
        startedBy: 'runner',
        startingMode: 'local',
        runtimeGate: gate
    });
    session.stopKeepAlive();
    return { session, gate };
}

describe('OpencodeSession dequeue admission', () => {
    it('releases a stale admission when the next batch collects after an onBatchConsumed throw', async () => {
        const { session, gate } = makeSession();
        const queue = session.queue;
        queue.onBatchConsumed = vi.fn(() => { throw new Error('ack failed'); });

        queue.push('first', { permissionMode: 'default' } as OpencodeMode, 'first');
        // collectBatch aborts after admitting the runtime: the launcher never
        // reaches takeDequeuedRuntimeRelease, so the admission is orphaned.
        await expect(queue.waitForMessagesAndGetAsString()).rejects.toThrow('ack failed');
        expect(gate.isRuntimeActive()).toBe(true);

        // The next collection must take the orphaned admission before
        // acquiring its own, leaving exactly one live admission.
        queue.onBatchConsumed = null;
        queue.push('second', { permissionMode: 'default' } as OpencodeMode, 'second');
        const batch = await queue.waitForMessagesAndGetAsString();
        expect(batch?.message).toBe('second');
        const release = session.takeDequeuedRuntimeRelease();
        expect(release).toBeTypeOf('function');
        release!();
        expect(gate.isRuntimeActive()).toBe(false);
    });
});