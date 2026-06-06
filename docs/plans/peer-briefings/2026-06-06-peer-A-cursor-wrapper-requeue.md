# Peer A briefing - cursor wrapper requeue on transient exit

**Branch:** `fix/cursor-wrapper-requeue-on-transient-exit`
**Worktree:** `~/coding/hapi/worktrees/cursor-wrapper-requeue/`
**Base:** `upstream/main` @ `66ba312`
**Demo topology:** clean (upstream-main only - no fork-soup layering needed)

---

## Parent

- Orchestrator session: `24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1` (Cursor uuid `6904d349-f576-489f-bcd7-972f37f3942a`)
- Operator request: "ship the wrapper fix from the post-mortem so queued messages stop disappearing on transient cursor-agent exit-1 (auth, rate limit, network blip)"

## Intake status (orchestrator completed)

- [x] **1 Code search:** confirmed bug location at `cli/src/cursor/cursorLegacyRemoteLauncher.ts` `runMainLoop` lines 165-179 (and identical mirror in `driver/cli/src/cursor/cursorLegacyRemoteLauncher.ts`). No upstream PR/issue exists yet (issue search returned empty).
- [x] **2 Upstream search:** `gh issue list --repo tiann/hapi --search 'authentication required queued messages lost cursor agent silent'` → empty. `gh issue list --repo tiann/hapi --search 'MessageQueue2 dropped lost message exit code'` → empty. **No prior upstream coverage; you file the issue first.**
- [x] **3 Playback:** operator confirmed on 2026-06-06 18:51 BST ("you can go ahead with those issues … give me several textbook by the book PRs")
- [ ] **4 Issue:** **YOU FILE THIS FIRST** — see "Step 1" below
- [ ] **5 Demo topology:** clean (your worktree is enough; no driver soup needed for this PR)

## Your assignment (feature peer)

**Own:** issue filing → implementation → tests → fork-stage cold-review PR → upstream PR → babysit until merged or operator dismisses.
**Do NOT redo:** worktree creation, branch creation, code search (orchestrator did all three).

---

## The bug, exactly

`cli/src/cursor/cursorLegacyRemoteLauncher.ts` `CursorRemoteLauncher.runMainLoop` (and the mirror under `driver/cli/src/cursor/`):

```typescript
const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);  // pops from queue
// ... build args ...
try {
    const exitCode = await this.runAgentProcess(args, session.path, onEvent);
    if (exitCode !== 0 && exitCode !== null) {
        logger.debug(`[cursor-remote] Agent exited with code ${exitCode}`);            // debug log only
        messageBuffer.addMessage(`Agent exited with code ${exitCode}`, 'status');      // local ring buffer, not propagated
    }
} catch (error) {
    // only fires on SPAWN error (ENOENT etc.), NOT on non-zero exit
} finally {
    session.onThinkingChange(false);
    if (session.queue.size() === 0 && !this.shouldExit) {
        sendReady();                                                                     // "idle, ready for next" - lies
    }
}
```

When `agent` exits non-zero (auth expiry, rate limit, network blip), the popped user message is lost:

- not requeued
- not surfaced to web UI
- not flagged to operator
- `ready` is emitted as if a normal turn ended

## The forensic evidence (from operator's local wrapper log on 2026-06-06)

```
[17:35:48] push msg X — spawn agent (operator's "5806aa57 is actually...")
[17:44:38] push msg A (queue size: 1)
[17:48:39] push msg B (queue size: 2)
[17:49:54] push msg C (queue size: 3)
[17:56:24] Collected batch of 3 messages → spawn agent with concat prompt
[17:56:25] agent stderr: Error: Authentication required. Please run 'agent login' first
[17:56:25] Agent exited with code 1
[17:56:25] Waiting for messages...   ← three operator messages silently destroyed
```

Full forensic timeline: `docs/plans/2026-06-06-cursor-auth-queue-drop-and-systemic-resurrection.md` §"Incident timeline".

---

## Step 1 — File the upstream issue FIRST

Use this title and body (literal copy; do NOT paste fork-private paths like `~/coding/hapi/worktrees/` or operator's hostnames):

**Title:** `Cursor stream-json wrapper silently drops user message when 'agent' exits non-zero (auth expiry, rate limit, etc.)`

**Body file:** write to `/tmp/peer-A-issue-body.md` first, then file via `gh issue create -R tiann/hapi --title '...' --body-file /tmp/peer-A-issue-body.md`. Suggested body content:

```markdown
## Summary

`cursorLegacyRemoteLauncher.runMainLoop` (in `cli/src/cursor/`) silently discards the user message it just popped from the message queue whenever the spawned `agent` process exits with any non-zero code. Auth expiry, rate limit, transient network failure all produce exit code 1 and all currently cost the operator the messages they had queued. The wrapper logs the failure at `debug` level only, never surfaces it to the web UI, and emits `ready` as if a normal turn ended.

## Reproduction (forensic capture from a real session)

```
[17:35:48] push msg X — spawn agent
[17:44:38] push msg A (queue size: 1)
[17:48:39] push msg B (queue size: 2)
[17:49:54] push msg C (queue size: 3)
[17:56:24] Collected batch of 3 messages — spawn agent (concat prompt)
[17:56:25] agent stderr: Error: Authentication required. Please run 'agent login' first
[17:56:25] Agent exited with code 1
[17:56:25] Waiting for messages...   ← three user messages silently destroyed
```

User's web UI showed `Invoke: 17:56:24` for each of the three queued messages (hub did invoke them). The 850 ms-later spawn failure was never communicated back. Operator had to manually retype the lost messages to discover what happened.

## Root cause (cli/src/cursor/cursorLegacyRemoteLauncher.ts runMainLoop)

```typescript
const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
// ... spawn ...
try {
    const exitCode = await this.runAgentProcess(args, session.path, onEvent);
    if (exitCode !== 0 && exitCode !== null) {
        logger.debug(`[cursor-remote] Agent exited with code ${exitCode}`);
        messageBuffer.addMessage(`Agent exited with code ${exitCode}`, 'status');
    }
} catch (error) { /* only spawn errors */ }
finally {
    session.onThinkingChange(false);
    if (session.queue.size() === 0 && !this.shouldExit) {
        sendReady();
    }
}
```

The message was popped from the queue before spawn. On non-zero exit nothing puts it back, nothing tells the operator, nothing pauses the queue. Same shape affects any transient subprocess failure (rate limit, ETIMEDOUT, ECONNRESET, missing model). Bug class: silent-error-swallow in queue worker / drop-on-error anti-pattern.

## Suggested fix (in PR)

1. Capture stderr from `runAgentProcess` (currently only logged at debug)
2. Detect transient patterns: `/Authentication required|please run 'agent login'|rate limit|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i`
3. On transient: `queue.unshift(message, mode)` to re-head the message, sleep ~2s, emit `sendSessionEvent({type:'message', severity:'error', message: <human-readable cause>})` so the web UI banners it
4. On non-transient non-zero: still surface the stderr but do NOT requeue (real crash, operator can decide)
5. New unit test in `cli/src/cursor/cursorLegacyRemoteLauncher.test.ts` covering both branches

Happy to open the PR if maintainers prefer that path. Patch ready in `heavygee/hapi#<NN>` (fork PR coming).
```

After filing, **capture the issue number** for the `Closes #N` keyword.

---

## Step 2 — Implement

```bash
cd ~/coding/hapi/worktrees/cursor-wrapper-requeue
# verify base
git log --oneline -1                       # should be 66ba312 (upstream/main HEAD)
git branch --show-current                  # should be fix/cursor-wrapper-requeue-on-transient-exit
```

Files to touch in this branch (worktree starts off `upstream/main`, so it does NOT have the fork's mirror under `driver/cli/`):

- `cli/src/cursor/cursorLegacyRemoteLauncher.ts` — the actual fix
- `cli/src/cursor/cursorLegacyRemoteLauncher.test.ts` — new tests (create if missing; or add to existing file)

Key implementation guidance:

1. **Stderr capture:** extend `runAgentProcess` signature to accept an optional `onStderr` callback OR aggregate stderr into a buffer that's returned alongside the exit code. The minimal change is the latter:

   ```typescript
   private runAgentProcess(
       args: string[],
       cwd: string,
       onEvent: (event: ReturnType<typeof parseCursorEvent> & object) => void
   ): Promise<{ exitCode: number | null; stderr: string }> {
       // ... existing setup ...
       let stderrCapture = '';
       child.stderr?.on('data', (chunk) => {
           const text = chunk.toString();
           stderrCapture += text;
           if (text.trim()) logger.debug('[cursor-remote] agent stderr:', text.trim());
       });
       child.on('exit', (code) => {
           cleanup();
           resolve({ exitCode: code, stderr: stderrCapture });
       });
   }
   ```

2. **Transient detection:**

   ```typescript
   function isTransientAgentError(exitCode: number, stderr: string): boolean {
       if (exitCode === 0) return false;
       return /Authentication required|please run 'agent login'|rate limit|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(stderr);
   }
   ```

3. **Requeue + surface in runMainLoop:**

   ```typescript
   const { exitCode, stderr } = await this.runAgentProcess(args, session.path, onEvent);

   if (exitCode === 0 || exitCode === null) {
       // success or abort (existing path)
   } else if (isTransientAgentError(exitCode, stderr)) {
       logger.warn('[cursor-remote] transient agent failure - requeuing user message', { exitCode, stderr: stderr.slice(0, 400) });
       enqueueCursorUserMessage(session.queue, message, mode);   // re-enqueue
       session.sendSessionEvent({
           type: 'message',
           severity: 'error',
           message: friendlyTransientMessage(exitCode, stderr)
       });
       await new Promise((r) => setTimeout(r, 2_000));            // backoff before retry
   } else {
       // non-transient non-zero (real crash)
       session.sendSessionEvent({
           type: 'message',
           severity: 'error',
           message: `Agent exited (${exitCode}): ${stderr.trim().slice(0, 400) || '(no stderr)'}`
       });
       messageBuffer.addMessage(`Agent exited with code ${exitCode}: ${stderr.trim().slice(0, 200)}`, 'status');
   }
   ```

   Use the existing `enqueueCursorUserMessage` helper from `cli/src/cursor/cursorUserMessageQueue.ts` if it supports re-enqueue; otherwise call `session.queue.push(message, mode)` directly. Verify what MessageQueue2's API offers (`push`, `pushIsolated`, `unshift`, etc.) before choosing.

4. **`friendlyTransientMessage`:**

   ```typescript
   function friendlyTransientMessage(exitCode: number, stderr: string): string {
       if (/Authentication required|please run 'agent login'/i.test(stderr)) {
           return `Cursor authentication expired. Re-run 'agent login' or set CURSOR_API_KEY. Your message is queued and will retry automatically.`;
       }
       if (/rate limit/i.test(stderr)) {
           return `Cursor rate limit hit. Your message is queued and will retry automatically.`;
       }
       return `Cursor agent failed transiently (exit ${exitCode}). Your message is queued and will retry automatically.`;
   }
   ```

5. **Don't add backoff hardcoded forever** — cap retries (e.g. after 5 consecutive transient failures, surface a "manual intervention required" event and stop requeueing the same message to avoid infinite loop).

## Step 3 — Tests

```bash
cd ~/coding/hapi/worktrees/cursor-wrapper-requeue
bun install --frozen-lockfile        # if needed
bun test cli/src/cursor/cursorLegacyRemoteLauncher.test.ts
```

Cover at minimum:

1. **Successful turn:** exit 0 → no requeue, no error event
2. **Transient auth fail:** exit 1 + stderr matches `Authentication required` → message requeued, `severity: 'error'` event fired, `friendlyTransientMessage` content correct
3. **Transient rate-limit:** exit 1 + stderr matches `rate limit` → same behaviour, different friendly message
4. **Non-transient crash:** exit 1 + unrelated stderr (e.g. `Segmentation fault`) → NOT requeued, error event still fired
5. **Retry cap:** 5 transient failures in a row → message removed from queue + "manual intervention" event

Mock `runAgentProcess` (or whatever you refactor it into) rather than spawning a real `agent` subprocess in the unit test.

## Step 4 — Cold-review gate (fork PR FIRST)

This project requires every upstream PR to pass a fork-side bot review BEFORE the upstream PR is opened. See `docs/operator/repo-layout-and-dev-flow.md` §3 and `docs/tooling/pr-review-loop.md`.

```bash
cd ~/coding/hapi/worktrees/cursor-wrapper-requeue
git push -u origin fix/cursor-wrapper-requeue-on-transient-exit
gh pr create --repo heavygee/hapi --base main --head fix/cursor-wrapper-requeue-on-transient-exit \
    --title 'fix(cursor): requeue user message on transient agent exit (auth, rate limit)' \
    --body-file /tmp/peer-A-fork-pr-body.md \
    --draft
```

Wait for `chatgpt-codex-connector[bot]` / `github-actions[bot]` review (`hapi-pr-status <pr>` to check). Address every finding via `hapi-pr-reply` — NEVER via `gh pr comment` (top-level comments are blocked by `pr-before-shell-gates.sh` when there are unresolved threads).

When the bot is clean, operator applies the `cold-review-clean` label. Then close the fork PR (branch stays alive).

## Step 5 — Upstream PR (after cold-review-clean)

```bash
hapi-pr-create \
    --title 'fix(cursor): requeue user message on transient agent exit (auth, rate limit)' \
    --body-file /tmp/peer-A-upstream-pr-body.md
```

The upstream PR body MUST include `Closes tiann/hapi#<issue-number>` (your filed issue from Step 1). `hapi-pr-create` enforces this.

`hapi-pr-create` also runs leak scan (`check-operator-leaks.sh`) so you cannot accidentally include fork-private paths like `docs/operator/`, `docs/plans/`, or operator hostnames in the upstream diff. If it blocks you, do NOT bypass — fix the leak.

## Step 6 — Babysit until merged

After the upstream PR is open:

1. `hapi-pr-watch <upstream-pr-number>` (optional - sets a hook to alert on new comments)
2. On every bot/maintainer review: `hapi-pr-reply <pr> <comment-id> <fix-sha> "<one-line>"` (NEVER `gh pr comment`)
3. Continue iterating until merged OR operator dismisses
4. After merge: `hapi-sync-fork-main` (post-merge hook auto-runs `hapi-branch-audit` and flags your branch as delete-candidate)

## Hooks/policy you MUST respect

- **No stashes.** WIP commit on the branch if interrupted. See `.cursor/rules/no-stash-others-work.mdc`.
- **No top-level PR comments on a PR with unresolved threads.** `pr-before-shell-gates.sh` will block `gh pr comment` against such a PR. Use `hapi-pr-reply` for thread replies.
- **No push when unresolved threads exist on your PR.** Resolve them first, then push.
- **Worktree layout:** never create new worktrees at `~/coding/hapi-<name>/`. Canonical is `~/coding/hapi/worktrees/<name>/`. Yours is already correct.
- **Never edit `~/coding/hapi/driver` by hand.** Driver picks up fork branches via `driver-manifest.yaml` rebuild; do not touch it directly.

## When you're done

Report back to the orchestrator (HAPI session `24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1`) via `hapi-ping-peer`:

```bash
hapi-ping-peer 24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1 "Peer A: fix/cursor-wrapper-requeue-on-transient-exit — upstream issue #<N>, fork PR #<M> cold-review-clean, upstream PR #<K> opened, all tests pass"
```

## Links

- Postmortem (forensic source-of-truth): `docs/plans/2026-06-06-cursor-auth-queue-drop-and-systemic-resurrection.md`
- Procedure: `docs/operator/repo-layout-and-dev-flow.md`, `docs/tooling/pr-review-loop.md`, `docs/tooling/new-feature-intake.md`
- Tooling: `hapi-pr-create`, `hapi-pr-reply`, `hapi-pr-status`, `hapi-pr-watch`, `hapi-ping-peer`
