import { describe, it, expect } from 'vitest';
import { parseCompact, parseClear, parseGoal, parseSpecialCommand } from './specialCommands';

describe('parseCompact', () => {
    it('should parse /compact command with argument', () => {
        const result = parseCompact('/compact optimize the code');
        expect(result.isCompact).toBe(true);
        expect(result.originalMessage).toBe('/compact optimize the code');
    });

    it('should parse /compact command without argument', () => {
        const result = parseCompact('/compact');
        expect(result.isCompact).toBe(true);
        expect(result.originalMessage).toBe('/compact');
    });

    it('should not parse regular messages', () => {
        const result = parseCompact('hello world');
        expect(result.isCompact).toBe(false);
        expect(result.originalMessage).toBe('hello world');
    });

    it('should not parse messages that contain compact but do not start with /compact', () => {
        const result = parseCompact('please /compact this');
        expect(result.isCompact).toBe(false);
        expect(result.originalMessage).toBe('please /compact this');
    });
});

describe('parseClear', () => {
    it('should parse /clear command exactly', () => {
        const result = parseClear('/clear');
        expect(result.isClear).toBe(true);
    });

    it('should parse /clear command with whitespace', () => {
        const result = parseClear('  /clear  ');
        expect(result.isClear).toBe(true);
    });

    it('should not parse /clear with arguments', () => {
        const result = parseClear('/clear something');
        expect(result.isClear).toBe(false);
    });

    it('should not parse regular messages', () => {
        const result = parseClear('hello world');
        expect(result.isClear).toBe(false);
    });
});

describe('parseGoal', () => {
    it('should parse /goal command exactly', () => {
        const result = parseGoal('/goal');
        expect(result.isGoal).toBe(true);
        expect(result.action).toBe('get');
        expect(result.text).toBeUndefined();
    });

    it('should parse /goal clear command', () => {
        const result = parseGoal('/goal clear');
        expect(result.isGoal).toBe(true);
        expect(result.action).toBe('clear');
        expect(result.text).toBeUndefined();
    });

    it('should parse /goal clear with flexible whitespace', () => {
        expect(parseGoal('/goal    clear')).toMatchObject({ isGoal: true, action: 'clear' });
        expect(parseGoal('/goal\tclear')).toMatchObject({ isGoal: true, action: 'clear' });
        expect(parseGoal('/goal\nclear')).toMatchObject({ isGoal: true, action: 'clear' });
    });

    it('should treat clear plus extra text as a goal objective', () => {
        const result = parseGoal('/goal clear now');
        expect(result.isGoal).toBe(true);
        expect(result.action).toBe('set');
        expect(result.text).toBe('clear now');
    });

    it('should treat flag-like arguments as a goal objective', () => {
        const result = parseGoal('/goal --clear');
        expect(result.isGoal).toBe(true);
        expect(result.action).toBe('set');
        expect(result.text).toBe('--clear');
    });

    it('should parse /goal with text argument', () => {
        const result = parseGoal('/goal fix the bug');
        expect(result.isGoal).toBe(true);
        expect(result.action).toBe('set');
        expect(result.text).toBe('fix the bug');
    });

    it('should fallback to get if text argument is empty', () => {
        const result = parseGoal('/goal   ');
        expect(result.isGoal).toBe(true);
        expect(result.action).toBe('get');
    });

    it('should not parse regular messages', () => {
        const result = parseGoal('this is my goal');
        expect(result.isGoal).toBe(false);
    });
});

describe('parseSpecialCommand', () => {
    it('should detect compact command', () => {
        const result = parseSpecialCommand('/compact optimize');
        expect(result.type).toBe('compact');
        expect(result.originalMessage).toBe('/compact optimize');
    });

    it('should detect clear command', () => {
        const result = parseSpecialCommand('/clear');
        expect(result.type).toBe('clear');
        expect(result.originalMessage).toBeUndefined();
    });

    it('should detect goal command', () => {
        const result = parseSpecialCommand('/goal');
        expect(result.type).toBe('goal');
        expect(result.goalAction).toBe('get');
    });

    it('should detect goal set command', () => {
        const result = parseSpecialCommand('/goal new goal');
        expect(result.type).toBe('goal');
        expect(result.goalAction).toBe('set');
        expect(result.goalText).toBe('new goal');
    });

    it('should return null for regular messages', () => {
        const result = parseSpecialCommand('hello world');
        expect(result.type).toBeNull();
        expect(result.originalMessage).toBeUndefined();
    });

    it('should handle edge cases correctly', () => {
        // Test with extra whitespace
        expect(parseSpecialCommand('  /compact test  ').type).toBe('compact');
        expect(parseSpecialCommand('  /clear  ').type).toBe('clear');
        expect(parseSpecialCommand('  /goal  ').type).toBe('goal');
        
        // Test partial matches should not trigger
        expect(parseSpecialCommand('some /compact text').type).toBeNull();
        expect(parseSpecialCommand('/compactor').type).toBeNull();
        expect(parseSpecialCommand('/clearing').type).toBeNull();
        expect(parseSpecialCommand('/goalkeeper').type).toBeNull();
    });
});
