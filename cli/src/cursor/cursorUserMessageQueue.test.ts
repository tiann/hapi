import { describe, expect, it } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { parseCursorSpecialCommand } from './cursorSpecialCommands';
import { enqueueCursorUserMessage } from './cursorUserMessageQueue';
import type { EnhancedMode } from './loop';

const mode: EnhancedMode = { permissionMode: 'default' };

describe('enqueueCursorUserMessage', () => {
    it('does not batch invalid /clear with a following prompt', async () => {
        const queue = new MessageQueue2<EnhancedMode>((m) => m.permissionMode);
        enqueueCursorUserMessage(queue, '/clear now', mode, 'a');
        enqueueCursorUserMessage(queue, 'continue work', mode, 'b');

        const first = await queue.waitForMessagesAndGetAsString();
        expect(first?.message).toBe('/clear now');
        expect(parseCursorSpecialCommand(first!.message).type).toBe('invalid');

        const second = await queue.waitForMessagesAndGetAsString();
        expect(second?.message).toBe('continue work');
    });

    it('isolates /summarize from a following same-mode prompt', async () => {
        const queue = new MessageQueue2<EnhancedMode>((m) => m.permissionMode);
        enqueueCursorUserMessage(queue, '/summarize keep recap', mode, 'a');
        enqueueCursorUserMessage(queue, 'next task', mode, 'b');

        const first = await queue.waitForMessagesAndGetAsString();
        expect(first?.message).toBe('/summarize keep recap');
        expect(parseCursorSpecialCommand(first!.message).type).toBe('summarize');

        const second = await queue.waitForMessagesAndGetAsString();
        expect(second?.message).toBe('next task');
    });
});
