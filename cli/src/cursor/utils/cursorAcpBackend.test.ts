import { describe, expect, it } from 'vitest';
import {
    buildCursorAcpArgs,
    createCursorAcpBackend,
    CURSOR_ACP_REQUIRED_MESSAGE,
    resolveCursorNativeWorktreePath
} from './cursorAcpBackend';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('createCursorAcpBackend', () => {
    it('uses agent acp command, not stream-json flags', () => {
        const backend = createCursorAcpBackend({ cwd: '/tmp' });
        const internal = backend as unknown as { transport: null; options?: unknown };
        // Backend stores args on the transport after initialize; inspect via build helper.
        expect(buildCursorAcpArgs({})).toEqual(['acp']);
        expect(CURSOR_ACP_REQUIRED_MESSAGE).toContain('agent help acp');
        expect(internal).toBeTruthy();
    });

    it('passes --model before acp when a concrete model is requested', () => {
        expect(
            buildCursorAcpArgs({
                model: 'composer-2.5[fast=true]'
            })
        ).toEqual([
            '--model',
            'composer-2.5[fast=true]',
            'acp'
        ]);
    });

    it('omits --model for default/auto spawn selection', () => {
        expect(buildCursorAcpArgs({ model: 'auto' })).toEqual(['acp']);
    });

    it('adds --auto-review, --worktree, and --add-dir before acp', () => {
        expect(
            buildCursorAcpArgs({
                autoReview: true,
                worktree: 'feature-x',
                addDirs: ['/tmp/a', ' /tmp/b '],
                model: 'composer-2.5'
            })
        ).toEqual([
            '--auto-review',
            '--worktree',
            'feature-x',
            '--add-dir',
            '/tmp/a',
            '--add-dir',
            '/tmp/b',
            '--model',
            'composer-2.5',
            'acp'
        ]);
    });

    it('emits bare --worktree when name is omitted', () => {
        expect(buildCursorAcpArgs({ worktree: true })).toEqual(['--worktree', 'acp']);
        expect(buildCursorAcpArgs({ worktree: '' })).toEqual(['--worktree', 'acp']);
    });
});

describe('resolveCursorNativeWorktreePath', () => {
    it('matches ~/.cursor/worktrees/<repo>/<name>', () => {
        expect(resolveCursorNativeWorktreePath('/home/u/proj/hapi', 'feature-x')).toBe(
            join(homedir(), '.cursor', 'worktrees', 'hapi', 'feature-x')
        );
    });
});
