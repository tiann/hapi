export type TerminalEventGuardInput = {
    eventTurnId: string | null;
    currentTurnId: string | null;
    turnInFlight: boolean;
    allowAnonymousTerminalEvent?: boolean;
    acceptAnonymousFailureWithDetails?: boolean;
};

export function shouldIgnoreTerminalEvent(input: TerminalEventGuardInput): boolean {
    const allowAnonymousTerminalEvent = input.allowAnonymousTerminalEvent === true;
    const acceptAnonymousFailureWithDetails = input.acceptAnonymousFailureWithDetails === true;

    if (input.eventTurnId) {
        return Boolean(input.currentTurnId && input.eventTurnId !== input.currentTurnId);
    }

    if (input.currentTurnId) {
        if (acceptAnonymousFailureWithDetails) {
            return false;
        }
        return true;
    }

    if (input.turnInFlight && !allowAnonymousTerminalEvent) {
        if (acceptAnonymousFailureWithDetails) {
            return false;
        }
        return true;
    }

    return false;
}
