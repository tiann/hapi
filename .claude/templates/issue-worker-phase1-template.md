# Issue Worker Phase 1: Analysis Template - HAPImatic

## Phase Objective
Understand the issue requirements, explore the codebase, and create an implementation plan for user approval.

## EXACT STEPS (Execute in order)

### Step 1: Fetch Issue Details
```bash
gh issue view ISSUE_NUMBER --repo MattStarfield/hapimatic
```
- Extract: title, description, labels, complexity
- Note any linked issues or references

### Step 2: Read Project Context
Read these files to understand project rules and architecture:
- `/home/matt/projects/hapimatic/CLAUDE.md` - Project-specific Claude instructions
- `/home/matt/projects/hapimatic/README.md` - Project overview and architecture

### Step 3: Identify Affected Workspaces
Based on issue description, determine which workspaces are affected:
- [ ] `cli/` - CLI binary and commands
- [ ] `web/` - React PWA frontend
- [ ] `server/` - Backend server
- [ ] `shared/` - Shared utilities
- [ ] `website/` - Marketing site (rarely)
- [ ] `docs/` - Documentation (rarely)

### Step 4: Codebase Exploration
Use Explore agent or Grep/Glob to:
- Find relevant source files
- Understand existing patterns
- Identify dependencies and imports
- Map out affected components

### Step 5: Assess Server Restart Requirement
Determine if implementation will require server restart:
- Changes to `server/` → YES
- Changes to `cli/` that affect binary → YES
- Changes to `web/` only (static assets, CSS, client-side) → NO

### Step 6: Create Analysis Document
Create: `claudedocs/issue-XX-analysis.md`

```markdown
# Issue #XX Analysis

## Issue Summary
[1-2 sentence summary from GitHub issue]

## Complexity Assessment
- **Complexity Label**: [low/medium/high]
- **Estimated Effort**: [time estimate]
- **Server Restart Required**: [Yes/No]

## Affected Components
- [List of affected files/directories]

## Implementation Approach
[High-level description of how to solve this]

### Approach Details
1. [Step 1]
2. [Step 2]
3. [Step 3]

## Dependencies
- [Any dependencies on other issues or external factors]

## Risks
- [Potential issues or edge cases]

## Testing Strategy
- [ ] Typecheck
- [ ] Build verification
- [ ] Playwright desktop (if UI change)
- [ ] Playwright mobile (if UI change)
- [ ] Manual testing areas
```

### Step 7: HARD GATE - User Approval

Present to user:
1. Summary of issue understanding
2. Proposed implementation approach
3. Affected files/components
4. Whether server restart will be needed
5. Ask: "Do you approve this approach to proceed with implementation?"

## REQUIRED OUTPUT FORMAT

```
## Phase 1 Analysis Complete

### Issue Understanding
[Summary]

### Implementation Plan
[Key steps]

### Affected Components
[List]

### Server Restart Required
[Yes/No - with explanation]

### Awaiting Approval
Please review the analysis and confirm to proceed with implementation.
```

## PROHIBITED ACTIONS
- Making any code changes
- Creating branches
- Editing source files
- Running build commands
- Proceeding to Phase 2 without explicit user approval
