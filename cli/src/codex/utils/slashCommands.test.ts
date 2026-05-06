import { describe, expect, it } from 'vitest';
import { resolveCodexSlashCommand } from './slashCommands';

const state = {
    permissionMode: 'default' as const,
    collaborationMode: 'default' as const,
    model: 'gpt-5.5',
    modelReasoningEffort: 'high' as const
};

describe('resolveCodexSlashCommand', () => {
    it('enables plan mode without sending a turn', () => {
        expect(resolveCodexSlashCommand('/plan', state)).toEqual({
            kind: 'handled',
            message: 'Codex plan mode enabled',
            updates: { collaborationMode: 'plan' }
        });
    });

    it('enables plan mode and sends prompt when /plan has text', () => {
        expect(resolveCodexSlashCommand('/plan design the fix', state)).toEqual({
            kind: 'replace',
            text: 'design the fix',
            message: 'Codex plan mode enabled',
            updates: { collaborationMode: 'plan' }
        });
    });

    it('returns to default collaboration mode', () => {
        expect(resolveCodexSlashCommand('/plan off', { ...state, collaborationMode: 'plan' })).toEqual({
            kind: 'handled',
            message: 'Codex plan mode disabled',
            updates: { collaborationMode: 'default' }
        });
    });

    it('sets model, reasoning effort, and permission mode', () => {
        expect(resolveCodexSlashCommand('/model gpt-5.4', state)).toMatchObject({
            updates: { model: 'gpt-5.4' }
        });
        expect(resolveCodexSlashCommand('/reasoning low', state)).toMatchObject({
            updates: { modelReasoningEffort: 'low' }
        });
        expect(resolveCodexSlashCommand('/permissions yolo', state)).toMatchObject({
            updates: { permissionMode: 'yolo' }
        });
    });

    it('expands custom Codex prompt commands', () => {
        expect(resolveCodexSlashCommand('/review src/index.ts', {
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

    it('handles unsupported Codex built-in commands instead of sending them to the model', () => {
        for (const command of ['diff', 'undo', 'review', 'compat']) {
            expect(resolveCodexSlashCommand(`/${command}`, state)).toEqual({
                kind: 'handled',
                message: `/${command} is a Codex CLI command that is not supported in HAPI sessions yet.`
            });
        }
    });

    it('expands custom prompts before checking unsupported built-in names', () => {
        expect(resolveCodexSlashCommand('/review src/index.ts', {
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

    it('passes unknown slash commands through', () => {
        expect(resolveCodexSlashCommand('/unknown', state)).toEqual({ kind: 'passthrough' });
    });
});
