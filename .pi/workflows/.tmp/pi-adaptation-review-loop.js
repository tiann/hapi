const meta = {
  name: 'pi-adaptation-review-loop',
  description: 'Loop: review Pi adaptation vs other APC agents, fix issues, repeat until clean. Uses file-based output instead of structured output for reliability.',
};

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const MAX_ROUNDS = 5;
const MAX_FILES_PER_ROUND = 30;
const EXEC_TIMEOUT_MS = 30000;
const OUTPUT_FILE = path.join(process.cwd(), '.pi', 'review-result.json');
let round = 0;
let lastMustFix = null;
let preCommitHash = '';

// #7: git repo 前置检查
try {
  execSync('git rev-parse --git-dir', { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS });
} catch {
  throw new Error('Not inside a git repository. This workflow requires a git repo.');
}

function getAgentDirs() {
  const nonAgent = new Set([
    'pi', 'test', 'types', 'utils', 'modules', 'ui', 'api', 'runner',
    'terminal', 'runtime', 'commands', 'bin', 'constants', 'parsers',
    'lib', 'index', 'bootstrap', 'configuration', 'projectPath',
    'persistence', 'agent',
  ]);
  try {
    const cliSrc = path.join(process.cwd(), 'cli', 'src');
    return fs.readdirSync(cliSrc, { withFileTypes: true })
      .filter(e => e.isDirectory() && !nonAgent.has(e.name))
      .map(e => `- ${e.name} (cli/src/${e.name}/)`)
      .join('\n');
  } catch {
    return '- Claude Code (cli/src/claude/)\n- Codex (cli/src/codex/)\n- Gemini (cli/src/gemini/)\n- Opencode (cli/src/opencode/)\n- Kimi (cli/src/kimi/)\n- Cursor (cli/src/cursor/)';
  }
}

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

// Rollback to the commit hash at the start of this round.
// This discards ALL commits made during the round (design intent: atomic round).
function rollbackTo(targetHash) {
  if (!targetHash) return;
  try {
    execSync(`git reset --hard ${targetHash}`, { timeout: EXEC_TIMEOUT_MS });
  } catch { /* best effort */ }
}

// #5: 增加对 issues 数组内元素结构的校验
function isValidIssue(issue) {
  return (
    issue &&
    typeof issue === 'object' &&
    typeof issue.severity === 'string' &&
    typeof issue.category === 'string' &&
    typeof issue.description === 'string' &&
    typeof issue.fixed === 'boolean'
  );
}

function readResultFile() {
  let raw = '';
  try {
    raw = fs.readFileSync(OUTPUT_FILE, 'utf8').trim();
    const obj = JSON.parse(raw);
    if (
      typeof obj.mustFixCount === 'number' &&
      obj.mustFixCount >= 0 &&
      Array.isArray(obj.issues) &&
      obj.issues.every(isValidIssue)
    ) {
      return { data: obj, error: null };
    }
    return {
      data: null,
      error: `Validation failed: mustFixCount type=${typeof obj.mustFixCount}, issues.isArray=${Array.isArray(obj.issues)}`,
    };
  } catch (err) {
    return {
      data: null,
      error: `${err.name}: ${err.message}. Raw (first 200 chars): ${raw.slice(0, 200)}`,
    };
  }
}

function cleanupResultFile() {
  try { fs.unlinkSync(OUTPUT_FILE); } catch { /* ok */ }
}

// #4: 提取 gc 清理为独立函数，供 abort 路径复用
function runFinalCleanup() {
  try {
    execSync('git reflog expire --expire=now --all', { timeout: EXEC_TIMEOUT_MS });
    execSync('git gc --prune=now', { timeout: 60000 });
  } catch { /* best effort */ }
}

while (round < MAX_ROUNDS) {
  round++;
  cleanupResultFile();
  preCommitHash = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

  await agent({
    prompt: `## Pi Adaptation Review - Round ${round}

You are working on the HAPI project (branch: feat-pi-support).

### Task

**Step 1: Review Pi agent adaptation**

Compare Pi agent code against other agent implementations in HAPI:
${getAgentDirs()}

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
- Per-round limit: total files changed in this round must be <= ${MAX_FILES_PER_ROUND}
- If your fix would touch > ${MAX_FILES_PER_ROUND} files, only fix the most critical subset this round

Commit message: "fix(pi): review round ${round} - N must-fix issues"

**IMPORTANT: mustFixCount is the count BEFORE fixes. Fixes do not change this number.**

## Output [MANDATORY]
After completing all steps, write a JSON file to ${OUTPUT_FILE} with this exact format:

\`\`\`json
{
  "mustFixCount": <number of must-fix issues found BEFORE fixing>,
  "suggestionCount": <number of suggestions>,
  "issues": [
    {
      "severity": "MUST-FIX" | "SUGGESTION",
      "category": "<e.g. types, lifecycle, ui, config>",
      "description": "<what the issue is>",
      "fixed": true | false
    }
  ],
  "summary": "<brief summary of findings and fixes>"
}
\`\`\`

You MUST write this file. The workflow cannot continue without it.`,
    description: `pi-review-round-${round}`,
  });

  // Read result from file instead of structured output
  const { data: reviewResult, error: readError } = readResultFile();

  // #2: 移除无上下文的 retry agent，直接 abort
  // 原实现中 retry agent 不继承上一轮 agent 的上下文，
  // 写出的结果必然是编造的，没有参考价值

  if (!reviewResult) {
    cleanupResultFile();
    runFinalCleanup();
    return {
      rounds: round,
      clean: false,
      aborted: true,
      abortReason: `Round ${round}: ${readError || 'agent did not write result file'}`,
      lastMustFixCount: lastMustFix ?? 'N/A (round not completed)',
    };
  }

  lastMustFix = reviewResult.mustFixCount;
  cleanupResultFile();

  // Diff guard
  // #1: 用 git diff --name-only 精确统计变更文件数
  const currentHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const hasNewCommit = currentHead !== preCommitHash;

  if (hasNewCommit) {
    const changedFiles = execSync(
      `git diff --name-only ${preCommitHash}..${currentHead}`,
      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS },
    ).trim().split('\n').filter(Boolean);
    const fileCount = changedFiles.length;
    if (fileCount > MAX_FILES_PER_ROUND) {
      rollbackTo(preCommitHash);
      cleanRewindRefs();
      // #3: abort 路径补充 cleanup result file 和 gc
      cleanupResultFile();
      runFinalCleanup();
      return {
        rounds: round,
        clean: false,
        aborted: true,
        abortReason: `Round ${round} changed ${fileCount} files (max ${MAX_FILES_PER_ROUND}). Rolled back.`,
        lastMustFixCount: lastMustFix,
      };
    }
  }

  cleanRewindRefs();

  // Continue or break
  if (lastMustFix === 0) break;
}

// Final cleanup
runFinalCleanup();

return {
  rounds: round,
  clean: lastMustFix === 0,
  lastMustFixCount: lastMustFix ?? 'N/A',
  message: lastMustFix === 0
    ? `Clean! All issues resolved after ${round} round(s).`
    : `Max rounds (${MAX_ROUNDS}) reached, ${lastMustFix} must-fix issues remain.`,
};
