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

export interface GoalCommandResult {
    isGoal: boolean;
    action?: 'get' | 'clear' | 'set';
    text?: string;
}

export interface SpecialCommandResult {
    type: 'compact' | 'clear' | 'goal' | null;
    originalMessage?: string;
    goalAction?: 'get' | 'clear' | 'set';
    goalText?: string;
}

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
 * Parse /goal command
 * Matches /goal (get), /goal clear (clear), and /goal <text> (set)
 */
export function parseGoal(message: string): GoalCommandResult {
    const trimmed = message.trim();
    const match = trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/);
    if (!match) {
        return { isGoal: false };
    }

    const rawArgument = match[1]?.trim();
    if (!rawArgument) {
        return { isGoal: true, action: 'get' };
    }

    const [firstToken, ...restTokens] = rawArgument.split(/\s+/);
    if (firstToken === 'clear' && restTokens.length === 0) {
        return { isGoal: true, action: 'clear' };
    }

    return { isGoal: true, action: 'set', text: rawArgument };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
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
    
    const goalResult = parseGoal(message);
    if (goalResult.isGoal) {
        return {
            type: 'goal',
            goalAction: goalResult.action,
            goalText: goalResult.text,
            originalMessage: message
        };
    }

    return {
        type: null
    };
}