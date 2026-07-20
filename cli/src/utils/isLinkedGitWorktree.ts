import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * True when `directory` is a linked Git worktree (`.git` is a file pointing at
 * the common object store), not the repository's primary working tree.
 *
 * Cursor `agent --worktree` nested inside an existing linked worktree hangs ACP
 * initialize (see tiann/hapi#1085). HAPI skips `--cursor-worktree` in that case
 * and runs in the given directory instead.
 */
export function isLinkedGitWorktree(directory: string): boolean {
    try {
        const isInside = runGit(['rev-parse', '--is-inside-work-tree'], directory);
        if (isInside !== 'true') {
            return false;
        }

        const gitDir = runGit(['rev-parse', '--git-dir'], directory);
        const gitCommonDir = runGit(['rev-parse', '--git-common-dir'], directory);
        if (!gitDir || !gitCommonDir) {
            return false;
        }

        return normalizePath(gitDir, directory) !== normalizePath(gitCommonDir, directory);
    } catch {
        return false;
    }
}

function runGit(args: string[], cwd: string): string | null {
    try {
        const output = execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return output.length > 0 ? output : null;
    } catch {
        return null;
    }
}

function normalizePath(rawPath: string, cwd: string): string {
    const resolved = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}
