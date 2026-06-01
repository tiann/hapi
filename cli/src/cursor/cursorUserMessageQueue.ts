import type { EnhancedMode } from './loop';
import { parseCursorSpecialCommand } from './cursorSpecialCommands';
import type { MessageQueue2 } from '@/utils/MessageQueue2';

/**
 * Enqueue a Cursor user message. Special slash commands are isolated so they are
 * never newline-batched with adjacent same-mode prompts.
 */
export function enqueueCursorUserMessage(
    messageQueue: MessageQueue2<EnhancedMode>,
    formattedText: string,
    enhancedMode: EnhancedMode,
    localId?: string
): void {
    const specialCommand = parseCursorSpecialCommand(formattedText);
    if (specialCommand.type !== null) {
        messageQueue.pushIsolated(formattedText.trim(), enhancedMode, localId);
        return;
    }
    messageQueue.push(formattedText, enhancedMode, localId);
}
