import type { WorktreeInfo } from '@/daemon/worktree';

export function readWorktreeEnv(): WorktreeInfo | null {
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
