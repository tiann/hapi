import { describe, expect, it } from 'vitest';
import { cursorPassThroughStatusMessage, parseCursorSpecialCommand } from './cursorSpecialCommands';

describe('parseCursorSpecialCommand', () => {
    it('accepts /compress with optional instructions', () => {
        expect(parseCursorSpecialCommand('/compress')).toEqual({
            type: 'pass-through',
            command: 'compress',
            message: '/compress'
        });
        expect(parseCursorSpecialCommand('  /compress keep recap  ')).toEqual({
            type: 'pass-through',
            command: 'compress',
            message: '/compress keep recap'
        });
    });

    it('ignores removed or unknown slash commands', () => {
        expect(parseCursorSpecialCommand('/context')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/context now')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/summarize')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/clear')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/debug')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/compressor')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/contextual')).toEqual({ type: null });
    });
});

describe('cursorPassThroughStatusMessage', () => {
    it('returns a status line for compress', () => {
        expect(cursorPassThroughStatusMessage('compress')).toContain('compression');
    });
});
