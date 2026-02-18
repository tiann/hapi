import { describe, it, expect } from 'vitest';
import { parseCompact, parseClear, parseNew, parseModel, parseSpecialCommand } from './specialCommands';

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

    it('should detect new command', () => {
        const result = parseSpecialCommand('/new');
        expect(result.type).toBe('new');
        expect(result.originalMessage).toBeUndefined();
    });

    it('should detect model command', () => {
        const result = parseSpecialCommand('/model gpt-5');
        expect(result.type).toBe('model');
        expect(result.originalMessage).toBe('/model gpt-5');
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
        
        // Test partial matches should not trigger
        expect(parseSpecialCommand('some /compact text').type).toBeNull();
        expect(parseSpecialCommand('/compactor').type).toBeNull();
        expect(parseSpecialCommand('/clearing').type).toBeNull();
        expect(parseSpecialCommand('/new now').type).toBeNull();
    });
});

describe('parseNew', () => {
    it('should parse /new command exactly', () => {
        const result = parseNew('/new');
        expect(result.isNew).toBe(true);
    });

    it('should parse /new command with whitespace', () => {
        const result = parseNew('  /new  ');
        expect(result.isNew).toBe(true);
    });

    it('should not parse /new with arguments', () => {
        const result = parseNew('/new now');
        expect(result.isNew).toBe(false);
    });
});

describe('parseModel', () => {
    it('should parse /model command with argument', () => {
        const result = parseModel('/model o3');
        expect(result.isModel).toBe(true);
        expect(result.originalMessage).toBe('/model o3');
    });

    it('should parse /model command without argument', () => {
        const result = parseModel('/model');
        expect(result.isModel).toBe(true);
        expect(result.originalMessage).toBe('/model');
    });

    it('should not parse regular text', () => {
        const result = parseModel('model o3');
        expect(result.isModel).toBe(false);
    });
});
