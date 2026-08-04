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
    const allowMatchingThreadIdTerminalEvent = input.allowMatchingThreadIdTerminalEvent === true;
    const hasMatchingThreadId = Boolean(
        input.eventThreadId
        && input.currentThreadId
        && input.eventThreadId === input.currentThreadId
    );

    if (input.eventTurnId) {
        if (!input.currentTurnId || input.eventTurnId === input.currentTurnId) {
            return false;
        }
        return !(allowMatchingThreadIdTerminalEvent && hasMatchingThreadId);
    }

    if (input.currentTurnId) {
        if (allowMatchingThreadIdTerminalEvent && hasMatchingThreadId) {
            return false;
        }
        return true;
    }

    if (input.turnInFlight && !allowAnonymousTerminalEvent) {
        return true;
    }

    return false;
}
