import { describe, expect, it } from 'vitest';
import { parseReasoningEffortValue } from './reasoningEffort';

describe('parseReasoningEffortValue', () => {
    it('normalizes non-empty model-reported values', () => {
        expect(parseReasoningEffortValue(' EXTREME ')).toBe('extreme');
    });

    it('maps null to the default effort', () => {
        expect(parseReasoningEffortValue(null)).toBeUndefined();
    });

    it('rejects empty and non-string values', () => {
        expect(() => parseReasoningEffortValue('   ')).toThrow('Invalid model reasoning effort');
        expect(() => parseReasoningEffortValue(42)).toThrow('Invalid model reasoning effort');
    });
});
