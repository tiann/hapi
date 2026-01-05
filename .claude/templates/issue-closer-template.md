# Issue Closer Template - HAPImatic

## Phase Objective
Complete the issue lifecycle: code review, PR creation/merge, issue closure, and cleanup.

## PRE-CLOSING CHECKLIST

Before starting:
- [ ] Sentinel file exists: `claudedocs/issue-XX-awaiting-approval.md`
- [ ] User has explicitly approved the implementation
- [ ] Git working directory is clean

## EXACT STEPS (Execute in order)

### Step 1: Read Sentinel File

```bash
cat claudedocs/issue-XX-awaiting-approval.md
```

Extract:
- Issue number
- Branch name
- Complexity level
- Files modified
- Server restart requirement

### Step 2: Code Review

Review all modified files for:

#### Correctness
- [ ] Code does what it's supposed to do
- [ ] Logic is sound
- [ ] Edge cases handled

#### TypeScript
- [ ] No type errors
- [ ] Proper typing (no excessive `any`)
- [ ] Interfaces/types well-defined

#### Patterns
- [ ] Follows existing codebase patterns
- [ ] Consistent naming conventions
- [ ] Proper file organization

#### Security
- [ ] No exposed secrets or credentials
- [ ] Proper input validation
- [ ] No XSS vulnerabilities (for web changes)

#### CLAUDE.md Compliance
- [ ] Follows project-specific rules
- [ ] Server restart warnings respected

#### Issues Found
If critical issues found:
1. Document the issues
2. Report to user
3. Wait for guidance before proceeding

### Step 3: Git Verification

```bash
git status
git log --oneline -5
```

Verify:
- Working directory is clean
- All changes are committed
- Commits reference the issue

### Step 4: PR Creation (Feature Branch Only)

If on a feature branch (not main):

```bash
gh pr create --repo MattStarfield/hapimatic \
  --title "Fix #XX: [Brief description]" \
  --body "## Summary
[Description of changes]

## Changes Made
- [Change 1]
- [Change 2]

## Testing
- [x] Typecheck passed
- [x] Build successful
- [x] Playwright verification (if applicable)
- [x] Manual user testing

Fixes #XX"
```

### Step 5: PR Merge

```bash
gh pr merge --squash --delete-branch
```

### Step 6: Deployment Decision

If server restart is required:

```
⚠️  DEPLOYMENT WILL RESTART SERVER

Deploying the new binary will restart HAPImatic and disconnect all active sessions.

The following steps will be performed:
1. Stop hapimatic service
2. Copy new binary to ~/.local/bin/hapimatic
3. Start hapimatic service

Are you sure you want to proceed with deployment?
```

**Wait for explicit approval before deploying.**

If approved:
```bash
systemctl --user stop hapimatic
cp cli/dist-exe/bun-linux-arm64/hapi ~/.local/bin/hapimatic
systemctl --user start hapimatic
systemctl --user status hapimatic
```

### Step 7: Post Closing Summary

Post comment to GitHub issue:

```bash
gh issue comment XX --repo MattStarfield/hapimatic --body "## Issue Resolved - Final Summary

### Problem
[Original problem from issue description]

### Solution
[What was implemented]

### Files Modified
- \`file1.ts:10-25\` - [what changed]
- \`file2.tsx:50-75\` - [what changed]

### Verification
- [x] Typecheck passed
- [x] Build successful
- [x] Playwright verification passed (if applicable)
- [x] Manual user testing completed
- [x] Code review passed
- [x] [PR #XX merged to main / Direct commit to main]

### Deployment
[Deployed and server restarted / No deployment needed / Pending user deployment]

---
*Closed by issue-closer agent*"
```

### Step 8: Close Issue

```bash
gh issue close XX --repo MattStarfield/hapimatic
```

### Step 9: Cleanup

```bash
# Delete sentinel file
rm claudedocs/issue-XX-awaiting-approval.md

# Delete analysis file if exists
rm -f claudedocs/issue-XX-analysis.md

# Clean up local branch if feature branch was used
git branch -d issue-XX-description 2>/dev/null || true
```

### Step 10: Final Report

Present to user:
- Confirmation issue is closed
- Link to closed issue
- Summary of actions taken
- Deployment status

## REQUIRED OUTPUT FORMAT

```
## Issue #XX Closed Successfully

### Actions Completed
- [x] Code review passed
- [x] [PR #XX created and merged / Direct commit verified]
- [x] Closing summary posted
- [x] Issue closed
- [x] Cleanup completed
- [x] [Server restarted / Deployment pending / No deployment needed]

### Issue URL
https://github.com/MattStarfield/hapimatic/issues/XX

### Summary
[Brief summary of what was accomplished]
```

## PROHIBITED ACTIONS
- Skipping code review
- Closing issue without posting summary
- Force pushing
- Deleting branches that aren't for this issue
- Deploying without user approval when restart is required

## ERROR HANDLING

If any step fails:
1. STOP immediately
2. Report the exact error
3. Do NOT close the issue
4. Do NOT delete sentinel file
5. Ask user for guidance
