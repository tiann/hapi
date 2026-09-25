export const MODEL_ERROR_BRIDGE_HEADER = '[HAPI bridge — transient model error]';

export const MAX_LAST_USER_MESSAGE_CHARS = 32_000;
const MAX_EXCERPT_CHARS = 120;

export type ModelErrorBridgeInput = {
    kind: string;
    rawSnippet: string;
    lastUserMessage: string;
    priorAssistantClaimsDone: boolean;
};

export type ModelErrorBridgeGate = {
    transient: boolean;
    eventId: string;
    bridgedForEventId?: string;
    retriedAndFailed?: boolean;
    supersededByUserTurn?: boolean;
    /** Explicit false blocks Bridge (e.g. idle stderr after a successful turn). */
    bridgeable?: boolean;
};

export function truncateLastUserMessage(message: string): string {
    if (message.length <= MAX_LAST_USER_MESSAGE_CHARS) {
        return message;
    }
    return message.slice(0, MAX_LAST_USER_MESSAGE_CHARS);
}

export function buildModelErrorBridgePrompt(input: ModelErrorBridgeInput): string {
    const excerpt = input.rawSnippet
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_EXCERPT_CHARS);

    const lines = [
        MODEL_ERROR_BRIDGE_HEADER,
        '',
        `The previous turn failed before completing (${input.kind}: ${excerpt}).`,
        '',
        'Re-sending your last message below. Continue the task from where you left off.',
        'Do not repeat work you already finished unless the error invalidated it.'
    ];

    if (input.priorAssistantClaimsDone) {
        lines.push('');
        lines.push('You may have reported completion before this error — verify what is actually done before proceeding.');
    }

    lines.push('');
    lines.push('---');
    lines.push(input.lastUserMessage);

    return lines.join('\n');
}

export function canBridgeModelError(gate: ModelErrorBridgeGate): boolean {
    if (!gate.transient) {
        return false;
    }
    if (gate.bridgeable === false) {
        return false;
    }
    if (gate.retriedAndFailed) {
        return false;
    }
    if (gate.supersededByUserTurn) {
        return false;
    }
    if (gate.bridgedForEventId === gate.eventId) {
        return false;
    }
    return true;
}

/** Merge hub RPC snapshot gates into local state without clobbering. */
export function mergeBridgeGateFields(
    prior: Pick<ModelErrorBridgeGate, 'bridgedForEventId' | 'retriedAndFailed' | 'supersededByUserTurn' | 'bridgeable'> | null | undefined,
    incoming: Pick<ModelErrorBridgeGate, 'bridgedForEventId' | 'retriedAndFailed' | 'supersededByUserTurn' | 'bridgeable'>
): Pick<ModelErrorBridgeGate, 'bridgedForEventId' | 'retriedAndFailed' | 'supersededByUserTurn' | 'bridgeable'> {
    return {
        bridgedForEventId: incoming.bridgedForEventId ?? prior?.bridgedForEventId,
        retriedAndFailed: incoming.retriedAndFailed === true || prior?.retriedAndFailed === true,
        supersededByUserTurn: incoming.supersededByUserTurn === true
            || prior?.supersededByUserTurn === true,
        // false wins — never re-open Bridge from a stale hub omit.
        bridgeable: incoming.bridgeable === false || prior?.bridgeable === false
            ? false
            : (incoming.bridgeable ?? prior?.bridgeable)
    };
}
