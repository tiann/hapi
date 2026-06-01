export type CursorSpecialCommand =
    | { type: 'summarize'; message: string }
    | { type: 'clear' }
    | { type: 'invalid'; command: 'clear'; message: string }
    | { type: null };

/**
 * Parse Cursor-specific slash commands for remote sessions.
 * Summarize accepts optional trailing instructions after the command.
 * Messages are still passed verbatim to `agent -p` — this parser is for detection and UI contract only.
 */
export function parseCursorSpecialCommand(message: string): CursorSpecialCommand {
    const trimmed = message.trim();

    if (trimmed === '/summarize' || trimmed.startsWith('/summarize ')) {
        return { type: 'summarize', message: trimmed };
    }

    if (trimmed === '/clear') {
        return { type: 'clear' };
    }

    if (trimmed.startsWith('/clear ')) {
        return {
            type: 'invalid',
            command: 'clear',
            message: '/clear does not accept arguments'
        };
    }

    return { type: null };
}
