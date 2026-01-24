# Restart vs Resume: Understanding the Difference

This document explains the difference between how hapi currently implements "restart" versus how Claude CLI's `--resume` flag works, and proposes aligning them.

## Current State: How Hapi's Restart Works (Not Implemented)

### Intent
The current `restartSession` RPC is intended to restart a session that has become inactive (CLI process terminated). However, it's **not yet implemented**.

### Current Implementation
```typescript
// cli/src/claude/registerRestartSessionHandler.ts
rpcHandlerManager.registerHandler('restartSession', async () => {
    throw new Error('Session restart is not yet implemented. This feature requires spawning a new CLI process with the same configuration.')
})
```

### What It Would Need To Do (If Implemented)
1. Take an inactive session (CLI process has terminated)
2. Spawn a new CLI process with the same configuration
3. Somehow "continue" or "resume" the conversation
4. Keep the same session ID in hapi's database

### The Problem
- Hapi tracks sessions by session ID in its database
- When a CLI process terminates, the session becomes inactive
- To "restart" it, hapi would need to:
  - Spawn a new `claude` CLI process
  - Pass the original session ID somehow
  - Continue the conversation where it left off

## How Claude CLI's `--resume` Flag Works

### Overview
The `--resume` flag in Claude CLI allows you to continue a previous conversation, but it creates a **NEW session** with context from the old one.

### Example
```bash
# First session
$ claude 'list files in this directory'
# Creates session: aada10c6-9299-4c45-abc4-91db9c0f935d
# File: ~/.claude/projects/.../aada10c6-9299-4c45-abc4-91db9c0f935d.jsonl

# Resume that session
$ claude --resume aada10c6-9299-4c45-abc4-91db9c0f935d 'what file did we just see?'
# Creates NEW session: 1433467f-ff14-4292-b5b2-2aac77a808f0
# File: ~/.claude/projects/.../1433467f-ff14-4292-b5b2-2aac77a808f0.jsonl
```

### Key Characteristics of `--resume`

1. **Creates a NEW session ID**
   - Original session: `aada10c6-9299-4c45-abc4-91db9c0f935d`
   - Resumed session: `1433467f-ff14-4292-b5b2-2aac77a808f0` (completely different)

2. **Preserves complete conversation history**
   - New session file contains ALL messages from the original session
   - Messages are prefixed at the beginning of the new file
   - Includes a summary line at the very top

3. **Rewrites session IDs in history**
   - All historical messages have their `sessionId` field updated to the NEW session ID
   - Creates a unified session history under the new ID
   - Original file remains unchanged with original session IDs

4. **Maintains full context**
   - Claude successfully maintains full context from previous session
   - Can answer questions about previous interactions
   - Behaves as continuous conversation

5. **Original session remains untouched**
   - Original session file is never modified
   - Serves as historical record
   - Can be resumed again to create yet another new session

### How Hapi Currently Uses `--resume`

Hapi already uses `--resume` when reconnecting to existing sessions:

```typescript
// cli/src/claude/claudeLocal.ts:49-52
if (startFrom && !hasUserSessionControl) {
    // Resume existing session
    args.push('--resume', startFrom);
}
```

This happens when:
- Hapi has a session ID from a previous session
- The CLI process for that session terminated
- User sends a new message to that session
- Hapi spawns a new CLI process with `--resume <session-id>`

**But there's a critical mismatch:**
- Claude CLI creates a **NEW** session ID when using `--resume`
- Hapi expects to keep using the **SAME** session ID
- This creates a session ID conflict!

## The Session ID Conflict

### What Happens Today (When Session Reconnects)

1. User has session `aada10c6` in hapi database (inactive)
2. User sends a message to session `aada10c6`
3. Hapi spawns: `claude --resume aada10c6`
4. Claude creates NEW session `1433467f`
5. Claude sends `SessionStart` hook with new ID `1433467f`
6. **Hapi's behavior here is unknown** - does it:
   - Update the database to use new session ID?
   - Keep using old session ID?
   - Create confusion?

### The Issue with "Restart"

The proposed "restart" feature has the same issue:
1. User clicks "Restart" on inactive session `aada10c6`
2. Hapi spawns: `claude --resume aada10c6`
3. Claude creates NEW session `1433467f`
4. What session ID should hapi use going forward?
   - Old one (`aada10c6`)? But Claude is using new one (`1433467f`)
   - New one (`1433467f`)? But user clicked on old session in UI
   - Both? Creates database complexity

## Proposed Solution: Align Restart with Resume

### Option 1: Accept Claude's New Session ID (Recommended)

**Implementation:**
1. When user clicks "Restart" on inactive session `OLD_ID`:
2. Spawn: `claude --resume OLD_ID`
3. Capture new session ID `NEW_ID` from `SessionStart` hook
4. Update hapi database:
   ```typescript
   // Mark old session as "resumed_into: NEW_ID"
   oldSession.metadata.resumedInto = NEW_ID
   oldSession.active = false

   // Create new session with link back
   newSession.id = NEW_ID
   newSession.metadata.resumedFrom = OLD_ID
   newSession.active = true
   ```
5. UI redirects user from old session to new session
6. User continues in new session with full context

**Benefits:**
- Aligns with how Claude CLI actually works
- Preserves original session as historical record
- Clear session lineage (can trace resume chain)
- No session ID conflicts

**Drawbacks:**
- Session ID changes (but this is how Claude works)
- Need to update UI to show session relationships
- More complex database schema

### Option 2: Keep Same Session ID (More Complex)

**Implementation:**
1. When user clicks "Restart" on session `SESSION_ID`:
2. Spawn: `claude --resume SESSION_ID`
3. Capture new session ID `NEW_ID` from `SessionStart` hook
4. Internally track mapping: `SESSION_ID -> NEW_ID`
5. When new messages arrive with `NEW_ID`, store them under `SESSION_ID`
6. User sees consistent session ID in UI

**Benefits:**
- User sees consistent session ID
- Simpler UI (no session switching)

**Drawbacks:**
- Session ID mismatch between hapi and Claude
- Complex message ID translation
- Confusion when debugging
- Multiple Claude sessions mapped to one hapi session
- What if you resume again? Multiple NEW_IDs for one SESSION_ID

### Option 3: Don't Use `--resume`, Use Conversation Export/Import

**Implementation:**
1. When user clicks "Restart":
2. Export conversation history from old session
3. Start completely new Claude session
4. Use `--append-system-prompt` to inject history summary
5. Continue as new session

**Benefits:**
- Full control over session management
- No session ID conflicts

**Drawbacks:**
- Loses proper conversation context
- Claude's `--resume` is more sophisticated than we can replicate
- More work to implement
- May not preserve context as well

## Recommendation

**Use Option 1: Accept Claude's New Session ID**

This is the cleanest solution because:

1. **Works with Claude's design**, not against it
2. **Preserves session history** as immutable records
3. **Creates clear lineage** of session evolution
4. **Aligns with actual Claude behavior** that hapi already relies on
5. **Simpler implementation** - just track the relationship

### Implementation Steps

1. **Update Session Schema**
   ```typescript
   interface Session {
     id: string
     resumedFrom?: string  // ID of session this resumed from
     resumedInto?: string  // ID of session this was resumed into
     // ... existing fields
   }
   ```

2. **Update Restart Handler**
   ```typescript
   async function restartSession(sessionId: string) {
     const oldSession = getSession(sessionId)
     if (!oldSession) throw new Error('Session not found')
     if (oldSession.active) throw new Error('Session is already active')

     // Spawn with --resume
     const newSessionId = await spawnClaudeWithResume(sessionId)

     // Update database
     oldSession.resumedInto = newSessionId
     oldSession.active = false

     // Create or link new session
     const newSession = getOrCreateSession(newSessionId)
     newSession.resumedFrom = sessionId
     newSession.active = true

     return { oldSessionId: sessionId, newSessionId }
   }
   ```

3. **Update UI**
   - When restart succeeds, redirect to new session
   - Show badge/indicator: "Resumed from session ABC"
   - In old session, show: "Continued in session XYZ"
   - Allow navigation between related sessions

4. **Update Error Messages**
   - Inform user that restart creates new session with full context
   - Set expectations correctly

## Summary

| Aspect | Current "Restart" (Not Implemented) | Claude `--resume` | Proposed Aligned Restart |
|--------|-------------------------------------|-------------------|--------------------------|
| Session ID | Keep same ID | Creates NEW ID | Accept new ID, track relationship |
| Context | Full context | Full context | Full context |
| Original Session | Keep using it | Preserved as historical record | Marked as resumed, preserved |
| CLI Process | Would need to spawn | Spawns new process | Spawns new process with `--resume` |
| Database | Single session entry | N/A | Two linked session entries |
| User Experience | Continues in same session | New session, full context | Redirects to new session with context |
| Implementation | Complex, fights Claude | Simple, works with Claude | Simple, works with Claude |

**Bottom Line:** Hapi's "restart" should embrace Claude's `--resume` behavior by accepting the new session ID and maintaining the relationship between old and new sessions, rather than trying to keep the same session ID.
