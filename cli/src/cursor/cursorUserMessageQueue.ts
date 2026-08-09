import type { EnhancedMode } from './loop';
import { parseCursorSpecialCommand } from './cursorSpecialCommands';
import type { MessageQueue2 } from '@/utils/MessageQueue2';

/**
 * Enqueue a Cursor user message. Special slash commands are isolated so they are
 * never newline-batched with adjacent same-mode prompts.
 */
const RESERVED_BRIDGE_LOCAL_ID_PREFIX = 'bridge:';

export function enqueueCursorUserMessage(
    messageQueue: MessageQueue2<EnhancedMode>,
    formattedText: string,
    enhancedMode: EnhancedMode,
    localId?: string
): void {
    // Reserved for queue-owned model-error Bridge provenance. Never accept from
    // caller-controlled ingress — strip so the turn stays a normal user message.
    const safeLocalId = typeof localId === 'string'
        && localId.startsWith(RESERVED_BRIDGE_LOCAL_ID_PREFIX)
        ? undefined
        : localId;
    const specialCommand = parseCursorSpecialCommand(formattedText);
    if (specialCommand.type !== null) {
        messageQueue.pushIsolated(formattedText.trim(), enhancedMode, safeLocalId);
        return;
    }
    messageQueue.push(formattedText, enhancedMode, safeLocalId);
}
