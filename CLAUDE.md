# CLAUDE.md

Project-specific instructions for Claude Code when working with HAPImatic.

## Project Overview

HAPImatic is a customized fork of [HAPI](https://github.com/tiann/hapi) with personalized PWA branding (mint green theme) for remote Claude Code access.

See `README.md` for full documentation and `AGENTS.md` for architecture details.

---

## ⚠️ CRITICAL: Server Restart Warning

**STOP and WARN the user before performing ANY operation that would restart the HAPImatic server.**

Restarting the HAPImatic server (port 3007) will **immediately disconnect ALL active HAPI sessions**, including:
- Any Claude Code sessions being controlled remotely via the PWA
- The current session if it's running through HAPImatic itself

### Operations That Require Server Restart

You MUST warn the user before:
- Running `systemctl --user restart hapimatic`
- Running `systemctl --user stop hapimatic`
- Killing hapimatic processes (`pkill hapimatic`)
- Replacing the binary at `~/.local/bin/hapimatic`
- Running `hm update` (which restarts the service)
- Any rebuild + deploy workflow

### Required Warning Format

Before proceeding with any restart operation, display this warning:

```
⚠️  SERVER RESTART REQUIRED

This operation will restart the HAPImatic server and DISCONNECT ALL ACTIVE SESSIONS.

Any Claude Code sessions currently running through HAPImatic will be terminated.
Work in progress in other sessions may be interrupted.

Are you sure you want to proceed? (Consider completing or saving work in other sessions first)
```

**Wait for explicit user confirmation before proceeding.**

### Safe Operations (No Warning Needed)

These do NOT require a restart:
- Code changes without deployment
- `bun run typecheck`, `bun run test`
- Git operations (commit, push, pull)
- Editing source files
- Building without deploying (`bun run build` without copying binary)

---

## Screenshots and Images

**Screenshot Directory**: `/mnt/netshare/img`

When Matt mentions saving a screenshot or references an image for this project, the file will be located in `/mnt/netshare/img`. Use the Read tool to view images from this directory without asking for the full path.

Example: "I saved a screenshot of the error" → Check `/mnt/netshare/img` for recent files.

## Key Customization Files

When merging upstream changes, preserve customizations in these files:
- `web/vite.config.ts` - PWA manifest (name, colors)
- `web/index.html` - Title, meta tags, theme colors
- `web/src/App.tsx` - Branding text
- `web/src/components/InstallPrompt.tsx` - Install prompt text
- `web/src/components/LoginPrompt.tsx` - Login screen branding
- `web/src/sw.ts` - Notification title
- `web/public/*.png` - Custom icons (keep entirely)
- `web/public/icon-source.svg` - Icon source file

## Theme Colors

- Primary: `#5ae6ab` (mint green)
- Background: `#0f1f1a` (dark)

## Development

```bash
bun run dev          # Start dev servers
bun run typecheck    # Type checking
bun run test         # Run tests
bun run build:single-exe  # Build ARM64 binary
```

## Deployment

**Claude CAN and SHOULD deploy autonomously** when the user requests deployment or approves changes that require it. Do NOT ask the user to run these commands manually.

### Deployment Procedure

After building with `bun run build:single-exe`, deploy the new binary:

```bash
# 1. Stop the service
systemctl --user stop hapimatic

# 2. Kill any lingering processes (handles "Text file busy" error)
pkill -9 -f hapimatic; sleep 2

# 3. Copy new binary
cp cli/dist-exe/bun-linux-arm64/hapi ~/.local/bin/hapimatic

# 4. Start service and verify
systemctl --user start hapimatic
systemctl --user status hapimatic --no-pager
```

### Important Notes

- **Always warn user first** about session disconnection (see Server Restart Warning above)
- If `cp` fails with "Text file busy", use `pkill -9 -f hapimatic` to kill lingering processes
- Verify service is running after deployment with `systemctl --user status hapimatic`

---

## 🔴 MANDATORY: Deployment Verification Checklist

**This is NON-NEGOTIABLE. You MUST complete ALL steps. Skipping ANY step is LYING to the user.**

After ANY deployment, you MUST run these verification commands and **explicitly confirm each one in your response**:

### Step 1: Verify Binary Was Actually Copied

```bash
ls -la cli/dist-exe/bun-linux-arm64/hapi ~/.local/bin/hapimatic
```

**REQUIRED CHECK**: Both files must have:
- **Same file size** (byte-for-byte match)
- **Deployed binary timestamp** must be AFTER or EQUAL to built binary

If sizes differ or deployed timestamp is older → **DEPLOYMENT FAILED. Do not proceed.**

### Step 2: Verify Correct Assets Are Being Served

```bash
curl -s http://localhost:3007/ | grep -E "(index-[A-Za-z0-9]+\.js|index-[A-Za-z0-9]+\.css)"
```

**REQUIRED CHECK**: Compare the asset hash in the filename to what's in `web/dist/assets/`. They MUST match.

If hashes don't match → **OLD BUILD IS BEING SERVED. Do not proceed.**

### Step 3: Playwright Visual Verification

1. `mcp__playwright__browser_close` - Close any existing tabs
2. `mcp__playwright__browser_navigate` to `http://localhost:3007`
3. `mcp__playwright__browser_take_screenshot`
4. **Explicitly describe** what you see in the screenshot that confirms your specific changes

### Step 4: Report to User

In your response to the user, you MUST include:
- Binary size comparison (e.g., "Built: 128,133,987 bytes, Deployed: 128,133,987 bytes ✓")
- Asset filename being served (e.g., "Serving index-BNiNERW7.js ✓")
- What specifically you verified in the screenshot

**If you cannot confirm ALL of these, tell the user deployment failed. Do NOT say "ready for testing".**

---

## 🔴 ZERO TOLERANCE: Lazy Verification = Lying

**Looking at a Playwright screenshot and thinking "that looks about right" is NOT verification.**

You MUST:
- Check binary timestamps and sizes with actual commands
- Check asset filenames with actual commands
- Explicitly state what you verified and how

You MUST NOT:
- Assume deployment succeeded because the command didn't error
- Assume the screenshot shows the right version without checking assets
- Tell the user something is "ready" without completing the checklist above

**Violation of this section means you lied to the user. This wastes their time and destroys trust.**

---

## 🔴 MANDATORY: Approval Gate Sentinel System

**PR operations are BLOCKED by a hook when awaiting-approval sentinel files exist.**

This system ensures that context compaction cannot cause Claude to skip user approval gates.

### How It Works

1. **During implementation**: When reaching an approval checkpoint (e.g., after deploying UI changes), create a sentinel file:
   ```
   claudedocs/issue-XX-awaiting-approval.md
   ```

2. **Hook enforcement**: The `.claude/hooks/check-approval-sentinel.sh` hook runs before any PR operation and blocks it if sentinel files exist.

3. **User approval**: User manually tests the changes and explicitly approves.

4. **Gate release**: After approval, delete the sentinel file to allow PR operations.

### Sentinel File Format

Create at: `claudedocs/issue-XX-awaiting-approval.md`

```markdown
# Issue #XX - Awaiting User Approval

## Status: BLOCKING PR OPERATIONS

**Created**: [timestamp]
**Issue**: [issue title]

## What Was Implemented

[Brief description of changes]

## What User Needs to Test

- [ ] [Specific test item 1]
- [ ] [Specific test item 2]

## Files Changed

- `path/to/file1.ts`
- `path/to/file2.tsx`

## Approval Instructions

1. Test the changes on your device
2. Confirm everything works as expected
3. Tell Claude "approved" or "LGTM" to proceed
4. Claude will delete this file and create the PR

---

**DO NOT delete this file manually. Claude will delete it after explicit user approval.**
```

### When to Create Sentinel Files

Create a sentinel file when:
- UI changes are deployed and need visual verification on device
- Behavior changes need user testing before merge
- Any implementation reaches a "user must confirm" checkpoint

### Hook Behavior

The hook at `.claude/hooks/check-approval-sentinel.sh` intercepts:
- `gh pr create` commands
- `gh pr merge` commands
- Any GitHub MCP PR-related tools

If sentinel files exist, the operation is **denied** with a clear message explaining:
- Which sentinel files are blocking
- What the user needs to do
- That Claude cannot bypass this gate

### Why This Exists

Context compaction can lose workflow state. A summary might say "user testing pending" but Claude may not treat it as a hard gate. This physical file system:
- **Survives compaction** - file exists regardless of context
- **Enforces automatically** - hook blocks operations
- **Requires explicit action** - file must be deleted to proceed
- **Documents state** - file contains context about what's pending
