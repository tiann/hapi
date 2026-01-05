# HAPImatic Claude Code Configuration

This directory contains Claude Code agent definitions, hooks, and templates for the GitHub issue workflow.

## Setup

To enable the issue workflow hooks, copy the template settings file:

```bash
cp .claude/settings.template.json .claude/settings.local.json
```

The hooks will then automatically detect natural language commands and trigger the appropriate agents.

## Workflow Overview

### Agents

| Agent | Purpose | Trigger Phrases |
|-------|---------|-----------------|
| **issue-creator** | Creates GitHub issues | "create issue for...", "track this as an issue" |
| **issue-worker** | Implements issues (analysis → implementation) | "fix issue #X", "work on #42" |
| **issue-closer** | Code review, PR, merge, close | "LGTM", "approved", "ship it" |

### Workflow Flow

```
User: "Create issue for adding dark mode"
           ↓ (issue-detector.py triggers)
    issue-creator → Creates GitHub issue #XX
           ↓
User: "Work on issue #XX"
           ↓ (issue-worker-detector.py triggers)
    issue-worker
      Phase 1: Analysis → HARD GATE (user approval)
      Phase 2: Implementation → HARD GATE (user testing)
           ↓
User: "LGTM" or "Approved"
           ↓ (issue-approval-detector.py triggers)
    issue-closer → Code review, PR, merge, close
```

### HARD GATES

The workflow includes mandatory checkpoints that require explicit user approval:

1. **After Phase 1 (Analysis)**: User must approve the implementation approach
2. **After Phase 2 (Implementation)**: User must manually test and approve changes
3. **Before Deployment**: If server restart is needed, user must approve

### Server Restart Warning

Any operation that would restart the HAPImatic server will prompt for confirmation, as this disconnects all active Claude Code sessions.

## File Structure

```
.claude/
├── agents/
│   ├── issue-creator.md     # Issue creation agent
│   ├── issue-worker.md      # Implementation agent
│   └── issue-closer.md      # Closing workflow agent
├── hooks/
│   ├── issue-detector.py           # Detects issue creation intent
│   ├── issue-worker-detector.py    # Detects issue work intent
│   └── issue-approval-detector.py  # Detects approval intent
├── templates/
│   ├── issue-creator-triage-template.md
│   ├── issue-worker-phase1-template.md
│   ├── issue-worker-phase2-template.md
│   └── issue-closer-template.md
├── settings.template.json   # Template for hook configuration
└── README.md               # This file
```

## Playwright Verification

UI changes are verified using Playwright at two viewports:

- **Desktop**: 1280 x 800
- **Mobile**: 402 x 874 (iPhone 16 Pro)

The Playwright MCP server navigates to `http://localhost:3007` to verify visual and functional changes.

## Customization

To modify the workflow:

1. **Agent behavior**: Edit files in `agents/`
2. **Detection patterns**: Modify regex patterns in `hooks/*.py`
3. **Workflow steps**: Update templates in `templates/`
4. **Permissions**: Edit `settings.local.json` (not committed)
