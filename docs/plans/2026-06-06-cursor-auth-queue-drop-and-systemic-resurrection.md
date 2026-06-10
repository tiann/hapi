# Cursor auth-expiry queue drop + systemic session resurrection

Date: 2026-06-06
Affected: every HAPI user who runs the local interactive CLI with Cursor remote
Severity: High (silent message loss, silent session loss)
Status: post-mortem complete; fix proposals drafted; upstream issues to be filed

---

## TL;DR

Two distinct upstream bugs collided on this machine. Both look like "HAPI ate my stuff" and both are systemic, not workspace-local.

| Bug | Class | Where | Fix owner |
|-----|-------|-------|-----------|
| A. Queued user messages dropped on `cursor agent` exit code 1 | silent-error-swallow in queue worker | `cli/src/cursor/cursorLegacyRemoteLauncher.ts` runMainLoop | upstream `tiann/hapi` |
| B. No first-class "Resurrect / Reopen" UI for archived sessions, even when message history is fully intact | missing affordance + archive metadata strips resume token | hub `/api/sessions/:id/archive` + web sessions list | upstream `tiann/hapi` |

PR #799 (ACP migration) is **adjacent but not the root cause** for either bug. The legacy `stream-json` resume path it ships is correctly designed; old sessions with `cursorSessionId` route to `cursorLegacyRemoteLauncher` via `isLegacyCursorSession()` (default branch returns `Boolean(metadata.cursorSessionId)`, so a missing `cursorSessionProtocol` value still goes legacy). #799 made bug B more visible because more people are now in the "legacy session that crashed once" failure mode.

---

## Incident timeline (Bug A — the missed queued messages)

Tail of `~/.hapi/logs/2026-06-05-22-48-40-pid-14974.log`:

```
[17:35:48.038] push msg X — Spawning agent with args: -p "5806aa57 is actually..." --resume 6904d349...
[17:42:02.935] [API] Socket disconnected: transport close
[17:42:03.889] Socket connected successfully
[17:44:38.000] push msg A (queue size: 1)               ← operator's "post-mortem"
[17:47:41.229] [API] Socket disconnected: transport close
[17:47:42.430] Socket connected successfully
[17:48:39.337] push msg B (queue size: 2)               ← operator's "98 inactive"
[17:49:54.176] push msg C (queue size: 3)               ← operator's "PR 799"
[17:50:59.929] Socket disconnected
[17:51:01.038] Socket connected successfully
[17:56:24.600] Collected batch of 3 messages — Spawning agent with args: -p <concat of A+B+C>
[17:56:25.454] agent stderr: Error: Authentication required. Please run 'agent login' first
[17:56:25.476] Agent exited with code 1
[17:56:25.476] Waiting for messages...
                                                          ← 6 minutes of silence
[18:02:32.337] push msg D (operator's "what happened?" follow-up)
[18:02:32.337] Spawning agent — SUCCESS (auth had been re-acquired)
```

What the operator's web UI showed: "Invoke: 17:56:24" for each of msgs A, B, C — i.e. the hub correctly reported they had been handed to the wrapper. There was no UI surface saying "agent exited code 1" or "auth required, please re-login". 850 milliseconds after the "Invoke" event the messages were on the floor and the system reset to idle.

---

## Bug A — root cause (silent drop on exit code 1)

`cli/src/cursor/cursorLegacyRemoteLauncher.ts` (and the identical mirror in `driver/cli/src/cursor/cursorLegacyRemoteLauncher.ts`), `runMainLoop`:

```typescript
const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);  // ← pops from queue
// ... build args ...
try {
    const exitCode = await this.runAgentProcess(args, session.path, onEvent);

    if (exitCode !== 0 && exitCode !== null) {
        logger.debug(`[cursor-remote] Agent exited with code ${exitCode}`);            // ← debug log
        messageBuffer.addMessage(`Agent exited with code ${exitCode}`, 'status');      // ← local ring buffer
    }
} catch (error) {
    // only fires on spawn error (ENOENT etc.), not on non-zero exit
} finally {
    session.onThinkingChange(false);
    if (session.queue.size() === 0 && !this.shouldExit) {
        sendReady();                                                                     // ← UI: "idle, ready for next"
    }
}
```

Failure mode: when `agent` exits with any non-zero code (auth expiry → 1; quota → 1; bad token → 1; permissions → 1; etc.), the message that was just popped off the queue is gone. The wrapper:

1. Doesn't requeue the user message
2. Doesn't move it to a dead-letter store
3. Doesn't tell the hub "delivery failed; suspend this session"
4. Doesn't surface the stderr (which contains the actual cause) to the web UI
5. Cheerfully emits `ready` and waits for the next push

Bug class: **silent drop on transient subprocess failure**. Classic queue-worker anti-pattern. The same shape would manifest for any other recoverable `agent` exit-1 (rate limit, network blip, missing model).

---

## Bug B — root cause (no systemic unarchive)

Two compounding things:

1. **Archive strips resume affordance.** When the runner records `archiveReason: "Session crashed"` or `archiveReason: "Local launch failed"`, the web UI hides the session under "inactive" with no explicit "reopen" affordance. The transcript stays in the DB; the `cursorSessionId` stays in metadata in most cases; but the operator has no path back to it except `POST /api/sessions/:id/resume` with hand-crafted JSON.
2. **Crashed-while-resuming wipes `cursorSessionId` on some paths.** The 5806aa57 / 74216b80 incident earlier today required us to re-patch `metadata.cursorSessionId` and `metadata.cursorSessionProtocol = 'stream-json'` by hand in sqlite before the wrapper could route correctly. This is the "archive strips the resume token" failure mode — different from Bug A, but stacks with it.

Current session distribution on this machine (DB):

```
lifecycleState=archived: 92    archiveReason=User terminated     87  ← intentional
                               archiveReason=Session crashed       4  ← bug victims
                               archiveReason=Local launch failed   1  ← bug victims
                               archiveReason=NULL                   7  ← pre-metadata (unknown)
lifecycleState=running:   6
lifecycleState=NULL:      1
```

By protocol metadata:

```
cursorSessionProtocol=NULL    + has cursorSessionId  → 66    ← resurrectable as legacy
cursorSessionProtocol=NULL    + no cursorSessionId   → 31    ← needs disk-search for chat UUID
cursorSessionProtocol=stream-json + has cursorSessionId → 2  ← my session + scratchlist (patched today)
```

So of the 99 sessions, **at least 68 are mechanically resurrectable in one click** if HAPI exposes the right button. Another ~31 need a disk-side discovery pass (`hapi-resurrect-session.sh --search-cursor` does this today) before they're resurrectable. The 4 "Session crashed" + 1 "Local launch failed" are the silent victims and the immediate motivation.

---

## Is this a PR #799 regression?

Short answer: **no for routing, partially yes for visibility.**

PR #799 ships `resolveCursorRemoteProtocol(metadata)` which calls `isLegacyCursorSession()`:

```typescript
export function isLegacyCursorSession(metadata: Metadata | null | undefined): boolean {
    if (metadata?.flavor !== 'cursor') return false;
    if (metadata.cursorSessionProtocol === 'acp') return false;
    if (metadata.cursorSessionProtocol === 'stream-json') return Boolean(metadata.cursorSessionId);
    return Boolean(metadata.cursorSessionId);                  // ← default: any cursorSessionId → legacy
}
```

This is the correct fallback. Any pre-#799 session in any HAPI user's DB that has a `cursorSessionId` (~all of them) will route to `cursorLegacyRemoteLauncher` automatically. That's what the PR body promised ("Legacy resume only when metadata says so: existing `cursorSessionId` without `acp` keeps `cursorLegacyRemoteLauncher`"), and that's what the code does.

What #799 didn't introduce but didn't fix either:

- The auth-error-silent-drop in `cursorLegacyRemoteLauncher` (Bug A above) - present before #799, still present after
- The lack of an unarchive UI affordance (Bug B above) - present before #799

What our fork has on top (won't change the upstream story, but explains why our resurrection works today):

- `driver/cli/src/cursor/cursorRemoteLauncher.ts` — try/catch fallback from ACP → legacy on `session/load is not supported` errors. This is defense-in-depth in case metadata routing is wrong; not needed for the default path.

---

## Proposed remediation

### Upstream fix A (priority 1) — don't drop messages on transient subprocess failure

In `cli/src/cursor/cursorLegacyRemoteLauncher.ts` runMainLoop:

```typescript
const popped = await session.queue.waitForMessagesAndGetAsString(waitSignal);
if (!popped) { /* ... */ }
const { message, mode } = popped;

let stderrCapture = '';                                                       // NEW

try {
    const exitCode = await this.runAgentProcess(args, session.path, onEvent, (chunk) => {
        stderrCapture += chunk;                                               // NEW: pass-through stderr
    });

    if (exitCode === 0 || exitCode === null) {
        // success or abort
    } else if (isTransientAgentError(exitCode, stderrCapture)) {              // NEW
        logger.warn('[cursor-remote] transient agent failure, requeuing user message', { exitCode, stderr: stderrCapture });
        session.queue.unshift(message, mode);                                 // NEW: requeue at front
        session.sendSessionEvent({
            type: 'message',
            severity: 'error',
            message: friendlyTransientMessage(exitCode, stderrCapture)        // NEW: surface to web UI
        });
        await sleep(2_000);                                                   // NEW: backoff
    } else {
        // non-transient failure (real crash); surface but don't requeue
        session.sendSessionEvent({
            type: 'message',
            severity: 'error',
            message: `Agent exited (${exitCode}): ${truncate(stderrCapture, 400)}`
        });
    }
} catch (error) { /* spawn error path */ }
```

Plus a small helper that recognises the known transient patterns (auth, rate-limit, network):

```typescript
function isTransientAgentError(exitCode: number, stderr: string): boolean {
    return /Authentication required|please run 'agent login'|rate limit|network|ETIMEDOUT|ECONNRESET/i.test(stderr);
}
```

This is the minimal-surface fix. It keeps the message, surfaces the error, and lets the operator re-login or wait without losing intent.

### Upstream fix B (priority 1) — first-class "Reopen session" affordance

Web UI inactive-sessions list gets a per-row "Reopen" button. Hub adds `POST /api/sessions/:id/reopen` which:

1. If `metadata.cursorSessionId` is present: clear `lifecycleState='archived'` and `archiveReason` / `archivedBy`; set `cursorSessionProtocol='stream-json'` if absent and the session predates ACP; POST internal `/api/sessions/:id/resume`.
2. If `metadata.cursorSessionId` is absent: trigger a server-side discovery sweep (matches workspace path + spawn time against `~/.cursor/chats/<md5(path)>/<uuid>/store.db` mtime) and offer the operator a 1-of-N pick if more than one chat is plausible.
3. Idempotent. Same button works for "User terminated" (operator changes their mind), "Session crashed" (bug victim), and "Local launch failed" (config fix later).

Acceptance: every session in the operator's "98 inactive" list, regardless of `archiveReason`, has exactly one button that brings it back into "running" with full transcript intact.

This is `hapi-resurrect-session.sh` promoted into the hub, with disk-search heuristic borrowed from the script's existing logic. The script becomes the CLI escape hatch for headless/automation use.

### Fork-side workaround (priority 0 — today, until upstream lands)

Until the upstream fix lands, the operator can re-run:

```bash
hapi-resurrect-session <hapi-session-id>
```

for any session that fell into the trap. The script handles the metadata patch, disk symlink, hub restart, and resume POST in one shot. Playbook: `docs/operator/session-resurrection.md`.

For the auth-drop side, the only mitigation today is "run `agent login` proactively before long sessions". The wrapper does not give us a hook to inject auth refresh.

---

## Why this happened to TWO unrelated sessions today

The earlier incident with `5806aa57` (scratchlist) and `74216b80` (rafflemoviebot) was the **B** flavour: those sessions had been archived (one via `Session crashed`, one via `User terminated` after a runaway), and the only way back was metadata surgery.

Today's incident with my own 3 queued messages was the **A** flavour: cursor-agent auth token expired in a different window than the operator's previous re-login at 17:18:53, and the 17:56:24 spawn ate the queue.

They're both classes of "HAPI silently drops state with no operator-visible signal". Same anti-pattern, different surface area.

---

## Upstream filings (drafts to send when operator approves)

### Issue 1: "Cursor stream-json wrapper silently drops user message when `agent` exits non-zero (auth expiry, rate limit, etc.)"

Body: incident timeline above, suggested patch above, severity High (data loss + silent failure UX), affected versions: 0.20.0 confirmed, likely all earlier 0.x with `cursorLegacyRemoteLauncher` in this shape.

### Issue 2: "No web UI affordance to reopen / unarchive a session; archived sessions with full transcript are effectively lost"

Body: distribution above (92 archived on one operator's machine, 5 of them silent bug victims), proposed API + UI shape above, severity High (resilience), affected: every long-running HAPI install.

### Issue 3 (lower priority): "`cursorSessionId` can be cleared from session metadata on crash-archive, blocking future resume even when chat data is on disk"

Body: 5806aa57 / 74216b80 forensic notes from `docs/operator/session-resurrection.md`. Severity Medium (recoverable via tooling, but recovery requires sqlite + Cursor disk hash knowledge).

---

## What we owe the operator

1. **Today**: this doc + the upstream filings drafted above. Operator approves wording, we post.
2. **This week**: file the upstream issues, link them in `docs/operator/AGENTS.md` so future agents see "known upstream" markers.
3. **This month**: if upstream doesn't move, ship Fix A + Fix B as fork patches on a `fix/cursor-auth-queue-resilience` branch, add to the manifest like we did for `fix/cursor-acp-legacy-fallback`. Same playbook.
4. **Always**: when a session ends up in "Session crashed", the operator gets ONE button in the web UI. Not 30 minutes of agent surgery.
