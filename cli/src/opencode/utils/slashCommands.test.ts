import { describe, expect, it } from 'vitest';
import { resolveOpencodeSlashCommand } from './slashCommands';

const state = {
    permissionMode: 'default' as const,
    model: 'anthropic/claude-sonnet-4-5',
    modelReasoningEffort: 'high' as const
};

describe('resolveOpencodeSlashCommand', () => {
    it('enables plan mode without sending a turn', () => {
        expect(resolveOpencodeSlashCommand('/plan', state)).toEqual({
            kind: 'handled',
            message: 'OpenCode plan mode enabled',
            updates: { permissionMode: 'plan' }
        });
    });

    it('enables plan mode and sends prompt when /plan has text', () => {
        expect(resolveOpencodeSlashCommand('/plan design the fix', state)).toEqual({
            kind: 'replace',
            text: 'design the fix',
            message: 'OpenCode plan mode enabled',
            updates: { permissionMode: 'plan' }
        });
    });

    it('returns to default permission mode from /plan off', () => {
        expect(resolveOpencodeSlashCommand('/plan off', { ...state, permissionMode: 'plan' })).toEqual({
            kind: 'handled',
            message: 'OpenCode plan mode disabled',
            updates: { permissionMode: 'default' }
        });
    });

    it('handles /default', () => {
        expect(resolveOpencodeSlashCommand('/default', { ...state, permissionMode: 'plan' })).toEqual({
            kind: 'handled',
            message: 'OpenCode permission mode set to default',
            updates: { permissionMode: 'default' }
        });
    });

    it('sets model, reasoning effort, and permission mode', () => {
        expect(resolveOpencodeSlashCommand('/model openai/gpt-5', state)).toMatchObject({
            updates: { model: 'openai/gpt-5' }
        });
        expect(resolveOpencodeSlashCommand('/model default', state)).toMatchObject({
            updates: { model: null }
        });
        expect(resolveOpencodeSlashCommand('/reasoning low', state)).toMatchObject({
            updates: { modelReasoningEffort: 'low' }
        });
        expect(resolveOpencodeSlashCommand('/effort default', state)).toMatchObject({
            updates: { modelReasoningEffort: null }
        });
        expect(resolveOpencodeSlashCommand('/permissions yolo', state)).toMatchObject({
            updates: { permissionMode: 'yolo' }
        });
        expect(resolveOpencodeSlashCommand('/permission plan', state)).toMatchObject({
            updates: { permissionMode: 'plan' }
        });
    });

    it('rejects unknown permission modes', () => {
        expect(resolveOpencodeSlashCommand('/permissions bogus', state)).toMatchObject({
            kind: 'handled',
            message: expect.stringContaining('Unknown OpenCode permission mode')
        });
    });

    it('shows current values when slash command has no argument', () => {
        expect(resolveOpencodeSlashCommand('/model', state)).toEqual({
            kind: 'handled',
            message: 'OpenCode model: anthropic/claude-sonnet-4-5'
        });
        expect(resolveOpencodeSlashCommand('/reasoning', state)).toEqual({
            kind: 'handled',
            message: 'OpenCode reasoning effort: high'
        });
        expect(resolveOpencodeSlashCommand('/permissions', state)).toEqual({
            kind: 'handled',
            message: 'OpenCode permission mode: default'
        });
    });

    it('returns status summary', () => {
        const status = resolveOpencodeSlashCommand('/status', state);
        expect(status).toMatchObject({
            kind: 'handled',
            message: expect.stringContaining('OpenCode status')
        });
        if (status.kind === 'handled') {
            expect(status.message).toContain('permission: `default`');
            expect(status.message).toContain('model: `anthropic/claude-sonnet-4-5`');
            expect(status.message).toContain('reasoning: `high`');
        }
    });

    it('expands /init into a project-analysis prompt', () => {
        const result = resolveOpencodeSlashCommand('/init', state);
        expect(result).toMatchObject({
            kind: 'replace',
            message: 'Initializing AGENTS.md…'
        });
        if (result.kind === 'replace') {
            expect(result.text).toContain('AGENTS.md');
            expect(result.text).toContain('Build / lint / test');
        }
    });

    it('appends extra instructions when /init has arguments', () => {
        const result = resolveOpencodeSlashCommand('/init focus on the cli/ workspace', state);
        if (result.kind === 'replace') {
            expect(result.text).toContain('AGENTS.md');
            expect(result.text).toContain('Additional instructions: focus on the cli/ workspace');
        } else {
            throw new Error(`expected replace, got ${result.kind}`);
        }
    });

    it('resolves builtin /clear to the dedicated fresh-session operation', () => {
        expect(resolveOpencodeSlashCommand('/clear', state)).toEqual({ kind: 'clear' });
    });

    it('resolves /compact to a dedicated kind so the launcher can bridge to native compaction asynchronously', () => {
        expect(resolveOpencodeSlashCommand('/compact', state)).toEqual({ kind: 'compact' });
    });

    it('resolves /compact the same way regardless of trailing arguments (compaction takes no arguments)', () => {
        expect(resolveOpencodeSlashCommand('/compact now please', state)).toEqual({ kind: 'compact' });
    });

    it('expands custom OpenCode command prompts', () => {
        expect(resolveOpencodeSlashCommand('/review src/index.ts', {
            ...state,
            commands: [
                { name: 'review', source: 'project', content: 'Review this code.' }
            ]
        })).toEqual({
            kind: 'replace',
            text: 'Review this code.\n\nUser arguments: src/index.ts',
            message: 'Expanded /review'
        });
    });

    it('expands custom prompts even when name matches a built-in', () => {
        expect(resolveOpencodeSlashCommand('/clear', {
            ...state,
            commands: [
                { name: 'clear', source: 'project', content: 'Clear project notes.' }
            ]
        })).toEqual({
            kind: 'replace',
            text: 'Clear project notes.',
            message: 'Expanded /clear'
        });
    });

    it('renders /help with the supported commands', () => {
        const help = resolveOpencodeSlashCommand('/help', state);
        expect(help).toMatchObject({ kind: 'handled' });
        if (help.kind === 'handled') {
            expect(help.message).toContain('Supported OpenCode slash commands');
            expect(help.message).toContain('/plan');
            expect(help.message).toContain('/permissions');
            expect(help.message).toContain('/compact` — compact (summarize) the OpenCode session context (remote sessions only)');
            expect(help.message).toContain('/clear` — archive this HAPI session and open a fresh OpenCode session');
        }
    });

    it('passes unknown slash commands through', () => {
        expect(resolveOpencodeSlashCommand('/unknown', state)).toEqual({ kind: 'passthrough' });
    });

    it('passes plain text through', () => {
        expect(resolveOpencodeSlashCommand('hello there', state)).toEqual({ kind: 'passthrough' });
    });
});
