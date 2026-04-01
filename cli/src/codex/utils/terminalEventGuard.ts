export type TerminalEventGuardInput = {
    eventTurnId: string | null;
    currentTurnId: string | null;
    turnInFlight: boolean;
    allowAnonymousTerminalEvent?: boolean;
};

export function shouldIgnoreTerminalEvent(input: TerminalEventGuardInput): boolean {
    const allowAnonymousTerminalEvent = input.allowAnonymousTerminalEvent === true;

    if (input.eventTurnId) {
        return Boolean(input.currentTurnId && input.eventTurnId !== input.currentTurnId);
    }

    if (input.currentTurnId) {
        return true;
    }

    if (input.turnInFlight && !allowAnonymousTerminalEvent) {
        return true;
    }

    return false;
}
