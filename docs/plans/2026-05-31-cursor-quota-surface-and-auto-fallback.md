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

## Fix 4 - RECONSIDERED 2026-06-08 - see Fix 5-8 below

**Original status: WON'T DO** ("yak-shaving until a Claude/Codex incident demands it"). The original framing was a cross-flavor *stderr classifier* generalising Fix 1, which is genuinely yak-shaving.

**Re-evaluated 2026-06-08** after the operator asked the broader question "show me gauges for quota/budget across installed agents." Research surfaced that:

- **Claude Code** already exposes `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` in the statusline-JSON stream piped via stdin (v2.1+ / v1.2.80+, Pro/Max only). No reverse-engineering needed; this is documented at code.claude.com/docs/en/statusline.
- **Codex** quota surfacing is *already in flight upstream* via [#537](https://github.com/tiann/hapi/pull/537) — open, unmerged, EthanWang. Adds `session.metadata.codexUsage` + a "compact usage ring beside the send button" with context-window/rate-limits/token breakdown.
- **Cursor (Enterprise)** has an official Admin API: `/teams/spend`, `/teams/daily-usage-data`, `/teams/filtered-usage-events`. Polling at hourly cadence is supported.
- **Cursor (Pro/Team)** has *no* official quota API — but a reverse-engineered dashboard API exists (`WorkosCursorSessionToken` cookie auth, `GET /api/usage-summary` + `POST /api/dashboard/get-filtered-usage-events`). Documented by `dmwyatt/cursor-usage` and `kdosiodjinud/cursor-chrome-extension`. Brittle but functional.

The original objection ("each flavor's stderr is a moving target") only applied to the *failure-mode classifier*. The *quota-gauge surface* uses structured data sources that exist today. The framing flips: cross-flavor gauges are tractable, the gauge surface is the work, not classifier yak-shaving.

Fix 4's intent (stderr classifier across flavors) remains WON'T DO; the gauge work below replaces it as the cross-flavor scope.

---

## Fix 5 - DO - Claude rate-limit gauges via statusline JSON

**Approach:** intercept the statusline-JSON stream that Claude Code pipes to its `statusLine.command` every render, extract `rate_limits.{five_hour,seven_day}`, forward to the hub as a typed `agentUsage` patch over SSE, render in the composer.

### Data source

Claude Code (v2.1+) writes a JSON object to the stdin of the configured `statusLine.command` on every render and on `refreshInterval` ticks. Shape relevant to us:

```json
{
  "model": { "display_name": "Claude Sonnet 4.6" },
  "context_window": { "used_percentage": 12.4 },
  "rate_limits": {
    "five_hour":  { "used_percentage": 42, "resets_at": 1742651200 },
    "seven_day":  { "used_percentage": 18, "resets_at": 1743120000 }
  }
}
```

`rate_limits` is **present only for Claude.ai subscribers (Pro/Max)** after the first API response in the session. Each window can be independently absent. Handle missing fields gracefully (`jq -r '.rate_limits.five_hour.used_percentage // empty'` style).

Underlying primary source for Anthropic Workbench / direct-API users is the `anthropic-ratelimit-unified-*` response headers (require `anthropic-beta: oauth-2025-04-20`). Same windows: `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus`. Document this as fallback for non-Claude-Code direct-API setups, but don't implement it for v1 - statusline-JSON covers Claude Code Pro/Max.

### Code changes

| File | Change |
|------|--------|
| `cli/src/claude/claudeStatuslineBridge.ts` (new) | Configure / install a HAPI-managed statusline command that captures stdin JSON, extracts `rate_limits`, forwards via `session.sendAgentUsage(...)`. Idempotent install: detect if user already has a statusline configured and either chain or warn. |
| `cli/src/claude/runClaude.ts` | On session spawn, ensure HAPI statusline bridge is registered for the Claude CLI process |
| `shared/src/types.ts` / `shared/src/schemas.ts` | Add `AgentUsageSchema` discriminated union (see "Unified surface" below) with `flavor: 'claude'` variant carrying `fiveHour`/`sevenDay` `{usedPercentage, resetsAt}` |
| `hub/src/sync/messageService.ts` | Persist latest `agentUsage` on `session.metadata.agentUsage`; broadcast SSE patch |

### Constraints

- HAPI installing a custom statusline must not clobber the operator's own. Either prepend-merge or detect existing config and document the conflict.
- `rate_limits` may be absent for the first N renders of a fresh session (no API responses yet). UI must render "—" rather than 0%.
- Free-tier (no Claude.ai subscription) Claude Code users get **no** `rate_limits` field at all. Graceful no-op; gauge hidden.

### Branch name

`feat/claude-rate-limit-gauges`. Independent of Cursor work above; can ship in parallel.

---

## Fix 6 - DO (mostly) - Codex quota gauges via #537

**Approach:** wait for upstream PR #537 to merge OR adopt its branch into soup; do nothing original. If #537 stalls, fork the branch into a soup layer and carry it locally; offer to help the author land it.

### Status

[tiann/hapi#537](https://github.com/tiann/hapi/pull/537) by EthanWang is OPEN and unmerged as of 2026-06-08. It adds:

- Codex `token_count` event capture (app-server notifications + transcript tailing)
- `session.metadata.codexUsage` storage + SSE patches
- "Compact usage ring beside the send button with popover details for context window, rate limits, and token breakdown"

Branch: `codex/codex-usage-indicator` (head `dsus4wang:codex-usage-indicator`).

### Decision tree

| Upstream status | HAPI action |
|------------------|-------------|
| Merges as-is | Pick up on next `hapi-sync-fork-main`; no soup layer needed |
| Merges with refactor that moves `codexUsage` under `agentUsage` | Re-do soup layer to match new shape |
| Stalls > 4 weeks | Adopt EthanWang's branch as a soup layer; comment on the PR offering to help |
| Closed without merge | Re-implement in our own branch following the same shape, generalised to fit Fix 5's `AgentUsage` schema |

### Files we'd own if forking

EthanWang's PR already touches the right files; if we fork we mirror its diff plus a schema-rename to align with `Fix 5`'s `AgentUsage`. Don't re-architect his work.

### Branch name (only if forking)

`feat/codex-usage-indicator-soup` - explicitly a soup-only fork of his upstream branch. Drop on merge.

---

## Fix 7 - DO - Cursor (Enterprise) quota gauges via Admin API

**Approach:** for operators on Cursor Enterprise plan, add an opt-in Admin API key to HAPI machine config; poll `/teams/spend` + `/teams/daily-usage-data` hourly; emit per-user `agentUsage` patches.

### Data source

Cursor Admin API (Enterprise only):

- `GET https://api.cursor.com/teams/spend` - current billing cycle spend per user, includes `spendCents`, `overallSpendCents`, `hardLimitOverrideDollars`
- `POST /teams/daily-usage-data` - aggregated daily metrics, rate-limited 20 req/min
- `POST /teams/filtered-usage-events` - granular events with per-model token consumption
- `POST /teams/user-spend-limit` - rate-limited 250 req/min, lets us SET caps too (out of scope for v1)

Auth: Basic Auth with admin API key (`-u YOUR_API_KEY:`). Get from cursor.com/dashboard → Settings → Advanced → Admin API Keys (Enterprise admin only).

Cadence: **hourly poll** is the documented best-practice (data aggregated at hourly grain). Don't poll faster.

### Code changes

| File | Change |
|------|--------|
| `hub/src/cursor/adminApiPoller.ts` (new) | Hourly poll of Admin API; map response to `AgentUsage` shape with `flavor: 'cursor'`, `tier: 'enterprise'`; emit per-user SSE patches |
| `~/.hapi/settings.json` schema | Add optional `cursorAdminApiKey` + `cursorTeamId` fields. Document in `docs/operator-local-tooling.md`. |
| `shared/src/schemas.ts` | Add `cursor` variant to `AgentUsageSchema`: `{ flavor: 'cursor', tier: 'enterprise', spendCents, overallSpendCents, spendLimitCents?, billingCycleEnd }` |
| `hub/src/web/routes/usage.ts` (new) | Optional debug endpoint to force-refresh poll |

### Constraints

- Per-user spend in HAPI requires the HAPI user identity to map to a Cursor user (email match). Document this requirement; gauge shows blank for unmatched users.
- 20 req/min per team is generous for one hourly poll. No rate-limit budget concern.
- Admin API key has team-wide read access. Treat as sensitive in HAPI config; never log; never embed in client.

### Branch name

`feat/cursor-enterprise-usage-poller`. Independent of Fix 5 / 6 / 8.

---

## Fix 8 - DO (operator opt-in only) - Cursor (Pro/Team) quota via unofficial dashboard API

**Approach:** for Pro/Team operators (no Admin API access), accept the operator's `WorkosCursorSessionToken` as opt-in config; hit the reverse-engineered dashboard endpoints behind a feature flag; render the same `AgentUsage` shape as Fix 7 with `tier: 'pro'`.

**This is a workaround.** Cursor's dashboard API is undocumented, can break without notice, and there is no SLA. Acceptable as a soup-only fork-layer feature. Probably NOT acceptable upstream (see "Upstream-fitness" updates).

### Data source

Cookie-based session API, reverse-engineered by `dmwyatt/cursor-usage` and others (gist at https://gist.github.com/dmwyatt/1e9359b1862e7cbfe1e754fe4c8db764):

- Auth: `Cookie: WorkosCursorSessionToken=<jwt>` header
- POST endpoints additionally require `Origin: https://cursor.com` (CSRF)
- Endpoints:
  - `GET https://cursor.com/api/usage-summary` - high-level overview
  - `POST https://cursor.com/api/dashboard/get-filtered-usage-events` - paginated event log with model/cost/token breakdown (body `{}` for latest)
  - `GET https://cursor.com/api/usage?user=<id>` - per-user usage

Token extraction: DevTools → Application → Cookies → `https://cursor.com` → `WorkosCursorSessionToken`. The cookie is `httpOnly` so script-side extraction in the browser is not possible; operator copies manually.

Token is a JWT with an `exp` claim. HAPI must check `exp` and surface "token expired - please re-extract" rather than silently 401-looping.

### Code changes

| File | Change |
|------|--------|
| `hub/src/cursor/dashboardApiPoller.ts` (new) | Hourly poll if `cursorDashboardSessionToken` config present; same `AgentUsage` shape as Fix 7 but with `tier: 'pro'` and warning flag `dataSource: 'unofficial'` |
| `~/.hapi/settings.json` schema | Add optional `cursorDashboardSessionToken` field with deprecation/expiry handling. Hard warning in docs: "unofficial endpoint, may break, your token expires" |
| Web UI | Render a small "⚠ unofficial data source" badge on the Cursor gauge when `dataSource: 'unofficial'` is set. Operator knows the data could be stale or wrong. |
| `docs/operator-local-tooling.md` | Document token-extraction steps + risks + rotation guidance |

### Constraints

- **Brittleness:** every Cursor dashboard release could break this. Add a test that runs against a fixture response and warns clearly if schema drift detected; don't crash hub.
- **Token rotation:** JWT exp typically 1-2 weeks. Add a check that decodes the JWT, surfaces `expires_at` to operator, and disables the poller cleanly when expired (no infinite 401 loop).
- **ToS posture:** Cursor's ToS doesn't explicitly forbid reverse-engineering their own dashboard's traffic for personal/operational use, but it's grey. Local-fork only; never propose as upstream.
- **No CI test against live endpoint** - it'd require a real session cookie and would rate-limit / break on Cursor's side.

### Branch name

`feat/cursor-pro-dashboard-usage-poller`. **Soup-only.** Never PR upstream. Carry indefinitely or until Cursor ships a Pro/Team Admin API.

### Risks

- **Cursor changes endpoint:** poller breaks. Mitigation: clear "data source: unofficial" badge; fixture-based regression test; documented "if this breaks, here's how to re-extract."
- **Token leak:** operator's session cookie in HAPI settings file. Treat with same care as any auth token. `~/.hapi/settings.json` is already 0600. Document explicitly.
- **Cursor account lock-out** if Cursor flags the polling as abuse. Mitigation: hourly cadence only (matches docs for the official Admin API), single request per poll, single User-Agent that identifies as HAPI.

---

## Unified surface (Fix 5 + 6 + 7 + 8 land here)

All four data sources converge on one schema in `shared/src/schemas.ts`:

```ts
export const AgentUsageSchema = z.discriminatedUnion('flavor', [
  z.object({
    flavor: z.literal('claude'),
    dataSource: z.literal('statusline-json'),
    fiveHour: z.object({ usedPercentage: z.number(), resetsAt: z.number() }).nullish(),
    sevenDay: z.object({ usedPercentage: z.number(), resetsAt: z.number() }).nullish(),
    updatedAt: z.number(),
  }),
  z.object({
    flavor: z.literal('codex'),
    dataSource: z.literal('token-count-event'),
    // shape from upstream #537; mirror exactly to avoid divergence
    contextWindow: z.object({ used: z.number(), total: z.number() }).optional(),
    rateLimits: z.unknown().optional(),
    tokens: z.unknown().optional(),
    updatedAt: z.number(),
  }),
  z.object({
    flavor: z.literal('cursor'),
    dataSource: z.enum(['admin-api', 'unofficial']),
    tier: z.enum(['enterprise', 'pro', 'team']),
    spendCents: z.number(),
    overallSpendCents: z.number(),
    spendLimitCents: z.number().nullable(),
    billingCycleEnd: z.number(),
    updatedAt: z.number(),
  }),
])
```

Stored on `session.metadata.agentUsage`; SSE-patched. Web composer renders flavor-appropriate gauge (Claude: two arcs for 5h/7d; Codex: ring per #537; Cursor: bar + dollars-spent label with optional "⚠ unofficial" badge).

`web/src/components/AssistantChat/AgentUsageGauge.tsx` (new) — single component, discriminates on `flavor`, delegates to `ClaudeGauge` / `CodexGauge` / `CursorGauge` subcomponents.

---

## Updated Upstream-fitness

| Fix | Local-only or upstream-PR? | Notes |
|-----|----------------------------|-------|
| **Fix 1-3** (above) | As previously documented | Cursor stderr surfacing + picker UX |
| **Fix 5** (Claude statusline gauges) | **Strong upstream candidate.** Benefits every Claude-flavor HAPI user. Small additive schema; data source is documented Anthropic API. PR-worthy. |
| **Fix 6** (Codex gauges) | **Already upstream (#537)** — just wait or help land |
| **Fix 7** (Cursor Enterprise gauges) | **Upstream candidate** if maintainer accepts Enterprise-only feature behind a config flag. Likely yes (additive, no impact on Pro users). |
| **Fix 8** (Cursor Pro dashboard scrape) | **NEVER upstream.** Unofficial endpoint, brittle, ToS-grey. Soup-only carry. Mention in upstream issue body for context but propose the *renderer + schema* upstream; the data source is operator-private. |

Updated default plan: ship Fix 5 + Fix 7 + Fix 8 as soup branches; Fix 5 + Fix 7 are upstream PR candidates; Fix 6 we wait on or fork; Fix 8 stays local indefinitely.

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
- Fix 9 merged into soup stack as `feat/cursor-detect-inline-model-errors`; tests against fixture stream-events green.
- Optional: open upstream PR drafts for Fix 1, Fix 3, and Fix 9 if maintainer signals interest; do not block local merge on either.

---

## Fix 9 - DO (HIGH PRIORITY) - Detect inline `T: [...]` / `T: Connection stalled` model errors that DON'T crash the agent

**Status:** Not yet implemented. **Adds a failure mode the original Fix 1 missed.**

### Why this is separate from Fix 1

Fix 1 catches the case where Cursor agent **exits 1** with quota stderr ("out of usage / Switch to Auto / increase your limit"). That is the v1 crash mode.

There is a **second, more dangerous mode** observed repeatedly across 2026-06-08, -09, -10:

- The cursor-agent process **stays alive**.
- It emits a normal `agent/message` event whose **text starts with `Error: T: ...`** — these are upstream-model errors leaking into the assistant stream.
- It **then emits a `ready` event** as if the turn ended cleanly.
- `agentState` does not record the failure.
- `messageBuffer` shows the `Error: T: ...` line as a regular assistant message, mixed in with the agent's prior text.

If the prior assistant message claimed completion ("All done", "Done", "Committed", "Successfully ..."), the operator scrolls past, sees the green ready dot, and walks away thinking work is deployed. **The actual tool call (e.g. `Edit File`, `git push`) was mid-flight and never completed.**

### Evidence

Live samples on operator's machine 2026-06-08 → 2026-06-10:

| Session | Error text (verbatim from `agent/message`) | Provider | Mid-flight tool when it died |
|---------|---------------------------------------------|----------|------------------------------|
| `26a4a7ba` android watch | `Error: T: [resource_exhausted] Error` | Bedrock-routed Claude (`toolu_bdrk_*`) | n/a (idle) |
| `fc8aa274` valutwarden | `Error: T: [resource_exhausted] Error` (x2) | Bedrock | n/a (idle) |
| `adee1ba4` enophone & DJ | `Error: T: [canceled] http/2 stream closed with error code CANCEL (0x8)` | Bedrock | mid-`git status` reasoning |
| `977dbb2b` coolify | `Error: T: Connection stalled` | Vertex (`toolu_vrtx_*`) | **mid-`Edit File` for LOGBOOK, after agent said "All done"** |

Also seen in stream-json mode (Gemini sessions):

- `dac86c84` windows installer: `"Gemini prompt failed: Failed to generate content: The input token count exceeds the maximum number of tokens allowed 1048576."`
- `dac86c84` windows installer: `"Gemini prompt failed: You have exhausted your capacity on this model."`
- `e576d070` hapi windows install (fresh 3-message session, account quota): same final text.

These are upstream model errors leaking into the assistant message stream. cursor-agent emits them as ordinary text events because that is how Cursor's CLI surfaces backend-side gRPC errors to its TUI users — fine for an interactive terminal, hostile for a headless runner that persists every assistant message verbatim.

### Goals

1. **Detect** all known upstream-error patterns at the message-event boundary, before persisting and before the `ready` event is treated as success.
2. **Mark the session** with `metadata.lastModelError` so the UI knows the most recent assistant text is suspect.
3. **Surface a banner** the operator cannot miss, even on a phone glance.
4. **Optionally** auto-retry on transient classes; never on context-window or quota classes.
5. **Never silently overwrite** the agent's text — keep the false-completion message visible but visibly demoted.

### Detection patterns

Add a classifier sibling to `classifyCursorStderr` (Fix 1) that operates on **inline assistant-message text**:

```ts
type CursorAgentStreamFailure =
  | { kind: 'resource_exhausted'; raw: string; transient: false }
  | { kind: 'canceled'; raw: string; transient: true }
  | { kind: 'connection_stalled'; raw: string; transient: true }
  | { kind: 'deadline_exceeded'; raw: string; transient: true }
  | { kind: 'unavailable'; raw: string; transient: true }
  | { kind: 'context_window'; raw: string; transient: false; provider: 'gemini' | 'unknown' }
  | { kind: 'capacity_exhausted'; raw: string; transient: false; provider: 'gemini' | 'unknown' }
  | { kind: 'unknown_t_prefix'; raw: string; transient: false };

function classifyCursorAgentMessage(text: string): CursorAgentStreamFailure | null {
  if (!text) return null;
  const trimmed = text.trim();

  // Cursor "T: [...]" pattern — gRPC status leaked to message stream
  const t = trimmed.match(/^Error:\s*T:\s*(\[(?<code>[^\]]+)\]|(?<word>Connection stalled|.+))/i);
  if (t?.groups?.code) {
    const code = t.groups.code.toLowerCase();
    if (code === 'resource_exhausted') return { kind: 'resource_exhausted', raw: trimmed, transient: false };
    if (code === 'canceled') return { kind: 'canceled', raw: trimmed, transient: true };
    if (code === 'deadline_exceeded') return { kind: 'deadline_exceeded', raw: trimmed, transient: true };
    if (code === 'unavailable') return { kind: 'unavailable', raw: trimmed, transient: true };
    return { kind: 'unknown_t_prefix', raw: trimmed, transient: false };
  }
  if (t?.groups?.word) {
    const w = t.groups.word.toLowerCase();
    if (w.startsWith('connection stalled')) return { kind: 'connection_stalled', raw: trimmed, transient: true };
    return { kind: 'unknown_t_prefix', raw: trimmed, transient: false };
  }

  // Gemini-stream patterns
  if (/Gemini prompt failed: Failed to generate content: The input token count exceeds/i.test(trimmed)) {
    return { kind: 'context_window', raw: trimmed, transient: false, provider: 'gemini' };
  }
  if (/Gemini prompt failed: You have exhausted your capacity on this model/i.test(trimmed)) {
    return { kind: 'capacity_exhausted', raw: trimmed, transient: false, provider: 'gemini' };
  }

  return null;
}
```

### Hook point

In the runner's stream-event reception path — **wherever `agent/message` events are received from the cursor-agent subprocess and forwarded to the hub/DB**. Likely sites:

- `cli/src/cursor/cursorRemoteLauncher.ts` — ACP event handler (look for where `data.type === 'message'` events are processed).
- `cli/src/agent/messageProcessor.ts` (if it exists) — generic stream-event normaliser.
- `cli/src/cursor/runCursor.ts` — session loop top-level.

Inside the handler, before `session.appendMessage(...)`:

```ts
if (event.data?.type === 'message' && typeof event.data.message === 'string') {
  const failure = classifyCursorAgentMessage(event.data.message);
  if (failure) {
    // 1. Persist the suspect message AS-IS so the operator sees what cursor-agent claimed.
    //    Do not mutate `event.data.message` — mutating an upstream stream event is a
    //    debugging trap. Mark the session instead.
    await session.appendMessage(event); // existing path

    // 2. Annotate the session.
    const priorAssistantClaimsDone = looksLikeCompletionClaim(getLastAssistantTextBefore(event));
    await session.updateMetadata((meta) => ({
      ...meta,
      lastModelError: {
        kind: failure.kind,
        transient: 'transient' in failure ? failure.transient : false,
        provider: 'provider' in failure ? failure.provider : undefined,
        rawSnippet: failure.raw.slice(0, 400),
        atTs: Date.now(),
        priorAssistantClaimsDone,
      },
    }));

    // 3. Emit a synthetic banner-event the web UI can render distinctly.
    session.sendSessionEvent({
      type: 'modelError',
      kind: failure.kind,
      transient: 'transient' in failure ? failure.transient : false,
      message: humanReadableForKind(failure.kind, failure.raw, priorAssistantClaimsDone),
    });

    // 4. Suppress treating the next `ready` event as a clean turn-complete.
    session.markTurnDegraded(failure.kind);

    // 5. Optional auto-retry — see "Auto-retry policy" below.
    if (session.metadata.cursorAutoRetryOnModelError && shouldAutoRetry(failure)) {
      await scheduleRetry(session, failure);
    }

    return;
  }
}
```

`looksLikeCompletionClaim` is a small heuristic — operator has been bitten by exactly the agent saying "All done", "Done.", "Committed.", "Successfully ...", "Fixed!", followed by a silent stall. Match those leading tokens in the prior assistant text within the same turn.

### Auto-retry policy (default OFF, opt-in via `cursorAutoRetryOnModelError`)

| Kind | Auto-retry? | Strategy |
|------|-------------|----------|
| `connection_stalled` | yes (1x) | Same model, same last user message, 5s backoff |
| `canceled` | yes (1x) | Same model, same last user message, 2s backoff |
| `deadline_exceeded` | yes (1x) | Same model, same last user message, 5s backoff |
| `unavailable` | yes (1x) | Same model, same last user message, 10s backoff |
| `resource_exhausted` | optional (1x) | Switch to `--model auto` (overlap with Fix 2). Only if `cursorAutoFallbackOnQuota === true`. |
| `context_window` | NO | Unrecoverable; surface only. Operator must fork or compact. |
| `capacity_exhausted` (Gemini) | NO | Account quota; surface only. |
| `unknown_t_prefix` | NO | Conservative; surface only until pattern is studied. |

Cap: never more than **one** retry per turn. If the retry also fails with any classified error, mark `lastModelError.retriedAndFailed = true` and stop.

### Web UI surface

`web/src/components/SessionView/ModelErrorBanner.tsx` (new):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚠ MODEL ERROR — connection_stalled (transient)                          │
│                                                                          │
│ The agent said "All done" but its last tool call (Edit File) did not    │
│ complete. The work is likely INCOMPLETE. Verify before trusting this    │
│ session's output.                                                        │
│                                                                          │
│ [Retry last message]   [Dismiss]   [View raw error]                      │
└──────────────────────────────────────────────────────────────────────────┘
```

Banner is **persistent until acknowledged** (clicking Dismiss writes `metadata.lastModelError.acknowledgedAt`). The `ready` indicator next to the session row should switch from green to amber when `lastModelError && !lastModelError.acknowledgedAt`.

If `priorAssistantClaimsDone === true`, banner copy is harsher: "The model claimed completion before failing. **Verify the work is actually done.**"

### Notification surface

Tie into existing `agent-notify` pipeline:

- Append a final `AGENT_NOTIFY_SUMMARY` line with `status: "needs_review"` and `summary` = banner copy.
- The voice/TTS path will read it. Operator on phone hears "session X reported model error after claiming done, verify."

### Files touched

| File | Change |
|------|--------|
| `cli/src/cursor/cursorRemoteLauncher.ts` (or wherever ACP message events are processed) | Add inline classifier; emit synthetic `modelError` event; mark turn degraded |
| `cli/src/cursor/cursorAgentMessageClassifier.ts` (new) | `classifyCursorAgentMessage` + `looksLikeCompletionClaim` + unit tests |
| `cli/src/cursor/cursorAgentMessageClassifier.test.ts` (new) | Fixture set covering every row of Evidence table + benign messages |
| `shared/src/protocol.ts` | Extend `SessionMetadata` with `lastModelError` (typed) and `cursorAutoRetryOnModelError: boolean` |
| `shared/src/events.ts` (or wherever session events are typed) | Add `'modelError'` event type |
| `hub/src/sync/messageService.ts` | Recognise `modelError` events; persist `lastModelError`; broadcast SSE |
| `web/src/components/SessionView/ModelErrorBanner.tsx` (new) | Banner UI |
| `web/src/components/SessionView/SessionRow.tsx` (or list view) | Switch ready dot to **pulsing amber** when `lastModelError` unacknowledged. Static amber is not enough — it must animate (CSS `pulse` / `ping` keyframe) to draw attention from the session list without requiring the operator to be inside the session. Stop pulsing when `acknowledgedAt` is set. |
| `cli/src/agent/turnState.ts` (or wherever ready handling lives) | `markTurnDegraded` so subsequent ready events don't clear the error state |

### Test plan

1. **Classifier unit tests** — every row of Evidence table → expected `kind`. Plus benign messages ("Here's the diff:", "Done.") → returns null.
2. **Integration: stream-replay test** — feed cursor-agent stream events through the message handler, including a sequence ending in `Error: T: Connection stalled` followed by a `ready` event. Assert:
   - The error text persists as an assistant message (visible to operator).
   - `metadata.lastModelError.kind === 'connection_stalled'`.
   - `metadata.lastModelError.priorAssistantClaimsDone === true` when the previous message was "All done. Quick LOGBOOK entry:".
   - A `modelError` session event was emitted.
   - The `ready` event did NOT clear `lastModelError`.
3. **Auto-retry off** — same stream, `cursorAutoRetryOnModelError: false`. Confirm no retry spawned.
4. **Auto-retry on, transient** — `cursorAutoRetryOnModelError: true`, error kind = `connection_stalled`. Confirm exactly ONE retry of the last user message; if the retry classifies as same kind, confirm `retriedAndFailed: true` and no further retry.
5. **Auto-retry on, non-transient** — error kind = `context_window`. Confirm NO retry.
6. **UI banner render** — fixture metadata with `lastModelError` set → banner appears with correct copy; click Dismiss → `acknowledgedAt` set; banner gone.
7. **Cross-flavor isolation** — Claude / Codex flavored sessions never trigger this classifier (it's wired only into the Cursor remote path).

### Branch name

`feat/cursor-detect-inline-model-errors`. Stacks on Fix 1 if it lands first; independent otherwise.

### Risks

- **Cursor changes the leading text.** Pattern is `^Error: T: ...`. If they reformat to `^[ERROR] gRPC: ...` or similar, classifier misses. Mitigation: log all `agent/message` events whose text starts with `Error:` at info level for one release cycle, watch for new patterns, expand classifier.
- **False positive on agent legitimately writing `Error: T: ` in code or docs.** The pattern is anchored at start of message and very specific to the cursor-agent leak shape; collisions extremely unlikely. The conservative classifier returns `unknown_t_prefix` for anything matching `^Error: T:` it doesn't recognise — this becomes a "warn but don't auto-retry" path.
- **Retry storm on a permanently-throttled provider.** Cap is one retry per turn, hard. Confirmed in test #4.
- **Hidden completion-claim heuristics fight Cursor's natural verbiage.** `looksLikeCompletionClaim` is an intentionally narrow regex over the **leading tokens** of the prior message. Tune via fixture set; do not let it grow into NLP.

### Upstream-fitness

**Strong upstream candidate.** Same UX win for every Cursor-flavor HAPI user, regardless of soup. Open as a separate PR distinct from Fix 1's stderr classifier — they target different failure modes and reviewer can take one without the other.

---

## Sibling perf issue: web client session-refetch storm (2026-06-12)

**Status:** PR open upstream, awaiting review. Local triage in place.

While diagnosing model-error visibility, the operator hit a separate but adjacent problem on their box: `hapi-hub.service` was writing ~9.3 GB/day of syslog, ~95% of which was the `GET /api/sessions/<uuid>` access-log line. Root cause is a per-session refetch storm in the web client (TanStack `useSession` hook with no `staleTime`, plus SSE-handler invalidation fallbacks that bypass the cache-patch path).

This is performance, not correctness, but worth tracking as a sibling because it surfaced through the same diagnostic thread.

- **Issue:** [tiann/hapi#884](https://github.com/tiann/hapi/issues/884) - "Performance: web client useSession refetch storm dominates hub access logs"
- **PR:** [tiann/hapi#885](https://github.com/tiann/hapi/pull/885) - `perf(web): suppress useSession refetch storm`
- **Branch:** `feat/web-session-refetch-perf` on `heavygee/hapi`, commit `a0f46ce1`. 4 files, +106/-5.
- **Peer session:** `5fb78b25` (codex flavor, idle post-handoff).
- **Local triage:** `/etc/rsyslog.d/30-hapi-hub-quiet.conf` drops the noise pattern; stops disk bleed. Remove when upstream fix lands locally.
- **Receipts (before, on this box):** 31,944 `GET /api/sessions/<uuid>` requests in a 5-min idle window, 132 distinct UUIDs, ~106 req/sec (~0.8/sec/session).
- **After receipts:** not yet measured - requires soup deploy or upstream merge + soup rebuild.

### Fix shape (as merged in PR #885)

- **Fix A:** export `SESSION_DETAIL_STALE_TIME_MS = 30_000`, set `staleTime` in `useSession`. SSE drives freshness; REST is now cold-start / reconnect-recovery only.
- **Fix B (chosen: observer-count gating):** new exported helper `hasActiveSessionDetailObserver(queryClient, sessionId)` checking `getObserversCount() > 0`. Applied to both `useSSE.ts` invalidation fallback paths (the `!detailPatched` branch AND the `else` branch where `getSessionPatch` returns null). List-summary invalidation kept unchanged.
- **Fix C:** verified N/A. `SessionList.tsx` consumes `SessionSummary` from the bulk `queryKeys.sessions` query, not per-row `useSession`. No N+1.

### Trade-off accepted

There's a bounded staleness window: if an unstructured SSE event fires for a session while its detail page isn't mounted, the suppressed invalidation means the cache entry isn't marked stale. If the user navigates back within `staleTime` (30s), they may see slightly outdated detail data. Acceptable: structured SSE patches still update the cache directly via `setQueryData`, and the next REST refetch fires after staleTime expires.

### Operator-side close-out (post upstream merge OR post soup deploy)

1. Re-sample `journalctl -u hapi-hub.service` over a 5-min idle window; expect ~0 `GET /api/sessions/<uuid>` lines.
2. Remove `/etc/rsyslog.d/30-hapi-hub-quiet.conf` workaround.
3. Restart rsyslog: `sudo systemctl restart rsyslog`.

### Operator framing

> "I should be able to have as many sessions as I wish and it still not produce problematic log growth."

Fleet size should not determine log volume. Per-session detail data already arrives via SSE; the REST refetch was redundant work plus access-log noise.

