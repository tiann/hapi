import { describe, it, expect } from 'vitest';
import { filterResumeSubcommand } from './codexLocal';

describe('filterResumeSubcommand', () => {
    it('returns empty array unchanged', () => {
        expect(filterResumeSubcommand([])).toEqual([]);
    });

    it('passes through args when first arg is not resume', () => {
        expect(filterResumeSubcommand(['--model', 'gpt-4'])).toEqual(['--model', 'gpt-4']);
        expect(filterResumeSubcommand(['--sandbox', 'read-only'])).toEqual(['--sandbox', 'read-only']);
    });

    it('filters resume subcommand with session ID', () => {
        expect(filterResumeSubcommand(['resume', 'abc-123'])).toEqual([]);
        expect(filterResumeSubcommand(['resume', 'abc-123', '--model', 'gpt-4']))
            .toEqual(['--model', 'gpt-4']);
    });

    it('filters resume subcommand without session ID', () => {
        expect(filterResumeSubcommand(['resume'])).toEqual([]);
        expect(filterResumeSubcommand(['resume', '--model', 'gpt-4']))
            .toEqual(['--model', 'gpt-4']);
    });

    it('does not filter resume when it appears as flag value', () => {
        // --name resume should pass through (resume is value, not subcommand)
        expect(filterResumeSubcommand(['--name', 'resume'])).toEqual(['--name', 'resume']);
    });

    it('does not filter resume in middle of args', () => {
        // If resume appears after flags, it's not the subcommand position
        expect(filterResumeSubcommand(['--model', 'gpt-4', 'resume', '123']))
            .toEqual(['--model', 'gpt-4', 'resume', '123']);
    });
});
