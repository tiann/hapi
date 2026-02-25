import { describe, expect, it } from 'vitest';
import { deriveToolName, deriveToolNameWithSource, isPlaceholderToolName } from './utils';

describe('agent tool name helpers', () => {
    it('treats generic kind fallback as placeholder', () => {
        expect(deriveToolName({ kind: 'other' })).toBe('Tool');
        expect(deriveToolName({ kind: 'unknown' })).toBe('Tool');
    });

    it('keeps source metadata for explicit raw input names', () => {
        const derived = deriveToolNameWithSource({
            kind: 'execute',
            rawInput: { name: 'Bash' }
        });
        expect(derived).toEqual({
            name: 'Bash',
            source: 'raw_input_name'
        });
    });

    it('marks placeholder tool names', () => {
        expect(isPlaceholderToolName('other')).toBe(true);
        expect(isPlaceholderToolName('tool')).toBe(true);
        expect(isPlaceholderToolName('search')).toBe(false);
    });
});
