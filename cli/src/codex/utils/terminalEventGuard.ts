export type TerminalEventGuardInput = {
    eventTurnId: string | null;
    currentTurnId: string | null;
    turnInFlight: boolean;
    allowAnonymousTerminalEvent?: boolean;
    eventThreadId?: string | null;
    currentThreadId?: string | null;
    allowMatchingThreadIdTerminalEvent?: boolean;
};

export function shouldIgnoreTerminalEvent(input: TerminalEventGuardInput): boolean {
    const allowAnonymousTerminalEvent = input.allowAnonymousTerminalEvent === true;

    if (input.eventTurnId) {
        return Boolean(input.currentTurnId && input.eventTurnId !== input.currentTurnId);
    }

    if (input.currentTurnId) {
        const allowMatchingThreadIdTerminalEvent = input.allowMatchingThreadIdTerminalEvent === true;
        if (
            allowMatchingThreadIdTerminalEvent &&
            input.eventThreadId &&
            input.currentThreadId &&
            input.eventThreadId === input.currentThreadId
        ) {
            return false;
        }
        return true;
    }

    if (input.turnInFlight && !allowAnonymousTerminalEvent) {
        return true;
    }

    return false;
}
