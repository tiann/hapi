const meta = {
  name: 'pi-adaptation-review-loop',
  description: 'Loop: review Pi adaptation vs other APC agents, fix issues, repeat until clean. With diff guard and safety constraints.',
};

const { execSync } = require('child_process');
const MAX_ROUNDS = 5;
const MAX_CHANGED_FILES_PER_ROUND = 20;
const EXEC_TIMEOUT_MS = 30000;
let round = 0;
let lastMustFix = -1;
let preCommitHash = '';

/** Delete all refs under refs/pi-rewind/ */
function cleanRewindRefs() {
  try {
    const refs = execSync('git for-each-ref --format="%(refname)" refs/pi-rewind/', {
      encoding: 'utf8', timeout: EXEC_TIMEOUT_MS,
    }).trim();
    for (const ref of refs.split('\n').filter(Boolean)) {
      execSync(`git update-ref -d "${ref}"`, { timeout: EXEC_TIMEOUT_MS });
    }
  } catch { /* no refs to clean */ }
}

/** Rollback to a known-good commit hash */
function rollbackTo(targetHash) {
  if (!targetHash) return;
  try {
    execSync(`git reset --hard ${targetHash}`, { timeout: EXEC_TIMEOUT_MS });
  } catch { /* best effort */ }
}

cleanRewindRefs();

while (round < MAX_ROUNDS) {
  round++;

  // Snapshot HEAD before this round starts, so we can rollback if needed
  preCommitHash = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

  // Node 1: Review + Fix
  const reviewResult = await agent({
    prompt: `## Pi Adaptation Review - Round ${round}

You are working on the HAPI project (branch: feat-pi-support).

### Task

**Step 1: Review Pi agent adaptation**

Compare Pi agent code against other agent implementations in HAPI:
- Claude Code (cli/src/claude/)
- Codex (cli/src/codex/)
- Gemini (cli/src/gemini/)
- Opencode (cli/src/opencode/)
- Kimi (cli/src/kimi/)
- Cursor (cli/src/cursor/)

Search for Pi-related files and review:
1. Interface alignment (lifecycle, message format, event emission)
2. API endpoints (hub routes/socket handlers)
3. Web UI (session display, icons, model options)
4. Shared types and schemas
5. CLI config and launch flow
6. Missing features present in other agents but absent for Pi

**Step 2: List issues**
Classify findings as:
- MUST-FIX: broken functionality, data loss, type errors
- SUGGESTION: improvements that don't affect functionality

**Step 3: Fix all MUST-FIX issues**

## Git Constraints [MANDATORY]
- ONLY use: git add + git commit
- FORBIDDEN: git checkout <branch>, git reset, git restore, git stash, git rebase, git merge
- FORBIDDEN: pi rewind command
- FORBIDDEN: any cross-branch file operations
- BEFORE committing: verify git diff --stat shows <= ${MAX_CHANGED_FILES_PER_ROUND} files changed
- If your fix would touch > ${MAX_CHANGED_FILES_PER_ROUND} files, split into smaller commits

Commit message: "fix(pi): review round ${round} - N must-fix issues"

**IMPORTANT: mustFixCount is the count BEFORE fixes. Fixes do not change this number.**

### Output
Fill mustFixCount with the number of must-fix issues found during review (before fixing).`,
    schema: {
      type: 'object',
      properties: {
        mustFixCount: { type: 'number', minimum: 0, description: 'Number of must-fix issues found during review (before fixes)' },
        suggestionCount: { type: 'number', minimum: 0, description: 'Number of suggestions' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['MUST-FIX', 'SUGGESTION'] },
              category: { type: 'string' },
              description: { type: 'string' },
              fixed: { type: 'boolean' },
            },
            required: ['severity', 'category', 'description'],
          },
        },
        summary: { type: 'string' },
      },
      required: ['mustFixCount', 'suggestionCount', 'issues', 'summary'],
    },
    description: `pi-review-round-${round}`,
  });

  lastMustFix = reviewResult.mustFixCount;

  // Node 2: Diff guard — verify agent didn't make dangerous changes
  const currentHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const hasNewCommit = currentHead !== preCommitHash;

  if (hasNewCommit) {
    const diffStat = execSync(`git diff --stat ${preCommitHash}..${currentHead}`, {
      encoding: 'utf8', timeout: EXEC_TIMEOUT_MS,
    });
    const fileCount = (diffStat.match(/\n/g) || []).length - 1; // last line is summary

    if (fileCount > MAX_CHANGED_FILES_PER_ROUND) {
      // Too many files changed — rollback and abort
      rollbackTo(preCommitHash);
      cleanRewindRefs();
      return {
        rounds: round,
        clean: false,
        aborted: true,
        abortReason: `Round ${round} changed ${fileCount} files (max ${MAX_CHANGED_FILES_PER_ROUND}). Rolled back.`,
        lastMustFixCount: lastMustFix,
      };
    }
  }

  // Cleanup pi-rewind refs after each round
  cleanRewindRefs();

  // Node 3: Pure logic — continue or break
  if (lastMustFix === 0) break;
}

// Final cleanup
try {
  execSync('git reflog expire --expire=now --all', { timeout: EXEC_TIMEOUT_MS });
  execSync('git gc --prune=now', { timeout: 60000 });
} catch { /* best effort */ }

return {
  rounds: round,
  clean: lastMustFix === 0,
  lastMustFixCount: lastMustFix,
  message: lastMustFix === 0
    ? `Clean! All issues resolved after ${round} round(s).`
    : `Max rounds (${MAX_ROUNDS}) reached, ${lastMustFix} must-fix issues remain.`,
};
