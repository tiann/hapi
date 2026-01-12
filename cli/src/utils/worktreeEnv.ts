import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import type { WorktreeInfo } from '@/daemon/worktree';
import { logger } from '@/ui/logger';

export function readWorktreeEnv(): WorktreeInfo | null {
    return readWorktreeFromEnv() ?? readWorktreeFromGit();
}

function readWorktreeFromEnv(): WorktreeInfo | null {
    const basePath = process.env.HAPI_WORKTREE_BASE_PATH?.trim();
    const branch = process.env.HAPI_WORKTREE_BRANCH?.trim();
    const name = process.env.HAPI_WORKTREE_NAME?.trim();
    const worktreePath = process.env.HAPI_WORKTREE_PATH?.trim();
    const createdAtRaw = process.env.HAPI_WORKTREE_CREATED_AT?.trim();

    if (!basePath || !branch || !name || !worktreePath || !createdAtRaw) {
        return null;
    }

    const createdAt = Number(createdAtRaw);
    if (!Number.isFinite(createdAt)) {
        return null;
    }

    return {
        basePath,
        branch,
        name,
        worktreePath,
        createdAt
    };
}

function readWorktreeFromGit(): WorktreeInfo | null {
    const start = Date.now();
    let result: WorktreeInfo | null = null;

    try {
        const cwd = process.cwd();
        const isInside = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
        if (isInside !== 'true') {
            return null;
        }

        const gitDir = runGit(['rev-parse', '--git-dir'], cwd);
        const gitCommonDir = runGit(['rev-parse', '--git-common-dir'], cwd);
        if (!gitDir || !gitCommonDir) {
            return null;
        }

        const resolvedGitDir = normalizePath(gitDir, cwd);
        const resolvedGitCommonDir = normalizePath(gitCommonDir, cwd);
        if (resolvedGitDir === resolvedGitCommonDir) {
            return null;
        }

        const worktreeRoot = runGit(['rev-parse', '--show-toplevel'], cwd);
        if (!worktreeRoot) {
            return null;
        }
        const worktreePath = normalizePath(worktreeRoot, cwd);
        const basePath = dirname(resolvedGitCommonDir);

        const branch = runGit(['symbolic-ref', '--short', 'HEAD'], cwd)
            ?? runGit(['rev-parse', '--short', 'HEAD'], cwd);
        if (!branch) {
            return null;
        }

        result = {
            basePath,
            branch,
            name: basename(worktreePath),
            worktreePath,
            createdAt: readCreatedAt(worktreePath)
        };
        return result;
    } finally {
        const elapsedMs = Date.now() - start;
        logger.debug(`[WORKTREE] Git probe ${result ? 'hit' : 'miss'} in ${elapsedMs}ms`);
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

function readCreatedAt(worktreePath: string): number {
    try {
        const stat = statSync(worktreePath);
        const birthtimeMs = Math.round(stat.birthtimeMs);
        if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) {
            return birthtimeMs;
        }
        const ctimeMs = Math.round(stat.ctimeMs);
        if (Number.isFinite(ctimeMs) && ctimeMs > 0) {
            return ctimeMs;
        }
    } catch {
        return Date.now();
    }
    return Date.now();
}
