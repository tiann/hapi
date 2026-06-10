import { describe, expect, it } from 'vitest';
import { resolveThoughtLevelEffort } from './thoughtLevelEffort';

const thoughtLevelOption = {
    id: 'effort',
    category: 'thought_level',
    currentValue: 'low',
    options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' }
    ]
};

describe('resolveThoughtLevelEffort', () => {
    it('returns the requested value when it is supported', () => {
        expect(resolveThoughtLevelEffort('medium', thoughtLevelOption, 'low')).toBe('medium');
    });

    it('falls back to the current backend effort when the request is unsupported', () => {
        expect(resolveThoughtLevelEffort('high', thoughtLevelOption, 'low')).toBe('low');
    });

    it('falls back to the ACP current value when the backend effort is also unsupported', () => {
        expect(resolveThoughtLevelEffort('high', thoughtLevelOption, 'max')).toBe('low');
    });

    it('falls back to the first supported option when nothing else matches', () => {
        const option = {
            ...thoughtLevelOption,
            currentValue: 'high'
        };
        expect(resolveThoughtLevelEffort('max', option, null)).toBe('low');
    });
});
