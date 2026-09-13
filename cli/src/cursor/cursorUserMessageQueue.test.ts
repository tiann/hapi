import { describe, expect, it } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { parseCursorSpecialCommand } from './cursorSpecialCommands';
import { enqueueCursorUserMessage } from './cursorUserMessageQueue';
import type { EnhancedMode } from './loop';

const mode: EnhancedMode = { permissionMode: 'default' };

describe('enqueueCursorUserMessage', () => {
    it('preserves caller bridge: localId but keeps the turn non-bridge provenance', async () => {
        const consumed: string[] = [];
        const queue = new MessageQueue2<EnhancedMode>((m) => m.permissionMode);
        queue.onBatchConsumed = (localIds) => {
            consumed.push(...localIds);
        };
        enqueueCursorUserMessage(queue, 'please continue', mode, 'bridge:evt-1');
        expect(queue.queue).toHaveLength(1);
        expect(queue.queue[0]?.localId).toBe('bridge:evt-1');
        expect(queue.queue[0]?.internal).toBeUndefined();
        expect(queue.hasPendingNonBridgeTurn()).toBe(true);

        const batch = await queue.waitForMessagesAndGetAsString();
        expect(batch?.items[0]?.internal).toBeUndefined();
        expect(consumed).toEqual(['bridge:evt-1']);
    });

    it('isolates /compress from a following same-mode prompt', async () => {
        const queue = new MessageQueue2<EnhancedMode>((m) => m.permissionMode);
        enqueueCursorUserMessage(queue, '/compress keep recap', mode, 'a');
        enqueueCursorUserMessage(queue, 'next task', mode, 'b');

        const first = await queue.waitForMessagesAndGetAsString();
        expect(first?.message).toBe('/compress keep recap');
        expect(parseCursorSpecialCommand(first!.message)).toMatchObject({
            type: 'pass-through',
            command: 'compress'
        });

        const second = await queue.waitForMessagesAndGetAsString();
        expect(second?.message).toBe('next task');
    });

    it('preserves a normal prompt queued before a slash command', async () => {
        const queue = new MessageQueue2<EnhancedMode>((m) => m.permissionMode);
        enqueueCursorUserMessage(queue, 'first work', mode, 'a');
        enqueueCursorUserMessage(queue, '/compress', mode, 'b');
        enqueueCursorUserMessage(queue, 'after compress', mode, 'c');

        const first = await queue.waitForMessagesAndGetAsString();
        expect(first?.message).toBe('first work');
        expect(first?.isolate).toBe(false);

        const second = await queue.waitForMessagesAndGetAsString();
        expect(second?.message).toBe('/compress');
        expect(second?.isolate).toBe(true);

        const third = await queue.waitForMessagesAndGetAsString();
        expect(third?.message).toBe('after compress');
    });
});
