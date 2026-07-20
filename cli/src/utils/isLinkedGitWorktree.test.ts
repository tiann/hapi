import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { isLinkedGitWorktree } from './isLinkedGitWorktree';

describe('isLinkedGitWorktree', () => {
    const temps: string[] = [];

    afterEach(() => {
        for (const dir of temps.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }
    });

    function tempDir(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        temps.push(dir);
        return dir;
    }

    function git(cwd: string, args: string[]): void {
        execFileSync('git', args, {
            cwd,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test',
                GIT_AUTHOR_EMAIL: 'test@example.com',
                GIT_COMMITTER_NAME: 'test',
                GIT_COMMITTER_EMAIL: 'test@example.com'
            }
        });
    }

    it('returns false for a primary working tree', () => {
        const repo = tempDir('hapi-primary-');
        git(repo, ['init']);
        writeFileSync(join(repo, 'README'), 'x\n');
        git(repo, ['add', 'README']);
        git(repo, ['commit', '-m', 'init']);

        expect(isLinkedGitWorktree(repo)).toBe(false);
    });

    it('returns true for a linked git worktree', () => {
        const repo = tempDir('hapi-linked-main-');
        git(repo, ['init']);
        writeFileSync(join(repo, 'README'), 'x\n');
        git(repo, ['add', 'README']);
        git(repo, ['commit', '-m', 'init']);

        const linked = join(tempDir('hapi-linked-wt-'), 'feature');
        git(repo, ['worktree', 'add', '-b', 'feature', linked]);

        expect(isLinkedGitWorktree(linked)).toBe(true);
        expect(isLinkedGitWorktree(repo)).toBe(false);
    });

    it('returns false for a non-git directory', () => {
        const dir = tempDir('hapi-nongit-');
        expect(isLinkedGitWorktree(dir)).toBe(false);
    });
});
