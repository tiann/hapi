export type CodexSpecialCommand =
    | { type: 'clear' | 'compact' }
    | { type: 'invalid'; command: 'clear' | 'compact'; message: string }
    | { type: null };

export function parseCodexSpecialCommand(message: string): CodexSpecialCommand {
    const trimmed = message.trim();
    if (trimmed === '/clear') {
        return { type: 'clear' };
    }
    if (trimmed === '/compact') {
        return { type: 'compact' };
    }
    if (trimmed.startsWith('/clear ')) {
        return {
            type: 'invalid',
            command: 'clear',
            message: '/clear does not accept arguments'
        };
    }
    if (trimmed.startsWith('/compact ')) {
        return {
            type: 'invalid',
            command: 'compact',
            message: '/compact does not accept arguments'
        };
    }
    return { type: null };
}
