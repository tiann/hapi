import type { EnhancedMode } from './loop';
import { isAdvertisedCursorSlashCommand, parseCursorSpecialCommand } from './cursorSpecialCommands';
import type { MessageQueue2 } from '@/utils/MessageQueue2';

/**
 * Enqueue a Cursor user message. Special slash commands are isolated so they are
 * never newline-batched with adjacent same-mode prompts.
 */
export function enqueueCursorUserMessage(
    messageQueue: MessageQueue2<EnhancedMode>,
    formattedText: string,
    enhancedMode: EnhancedMode,
    localId?: string,
    availableSlashCommands?: ReadonlySet<string>
): void {
    // Preserve caller localId for messages-consumed / cancel. Bridge provenance
    // is queue-owned (`internal.kind === 'model-error-bridge'`), so a forged
    // `bridge:*` localId cannot impersonate a Bridge turn.
    const specialCommand = parseCursorSpecialCommand(formattedText);
    if (specialCommand.type !== null || isAdvertisedCursorSlashCommand(formattedText, availableSlashCommands)) {
        messageQueue.pushIsolated(formattedText.trim(), enhancedMode, localId);
        return;
    }
    messageQueue.push(formattedText, enhancedMode, localId);
}
