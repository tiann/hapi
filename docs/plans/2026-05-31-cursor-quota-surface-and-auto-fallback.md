# Plan: Surface Cursor quota errors, fix Auto/default confusion, optionally fall back to Auto

**Status:** Ready for HAPI agent to pick up
**Owner:** any soup-aware HAPI agent
**Scope:** local fork (`heavygee/hapi`) - **possibly** upstream-shaped, see "Upstream-fitness" section
**Related:** `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md` (sibling local quality-of-life fix)

---

## Problem

When the Cursor CLI runs out of model usage, `cursor-remote` swallows the error and the HAPI web UI gives the operator zero feedback. Sessions look frozen; poking sends another message that dies the same way; loop continues forever in silence.

### Evidence (2026-05-31 incident, ~16:20-16:25)

Seven HAPI sessions on this machine hit the same Cursor stderr in rapid succession after a soup rebuild:

```
[16:24:31.973] [cursor-remote] agent stderr: S: Increase limits for faster responses
You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.
[16:24:32.120] [cursor-remote] Agent exited with code 1
[16:24:32.121] [MessageQueue2] Waiting for messages...
```

(Same pattern in logs `2026-05-31-16-20-04-pid-60236.log`, `16-20-13-pid-65388`, `16-20-22-pid-4599`, `16-20-33-pid-9800`, `16-20-40-pid-15201`, `16-21-31-pid-39498`, `16-24-27-pid-61840`.)

In every case:

- `agent` child exits with code `1`.
- `cursor-remote` only adds `Agent exited with code 1` to its message buffer (low signal; UI doesn't surface buffer-level statuses).
- HAPI's `agentState` does **not** record the failure.
- `thinking` flips to `false`. UI looks idle. Operator pokes again. Same death.

### Code today

`cli/src/cursor/cursorRemoteLauncher.ts` lines 152-216:

- **Line 211-216 `child.stderr.on('data', ...)`** logs stderr text to debug only. The text is never forwarded to `session.sendAgentMessage`, never set on `agentState`, never visible on the web side.
- **Line 152-155** treats non-zero exit as a generic `Agent exited with code N` status, no error classification.
- **Line 156-160** catches outright spawn failures and surfaces them via `sendSessionEvent`, but a clean exit-1 with quota stderr never enters this path.

So the operator's feedback budget is: a single line in `~/.hapi/logs/...pid-XXXX.log` that they have to know to grep. Unacceptable.

### What "Switch to Auto" means

Cursor CLI hint says: **the currently-selected model is out of quota; the `auto` model has separate quota.** Falling back to `--model auto` typically lets the agent run again at reduced capability.

HAPI today:

- `model: null` in metadata = no `--model` arg passed = Cursor uses last-selected model from local config (often something like `composer-2.5`, **not** `auto`). **Critically: the web UI labels this state "default", but it is not Auto and operator cannot tell the difference.**
- `model: 'composer-2.5'` (or similar) = `--model composer-2.5` passed = same dead model on every retry.

There is no fallback logic anywhere in `cursorRemoteLauncher` or `loop.ts`.

---

## Goals

1. **Operator always knows** when the Cursor CLI dies on quota - in the web UI, in scrollback, optionally in voice/ntfy.
2. **Operator can recover with one click** - either auto-fallback to `--model auto` or a clear UI prompt.
3. **No silent retry with a known-dead model.** Don't spawn `--model composer-2.5` ten times in a row when stderr already said "you can't use that model".

---

## Fix 1 - DO - Detect and surface quota errors

**Approach:** parse stderr for known Cursor quota signatures; emit a structured error into HAPI scrollback and `agentState`.

### Code changes

**File:** `cli/src/cursor/cursorRemoteLauncher.ts`

1. Add a stderr accumulator inside `runAgentProcess` (line 174):

   ```ts
   let stderrBuffer = '';
   child.stderr?.on('data', (chunk) => {
     const text = chunk.toString();
     stderrBuffer += text;
     if (text.trim()) {
       logger.debug('[cursor-remote] agent stderr:', text.trim());
     }
   });
   ```

2. Return both exit code and stderr from `runAgentProcess`. Either widen the resolved value to `{ code, stderr }` or pass the buffer up via a closure on the caller. Prefer the structured return type.

3. Add a classifier helper:

   ```ts
   type CursorAgentFailure =
     | { kind: 'quota_exhausted'; raw: string; suggestModel?: 'auto' }
     | { kind: 'unauthenticated'; raw: string }
     | { kind: 'unknown'; raw: string };

   function classifyCursorStderr(stderr: string): CursorAgentFailure | null {
     if (!stderr.trim()) return null;
     if (/out of usage|Switch to Auto|increase your limit/i.test(stderr)) {
       return { kind: 'quota_exhausted', raw: stderr.trim(), suggestModel: 'auto' };
     }
     if (/not (logged in|authenticated)|sign in/i.test(stderr)) {
       return { kind: 'unauthenticated', raw: stderr.trim() };
     }
     return { kind: 'unknown', raw: stderr.trim() };
   }
   ```

4. In the caller (around line 152), branch on classification:

   ```ts
   if (exitCode !== 0 && exitCode !== null) {
     const failure = classifyCursorStderr(stderr);
     if (failure) {
       const userMessage = failure.kind === 'quota_exhausted'
         ? 'Cursor model quota exhausted. Switch this session model to Auto in the picker, or ask the operator to increase the limit.'
         : failure.kind === 'unauthenticated'
         ? 'Cursor CLI is not authenticated on the runner. Run `agent auth login` on the host.'
         : `Cursor agent exited with code ${exitCode}: ${failure.raw.slice(0, 500)}`;

       session.sendSessionEvent({ type: 'message', message: userMessage });
       messageBuffer.addMessage(userMessage, 'status');

       // Update agentState so future watchdogs / UI badges can see it
       session.updateAgentState((prev) => ({
         ...prev,
         lastError: {
           kind: failure.kind,
           message: userMessage,
           at: Date.now(),
         },
       }));
       continue; // skip the loop's normal "ready" emission
     }
     logger.debug(`[cursor-remote] Agent exited with code ${exitCode}`);
     messageBuffer.addMessage(`Agent exited with code ${exitCode}`, 'status');
   }
   ```

5. Wire `lastError` into `shared/protocol` `AgentState` schema (additive, optional). Web client renders a banner when present.

### Files touched

| File | Change |
|------|--------|
| `cli/src/cursor/cursorRemoteLauncher.ts` | stderr capture + classifier + scrollback emit |
| `cli/src/agent/agentState.ts` (or wherever `AgentState` lives) | add optional `lastError` field |
| `shared/src/protocol.ts` | extend `AgentState` schema |
| `web/src/components/SessionView/...` | render banner when `agentState.lastError.kind === 'quota_exhausted'` |
| `cli/src/cursor/cursorRemoteLauncher.test.ts` (new or extend) | unit test stderr classifier with known fixtures |

### Test plan

1. Fixture-based unit test on `classifyCursorStderr` covering:
   - The exact Cursor message above
   - Variant phrasings (`"You're out of usage"` standalone)
   - Auth failures
   - Unrelated noise -> `unknown`
2. Integration: mock `agent` child that prints quota stderr and exits 1. Confirm:
   - `messageBuffer` gets the human-readable message
   - `session.sendSessionEvent` is called once
   - `agentState.lastError.kind === 'quota_exhausted'`
   - `thinking` flips to `false`
   - No further auto-spawn happens until operator action

### Branch name

`feat/cursor-surface-quota-error`. Single commit, top of soup stack.

---

## Fix 2 - DO - Optional auto-fallback to `--model auto`

**Approach:** opt-in per-session setting that, on `quota_exhausted`, retries the same message **once** with `--model auto` before giving up.

This is **gated by a session metadata flag**, default off. The default behaviour after Fix 1 is "show error and stop"; opt-in adds the retry.

### Code changes

**File:** `cli/src/cursor/cursorRemoteLauncher.ts`

After classification in Fix 1:

```ts
if (failure?.kind === 'quota_exhausted'
    && failure.suggestModel === 'auto'
    && session.metadata.cursorAutoFallbackOnQuota === true
    && !this.alreadyFellBackThisTurn) {
  logger.debug('[cursor-remote] Quota exhausted; retrying with --model auto');
  this.alreadyFellBackThisTurn = true;

  messageBuffer.addMessage(
    'Cursor quota hit on selected model; retrying with Auto.',
    'status',
  );
  session.sendSessionEvent({
    type: 'message',
    message: 'Cursor quota hit; retrying with `--model auto`.',
  });

  const retryArgs = buildAgentArgs({
    message,
    cwd: session.path,
    sessionId: cursorSessionId,
    mode: agentMode,
    model: 'auto',
    yolo,
  });

  const retryResult = await this.runAgentProcess(retryArgs, session.path, onEvent);
  // re-classify retry result; if it also fails, surface error and stop
  ...
}
```

`alreadyFellBackThisTurn` resets each turn (don't loop forever if Auto is also out of quota).

### Schema additions

`shared/src/protocol.ts` `SessionMetadata`:

```ts
cursorAutoFallbackOnQuota?: boolean // default false
```

UI: a toggle in session settings ("Auto-fallback to Auto model on quota exhaustion").

### Test plan

1. Mock first-spawn returns quota stderr exit 1.
2. With `cursorAutoFallbackOnQuota: true` -> confirm second spawn includes `--model auto`, scrollback shows retry note.
3. With flag false -> confirm no retry, behaviour matches Fix 1 alone.
4. Mock both spawns return quota stderr -> confirm only one retry, final state is `quota_exhausted` with informative message.

### Branch name

`feat/cursor-auto-fallback-on-quota`. Stacks on Fix 1.

---

## Fix 3 - DO - Resolve "default" vs "Auto" confusion in the model picker

**Approach:** make Auto a first-class explicit option, rename the unset state, and change the new-session default so operators don't fall into the trap by accident.

### Evidence (2026-05-31 follow-up flip)

When the operator manually batched all 10 active Cursor sessions to `model: 'auto'` after the quota incident:

| Was | Count |
|-----|-------|
| `'composer-2.5'` (named, depleted) | 2 |
| `null` (UI shows "default" - **not** Auto) | **8** |

8 of 10 sessions thought they were on "default" when in fact they were on whatever Cursor CLI's host-side last-selected model happened to be. Every one of those 8 needed an explicit `POST /api/sessions/:id/model { model: 'auto' }` to actually run Auto.

Once flipped, sessions that were silently dying began responding (`thinking: true` returned within seconds for the first one polled).

### Three-part fix

**3a. Make Auto an explicit picker entry, not a hidden default.**

The `GET /api/sessions/:id/cursor-models` endpoint already returns `{ modelId: 'auto', name: 'Auto' }` as the first option. The web UI's Cursor model picker should render this entry with the same prominence as named models, not collapse it under an unset/"default" label.

- File: `web/src/components/SessionView/ModelPicker.tsx` (or whatever the cursor-flavor model picker is named).
- Render the `auto` option with a clear label like `Auto (recommended)` so operators see it as a deliberate choice.
- Keep the option visible whether `session.model === null`, `'auto'`, or a named model.

**3b. Stop labelling `null` as "default" in the UI.**

`session.model === null` does not mean Auto. It means "no `--model` flag is passed; Cursor CLI uses its host-side last-selected model". That is **not** a sensible default and **not** what users expect from "default".

- Rename the UI label for `model === null` from "Default" to something honest, e.g. **"Inherit (host CLI default)"** or **"Cursor CLI default"**, with a subtitle: *"Whatever model the Cursor CLI on the host last selected. Not the same as Auto."*
- Add a hover/info badge on first encounter explaining that operators almost certainly want **Auto**, not Inherit.
- Considered alternative: hide the inherit option entirely. **Don't** - some operators rely on host-side config for paid-tier model assignments. Keep it available, just stop calling it "default".

**3c. New Cursor sessions default to Auto, not null.**

The actual default for newly-created Cursor sessions should be `model: 'auto'`, not `null`.

- File: where Cursor sessions are created (likely `cli/src/cursor/runCursor.ts`, hub-side spawn handler, and/or web "new session" form).
- Change the missing-model branch from "leave null" to "set to `'auto'`".
- Backwards compatibility: existing sessions with `model: null` are untouched (operators can flip via picker if they want).
- Schema: no change needed; `model` is already a free-form string. Just set the default value.

### Files touched

| File | Change |
|------|--------|
| `web/src/components/SessionView/ModelPicker.tsx` (or equivalent) | Promote Auto to first-class entry; rename `null` label to "Inherit (host CLI default)"; add subtitle/info |
| `web/src/i18n/...` (if applicable) | New label strings |
| `cli/src/cursor/runCursor.ts` (or session-creation in hub) | Default `model: 'auto'` on new Cursor sessions |
| Tests covering session creation | Update to expect `'auto'` default; add fixture for picker rendering |

### Test plan

1. **Picker render:** new session, Cursor flavor -> picker shows Auto highlighted; Inherit listed but not as primary option.
2. **New session default:** create Cursor session via web "New" or `hapi cursor` with no `--model` -> session metadata `model === 'auto'`.
3. **Existing session preservation:** session with `model: null` (legacy) -> picker correctly labels it "Inherit (host CLI default)" with the warning subtitle; operator can switch to Auto with one click.
4. **Manual `--model` override still works:** `hapi cursor --model composer-2.5` sets that explicitly; not overridden by the new Auto default.
5. **Cross-flavor unaffected:** Claude/Codex/Gemini pickers behave as before; this is Cursor-specific.

### Branch name

`feat/cursor-picker-auto-first-class`. Stacks on Fix 1 logically (UI banner + picker improvements ship together) but no hard dependency.

### Risks

- **Breaking habituation:** operators who currently click the unlabelled "default" option expecting host-CLI behaviour will get Auto instead under 3c. Mitigation: only changes the *new-session* default; existing sessions keep `null`. Operators who use Inherit deliberately can still pick it explicitly - it's just labelled honestly now.
- **Hub vs web spawn paths:** session-creation defaults live in multiple places (CLI `runCursor`, web spawn route, runner spawn). All three must change consistently or we get split-brain defaults.

---

## Fix 4 - WON'T DO - Cross-flavor quota plumbing

**Status: explicitly out of scope.**

Tempting: generalise the classifier across Claude/Codex/Gemini/Kimi - they all have rate-limit and quota errors with their own phrasings. Build one `AgentFailure` taxonomy in `shared/protocol` and apply per-flavor parsers.

**Why not (now):**

1. Cursor is the active pain point on this machine - other flavors aren't reporting silent failures today.
2. Each flavor's stderr is a moving target; classifier maintenance scales linearly with flavor count.
3. Solving Cursor unblocks the operator; cross-flavor parity is yak-shaving until a Claude/Codex incident demands it.

Revisit only if a non-Cursor flavor produces a similar silent-retry incident. At that point, refactor the classifier into a per-flavor strategy.

---

## Upstream-fitness

| Fix | Local-only or upstream-PR? |
|-----|----------------------------|
| **Fix 1** | **Could go upstream.** Surfacing quota errors benefits every Cursor-flavor HAPI user, not just soup operators. Small diff, additive schema. Reasonable PR if maintainer is receptive. Local-first; PR if asked. |
| **Fix 2** | **Local-leaning.** Auto-fallback is a policy choice; some users may prefer hard failure to silent model swap. Default-off makes it harmless, but keeps it as a soup-stack feature unless upstream wants it. |
| **Fix 3** | **Strong upstream candidate.** "Default means not Auto" is a UX bug for everyone, not just soup operators. Renaming the label and changing the new-session default to Auto is a small, defensible change. Worth a PR. Carry locally first, PR if maintainer is open. |

Default plan: ship all three as soup branches. Offer Fix 1 and Fix 3 as upstream PRs opportunistically; carry Fix 2 indefinitely.

---

## Verification matrix

| Scenario | Fix 1 | Fix 2 (flag on) | Fix 3 | Expected |
|----------|-------|------------------|-------|----------|
| Cursor quota hit, no flag | yes | n/a | yes | Banner + scrollback message; no retry; `thinking: false`; Auto highlighted in picker |
| Cursor quota hit, flag on | yes | yes | yes | Brief retry note; spawn with `--model auto`; if Auto runs, normal turn; if Auto also dies, classified error |
| Cursor auth failure | yes | n/a | n/a | Auth-specific message ("not authenticated; run agent auth login on host") |
| Cursor unknown exit-1 | yes | n/a | n/a | Generic "exit code N: \<stderr snippet\>" message; no retry |
| Cursor success | yes | n/a | yes | No change to current happy path |
| **New Cursor session created** | n/a | n/a | yes | Defaults to `model: 'auto'`, not `null` |
| **Picker render with `model: null`** | n/a | n/a | yes | Labelled "Inherit (host CLI default)" with subtitle warning; Auto offered as recommended switch |
| **Picker render with `model: 'auto'`** | n/a | n/a | yes | Auto shown selected and prominent |
| Other flavors | n/a | n/a | n/a | Untouched (Fix 4 is out of scope) |

---

## Friction mode notes

**Steelman of "just check the logs":** the operator has tail/grep, the quota message is one line per failed spawn, this is how UNIX has worked since 1970. Counter: the web UI is the primary surface for HAPI; the operator runs **dozens** of sessions across worktrees and is on a phone half the time. Log archeology is not a UI.

**Risk of stderr classifier:** Cursor changes the message text upstream. Fix is to keep the regex permissive (`out of usage`, `Switch to Auto`, `increase your limit`) and write a regression test. If the message changes, the test fails loudly during `--verify`, not silently in production.

**Risk of auto-fallback:** the operator may **not** want a degraded model silently picked. That's why Fix 2 is opt-in (default off). The flag lives on the session, so different sessions can have different policies (e.g. PR-watcher: yes auto-fallback; production-critical agent: no, hard-stop and notify).

**Cheapest falsification:** tail logs and look for the exact string. If "out of usage" doesn't appear in any of the 7+ logs flagged today, the diagnosis is wrong and we're chasing the wrong bug. Already verified 2026-05-31; safe to proceed.

---

## Definition of done

- Fix 1 merged into soup stack as `feat/cursor-surface-quota-error`, manifest updated, unit + integration tests green.
- Fix 2 merged as `feat/cursor-auto-fallback-on-quota`, manifest updated, opt-in flag documented in `docs/operator-local-tooling.md`.
- Fix 3 merged as `feat/cursor-picker-auto-first-class`, manifest updated:
  - New Cursor sessions default to `model: 'auto'`.
  - Web picker labels `model: null` as "Inherit (host CLI default)" with explanatory subtitle.
  - Auto rendered as a first-class, recommended option.
- Web UI shows a clear banner when `agentState.lastError.kind === 'quota_exhausted'` with model picker shortcut.
- Verification matrix executed; logs captured under `~/coding/hapi/localdocs/operator/`.
- Fix 4 section remains marked **WON'T DO**.
- Optional: open upstream PR drafts for Fix 1 and Fix 3 if maintainer signals interest; do not block local merge on either.
