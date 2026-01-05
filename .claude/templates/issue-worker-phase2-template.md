# Issue Worker Phase 2: Implementation Template - HAPImatic

## Phase Objective
Implement the approved solution, verify with tests and Playwright, and prepare for user approval.

## PRE-IMPLEMENTATION CHECKLIST

Before starting:
- [ ] Phase 1 analysis document exists: `claudedocs/issue-XX-analysis.md`
- [ ] User has explicitly approved the implementation approach
- [ ] Git working directory is clean: `git status`

## EXACT STEPS (Execute in order)

### Step 1: Create Feature Branch (Medium/High Complexity)

For medium or high complexity issues:
```bash
git checkout -b issue-XX-short-description
```

For low complexity issues, work directly on main.

### Step 2: Implement Changes

Follow the implementation plan from Phase 1 analysis:
- Use Edit tool for precise modifications
- Follow existing code patterns and style
- Add necessary imports
- Handle error cases

**Commit Guidelines:**
- Commit incrementally with clear messages
- Format: `fix: description` or `feat: description`
- Reference issue: `Fixes #XX` or `Part of #XX`

### Step 3: Build Verification

```bash
# Type checking
bun run typecheck

# Build single executable
bun run build:single-exe
```

Both must pass. If errors:
1. Fix the errors
2. Re-run verification
3. Do not proceed until passing

### Step 4: Playwright Verification (UI Changes Only)

If the issue involves UI changes, execute Playwright verification:

#### Desktop Verification (1280x800)
```
1. browser_resize: width=1280, height=800
2. browser_navigate: http://localhost:3007
3. browser_snapshot: Capture accessibility tree
4. browser_take_screenshot: filename="issue-XX-desktop.png"
5. Verify:
   - Layout renders correctly
   - Styling matches expectations
   - Interactive elements work
   - No console errors
```

#### Mobile Verification (402x874 - iPhone 16 Pro)
```
1. browser_resize: width=402, height=874
2. browser_navigate: http://localhost:3007
3. browser_snapshot: Capture accessibility tree
4. browser_take_screenshot: filename="issue-XX-mobile.png"
5. Verify:
   - Responsive layout works
   - Touch targets are adequate
   - PWA appearance is correct
   - No layout overflow issues
```

### Step 5: Push Changes

```bash
git add .
git commit -m "feat: implement issue #XX - [brief description]

Fixes #XX"
git push -u origin HEAD  # For feature branches
# OR
git push  # For main branch
```

### Step 6: Create Awaiting-Approval Sentinel

Create: `claudedocs/issue-XX-awaiting-approval.md`

```markdown
# Issue #XX - Awaiting Approval

## Context
- Issue: #XX
- Title: [Issue title from GitHub]
- Branch: [branch name or "main"]
- Complexity: [low/medium/high]

## Implementation Summary
[2-3 sentences describing what was implemented]

## Files Modified
- `path/to/file1.ts:10-25` - [what changed]
- `path/to/file2.tsx:50-75` - [what changed]

## Build Verification
- Typecheck: [PASS/FAIL]
- Build: [PASS/FAIL]

## Playwright Verification
- Desktop (1280x800): [PASS/FAIL/N/A]
- Mobile (402x874): [PASS/FAIL/N/A]
- Console Errors: [None / description]
- Screenshots: [paths to screenshots if taken]

## Server Restart Required
[Yes/No]

[If Yes:]
Deploying this change will restart the HAPImatic server and disconnect
all active Claude Code sessions running through HAPImatic.

## Awaiting
User manual testing and approval to proceed with code review and closing workflow.

## Testing Instructions
[Specific steps for user to manually verify the change]
1. [Step 1]
2. [Step 2]
3. [Expected result]
```

### Step 7: HARD STOP - User Testing and Approval

Present to user:
1. Summary of implementation completed
2. Build and Playwright verification results
3. Whether server restart is required
4. Testing instructions
5. Ask: "Please test the changes and confirm they work as expected."

## REQUIRED OUTPUT FORMAT

```
## Phase 2 Implementation Complete

### Changes Made
[Summary of implementation]

### Files Modified
[List with line ranges]

### Verification Results
- Typecheck: [PASS/FAIL]
- Build: [PASS/FAIL]
- Playwright Desktop: [PASS/FAIL/N/A]
- Playwright Mobile: [PASS/FAIL/N/A]

### Server Restart Required
[Yes/No]

### Testing Instructions
[How to test]

### Awaiting User Approval
Please test the changes. Reply with "approved" or "LGTM" to proceed with
code review and closing, or provide feedback for adjustments.
```

## PROHIBITED ACTIONS
- Proceeding to code review without user approval
- Creating PRs (issue-closer responsibility)
- Merging anything (issue-closer responsibility)
- Closing issues (issue-closer responsibility)
- Deploying/restarting server without explicit approval

## PATCH MODE

If user provides feedback instead of approval:

1. Acknowledge the feedback
2. Make targeted changes (only what was requested)
3. Re-run typecheck and build
4. Re-run Playwright verification if UI affected
5. Update sentinel file with patch history
6. Return to HARD STOP for re-approval

### Patch History Format (add to sentinel)
```markdown
## Patch History

### Patch 1 - [timestamp]
- **Feedback**: [user's feedback]
- **Changes**: [what was changed]
- **Re-verification**: Typecheck [P/F], Build [P/F], Playwright [P/F/N/A]
```
