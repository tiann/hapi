import { describe, it, expect } from 'vitest';
import { parseCompact, parseClear, parsePlan, parseSpecialCommand } from './specialCommands';

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

describe('parsePlan', () => {
    it('should parse /plan without a prompt', () => {
        const result = parsePlan('/plan');
        expect(result).toEqual({
            isPlan: true,
            mode: 'plan',
            prompt: undefined
        });
    });

    it('should parse /plan with a prompt', () => {
        const result = parsePlan('/plan 帮我规划五一行程');
        expect(result).toEqual({
            isPlan: true,
            mode: 'plan',
            prompt: '帮我规划五一行程'
        });
    });

    it('should strip matching quotes around the prompt', () => {
        const result = parsePlan('/plan "帮我规划五一行程"');
        expect(result).toEqual({
            isPlan: true,
            mode: 'plan',
            prompt: '帮我规划五一行程'
        });
    });

    it('should parse /plan off as default mode', () => {
        const result = parsePlan('/plan off');
        expect(result).toEqual({
            isPlan: true,
            mode: 'default',
            prompt: undefined
        });
    });

    it('should not parse partial matches', () => {
        expect(parsePlan('/planner test').isPlan).toBe(false);
        expect(parsePlan('please /plan this').isPlan).toBe(false);
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

    it('should detect plan command with prompt', () => {
        const result = parseSpecialCommand('/plan "帮我规划五一行程"');
        expect(result.type).toBe('plan');
        expect(result.mode).toBe('plan');
        expect(result.prompt).toBe('帮我规划五一行程');
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
        expect(parseSpecialCommand('  /plan test  ').type).toBe('plan');
        
        // Test partial matches should not trigger
        expect(parseSpecialCommand('some /compact text').type).toBeNull();
        expect(parseSpecialCommand('/compactor').type).toBeNull();
        expect(parseSpecialCommand('/clearing').type).toBeNull();
        expect(parseSpecialCommand('/planner').type).toBeNull();
    });
});
