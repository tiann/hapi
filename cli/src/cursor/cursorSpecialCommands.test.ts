import { describe, expect, it } from 'vitest';
import {
    cursorPassThroughStatusMessage,
    parseCursorSpecialCommand
} from './cursorSpecialCommands';

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

    it('accepts summarize/compact aliases', () => {
        expect(parseCursorSpecialCommand('/summarize')).toMatchObject({
            type: 'pass-through',
            command: 'summarize'
        });
        expect(parseCursorSpecialCommand('/compact keep bullets')).toMatchObject({
            type: 'pass-through',
            command: 'compact',
            message: '/compact keep bullets'
        });
    });

    it('accepts multitask / worktree / add-dir / auto-review', () => {
        expect(parseCursorSpecialCommand('/multitask fix lint and tests')).toEqual({
            type: 'pass-through',
            command: 'multitask',
            message: '/multitask fix lint and tests'
        });
        expect(parseCursorSpecialCommand('/worktree feature-x')).toMatchObject({
            type: 'pass-through',
            command: 'worktree'
        });
        expect(parseCursorSpecialCommand('/add-dir ../shared')).toMatchObject({
            type: 'pass-through',
            command: 'add-dir'
        });
        expect(parseCursorSpecialCommand('/auto-review')).toMatchObject({
            type: 'pass-through',
            command: 'auto-review'
        });
        expect(parseCursorSpecialCommand('/best-of-n compare approaches')).toMatchObject({
            type: 'pass-through',
            command: 'best-of-n'
        });
    });

    it('rejects interactive TUI-only commands', () => {
        expect(parseCursorSpecialCommand('/config')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/mcp')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/sandbox')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/btw why')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/rewind')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/debug')).toEqual({ type: null });
    });

    it('rejects prefix collisions', () => {
        expect(parseCursorSpecialCommand('/compressor')).toEqual({ type: null });
        expect(parseCursorSpecialCommand('/multitasking')).toEqual({ type: null });
    });
});

describe('cursorPassThroughStatusMessage', () => {
    it('returns a status line for compress', () => {
        expect(cursorPassThroughStatusMessage('compress')).toContain('compression');
    });

    it('returns a status line for multitask', () => {
        expect(cursorPassThroughStatusMessage('multitask')).toMatch(/multitask/i);
    });
});
