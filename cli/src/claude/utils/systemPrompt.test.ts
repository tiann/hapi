import { describe, expect, it } from 'vitest';
import { systemPrompt } from './systemPrompt';

describe('claude systemPrompt', () => {
    it('keeps change_title instruction', () => {
        expect(systemPrompt).toContain('mcp__hapi__change_title');
    });

    it('adds spawn_session instruction', () => {
        expect(systemPrompt).toContain('mcp__hapi__spawn_session');
    });

    it('describes spawn heuristics and parameters', () => {
        expect(systemPrompt).toMatch(/delegate|parallel|isolated|subtask/i);
        expect(systemPrompt).toContain('Do not spawn');
        expect(systemPrompt).toContain('directory');
        expect(systemPrompt).toContain('machineId');
        expect(systemPrompt).toContain('agent');
    });
});
