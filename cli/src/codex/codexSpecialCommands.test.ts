import { describe, expect, it } from 'vitest';
import { parseCodexSpecialCommand } from './codexSpecialCommands';

describe('parseCodexSpecialCommand', () => {
    it('accepts exact /clear and /compact commands', () => {
        expect(parseCodexSpecialCommand('  /clear  ')).toEqual({ type: 'clear' });
        expect(parseCodexSpecialCommand('/compact')).toEqual({ type: 'compact' });
    });

    it('rejects argument-bearing special commands without treating them as prompts', () => {
        expect(parseCodexSpecialCommand('/clear now')).toEqual({
            type: 'invalid',
            command: 'clear',
            message: '/clear does not accept arguments'
        });
        expect(parseCodexSpecialCommand('/compact summarize this')).toEqual({
            type: 'invalid',
            command: 'compact',
            message: '/compact does not accept arguments'
        });
    });

    it('ignores regular slash-like messages', () => {
        expect(parseCodexSpecialCommand('/clearing')).toEqual({ type: null });
        expect(parseCodexSpecialCommand('please /clear')).toEqual({ type: null });
    });
});
