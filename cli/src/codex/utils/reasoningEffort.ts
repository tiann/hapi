import type { ReasoningEffort } from '../appServerTypes';

export function parseReasoningEffortValue(value: unknown): ReasoningEffort | undefined {
    if (value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error('Invalid model reasoning effort');
    }

    const effort = value.trim().toLowerCase();
    if (!effort) {
        throw new Error('Invalid model reasoning effort');
    }
    return effort;
}
