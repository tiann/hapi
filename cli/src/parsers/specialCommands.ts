/**
 * Parsers for special commands that require dedicated remote session handling
 */

export interface CompactCommandResult {
    isCompact: boolean;
    originalMessage: string;
}

export interface ClearCommandResult {
    isClear: boolean;
}

export type SpecialCommandType = 'compact' | 'clear' | 'native' | null;

export interface SpecialCommandResult {
    type: SpecialCommandType;
    originalMessage?: string;
    commandName?: string;
}

const NATIVE_COMMANDS = [
    'model',
    'status',
    'bug',
    'config',
    'cost',
    'doctor',
    'help',
    'init',
    'login',
    'logout',
    'mcp',
    'memory',
    'pr-comments',
    'review',
    'vim',
    'think',
] as const;

export type NativeCommand = typeof NATIVE_COMMANDS[number];

/**
 * Parse /compact command
 * Matches messages starting with "/compact " or exactly "/compact"
 */
export function parseCompact(message: string): CompactCommandResult {
    const trimmed = message.trim();
    
    if (trimmed === '/compact') {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    if (trimmed.startsWith('/compact ')) {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    return {
        isCompact: false,
        originalMessage: message
    };
}

/**
 * Parse /clear command
 * Only matches exactly "/clear"
 */
export function parseClear(message: string): ClearCommandResult {
    const trimmed = message.trim();
    
    return {
        isClear: trimmed === '/clear'
    };
}

/**
 * Parse native commands that should be passed directly to the agent
 */
export function parseNativeCommand(message: string): { isNative: boolean; commandName?: string } {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) {
        return { isNative: false };
    }

    const parts = trimmed.slice(1).split(/\s+/);
    const commandName = parts[0]?.toLowerCase();

    if (commandName && NATIVE_COMMANDS.includes(commandName as NativeCommand)) {
        return { isNative: true, commandName };
    }

    return { isNative: false };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string, messageType?: 'text' | 'command'): SpecialCommandResult {
    const compactResult = parseCompact(message);
    if (compactResult.isCompact) {
        return {
            type: 'compact',
            originalMessage: compactResult.originalMessage
        };
    }
    
    const clearResult = parseClear(message);
    if (clearResult.isClear) {
        return {
            type: 'clear'
        };
    }

    if (messageType === 'command') {
        const nativeResult = parseNativeCommand(message);
        if (nativeResult.isNative) {
            return {
                type: 'native',
                originalMessage: message,
                commandName: nativeResult.commandName
            };
        }
    }
    
    return {
        type: null
    };
}