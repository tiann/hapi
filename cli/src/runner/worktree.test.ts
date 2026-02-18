import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorktree, removeWorktree } from './worktree';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

async function createRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'hapi-worktree-test-'));
  git(['init'], repoRoot);
  git(['config', 'user.name', 'Hapi Test'], repoRoot);
  git(['config', 'user.email', 'hapi-test@example.com'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), '# test\n');
  git(['add', 'README.md'], repoRoot);
  git(['commit', '-m', 'init'], repoRoot);
  return repoRoot;
}

const tempRoots: string[] = [];

afterEach(async () => {
  for (const path of tempRoots.splice(0, tempRoots.length)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe('createWorktree', () => {
  it('creates a new hapi-prefixed branch by default', async () => {
    const repoRoot = await createRepo();
    tempRoots.push(repoRoot);

    const result = await createWorktree({ basePath: repoRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.info.branch.startsWith('hapi-')).toBe(true);

    const branchInWorktree = git(['rev-parse', '--abbrev-ref', 'HEAD'], result.info.worktreePath);
    expect(branchInWorktree).toBe(result.info.branch);

    const removeResult = await removeWorktree({
      repoRoot: result.info.basePath,
      worktreePath: result.info.worktreePath
    });
    expect(removeResult.ok).toBe(true);
  });

  it('checks out an existing local branch when provided', async () => {
    const repoRoot = await createRepo();
    tempRoots.push(repoRoot);

    git(['branch', 'feature/local-branch'], repoRoot);

    const result = await createWorktree({
      basePath: repoRoot,
      branch: 'feature/local-branch'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const branchInWorktree = git(['rev-parse', '--abbrev-ref', 'HEAD'], result.info.worktreePath);
    expect(branchInWorktree).toBe('feature/local-branch');

    const removeResult = await removeWorktree({
      repoRoot: result.info.basePath,
      worktreePath: result.info.worktreePath
    });
    expect(removeResult.ok).toBe(true);
  });

  it('creates provided branch when it does not exist', async () => {
    const repoRoot = await createRepo();
    tempRoots.push(repoRoot);

    const result = await createWorktree({
      basePath: repoRoot,
      branch: 'feature/manual-input'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const branchInWorktree = git(['rev-parse', '--abbrev-ref', 'HEAD'], result.info.worktreePath);
    expect(branchInWorktree).toBe('feature/manual-input');

    const branchInRepo = git(['show-ref', '--verify', '--quiet', 'refs/heads/feature/manual-input'], repoRoot);
    expect(branchInRepo).toBe('');

    const removeResult = await removeWorktree({
      repoRoot: result.info.basePath,
      worktreePath: result.info.worktreePath
    });
    expect(removeResult.ok).toBe(true);
  });
});
