import { describe, expect, it } from 'vitest';
import { parseCursorSpecialCommand } from './cursorSpecialCommands';

describe('parseCursorSpecialCommand', () => {
    it('accepts /summarize with optional instructions', () => {
        expect(parseCursorSpecialCommand('/summarize')).toEqual({
            type: 'summarize',
            message: '/summarize'
        });
        expect(parseCursorSpecialCommand('  /summarize keep peer relocate recap  ')).toEqual({
            type: 'summarize',
            message: '/summarize keep peer relocate recap'
        });
    });

    it('accepts exact /clear', () => {
        expect(parseCursorSpecialCommand('  /clear  ')).toEqual({ type: 'clear' });
    });

    it('rejects /clear with arguments', () => {
        expect(parseCursorSpecialCommand('/clear now')).toEqual({
            type: 'invalid',
            command: 'clear',
            message: '/clear does not accept arguments'
        });
    });

    it('ignores regular slash-like messages', () => {
        expect(parseCursorSpecialCommand('/summarizer')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('please /summarize')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/clearing')).toEqual({ type: null });
    });
});
