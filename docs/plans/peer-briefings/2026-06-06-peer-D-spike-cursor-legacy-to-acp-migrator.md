# Peer D briefing - SPIKE: legacy stream-json → ACP migrator (cursor sessions)

**Branch:** `spike/cursor-legacy-to-acp-migrator`
**Worktree:** `~/coding/hapi/worktrees/cursor-acp-migrator/`
**Base:** `upstream/main` @ `66ba312`
**Demo topology:** clean
**Mode:** **SPIKE** (research + 1-2 hand experiments + report). Implementation only after operator greenlight on phase-1 report. Do NOT open a PR in phase 1.

---

## Parent

- Orchestrator session: `24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1` (Cursor uuid `6904d349-f576-489f-bcd7-972f37f3942a`)
- Operator request: "I have a lot of sessions here that I would prefer to continue with as first-class ACP citizens. Reliable migrator that auto-runs on upgrade, or operator-driven (per-session UI + bulk CLI). 90+ archived sessions as test fodder."

## Why a SPIKE, not a feature peer

#799 (merged today) migrated NEW Cursor sessions to ACP and left a `cursorLegacyRemoteLauncher` for pre-existing sessions to keep using stream-json indefinitely. It explicitly does NOT provide any migration path; "remove legacy launcher when sessions are migrated or expired" is hand-waved in the follow-up list.

The orchestrator's first-cut taxonomy of "what migration could mean":

| Option | What it does | First-glance verdict |
|---|---|---|
| **True transplant** (move running cursor-agent state from stream-json to ACP in-place) | Requires cursor-agent's ACP `session/load` to accept legacy chat-uuids. Today it rejects them - that's why `fix/cursor-acp-legacy-fallback` exists in our soup. | Blocked at the cursor-agent layer |
| **Replay-migration** (archive legacy session → spawn new ACP session → inject prior transcript as preamble; HAPI links old↔new for UI continuity) | The model behind ACP starts fresh - re-derives everything from the replayed transcript. Continuity is cosmetic, not semantic. | Plausible but expensive (tokens) and lossy (model voice may shift) |
| **Shim-only** (keep legacy launcher, paint UI to look "ACP-class") | This is roughly what `isLegacyCursorSession` does today. | Already exists |
| **Sunset telemetry** (surface "legacy vs ACP" in UI + pre-removal warning) | Lowest cost, highest honesty. Doesn't deliver migration. | Plausible but not the ask |

Your job: stress-test that taxonomy with real experiments, write up findings, recommend a path.

---

## Phase 1 - Research + experiments (your immediate scope)

### Step 1.1 - Confirm the cursor-agent layer

Open questions you MUST answer with real evidence (cite source files/lines or shell-run output):

1. **Does `agent acp` `session/new` accept any initial-context payload?**
   - Try: spawn `agent acp` in a scratch dir, drive `session/new` with a `meta` field containing a transcript blob. Observe whether the agent honours it.
   - Cite: `~/.local/share/cursor-agent/versions/<ver>/index.js` for the ACP server impl (it's bundled JS; you can `grep` it).
2. **Does `agent acp` `session/load` accept legacy chat-uuids today?**
   - Try: take a known legacy chat-uuid from `~/.cursor/chats/<workspace-hash>/<chat-uuid>/store.db`, drive `session/load` against it, capture the rejection error verbatim.
   - This confirms what `fix/cursor-acp-legacy-fallback` works around.
3. **Is there ANY documented `agent` command for converting/exporting/importing a chat?**
   - Check: `agent --help`, `agent chat --help` if exists, `~/.cursor/chats/` README if any.
4. **Are the on-disk stores for legacy vs ACP chats different formats?**
   - Compare: schema of `~/.cursor/chats/<wsh>/<legacy-uuid>/store.db` vs an ACP-created session's store.db. If the schemas are the same and only metadata flags differ, "in-place flip" might be possible.

### Step 1.2 - Manual replay-migration experiment

Pick ONE legacy session from the operator's machine to test (do NOT mutate it; only READ):

```bash
sqlite3 ~/.hapi/hapi.db "
SELECT id, json_extract(metadata,'$.cursorSessionId') AS cid,
       json_extract(metadata,'$.lifecycleState') AS lc,
       json_extract(metadata,'$.archiveReason') AS reason,
       (SELECT count(*) FROM messages WHERE session_id = sessions.id) AS msg_count
FROM sessions
WHERE json_extract(metadata,'$.flavor') = 'cursor'
  AND json_extract(metadata,'$.cursorSessionId') IS NOT NULL
  AND (json_extract(metadata,'$.cursorSessionProtocol') IS NULL
       OR json_extract(metadata,'$.cursorSessionProtocol') = 'stream-json')
ORDER BY msg_count DESC
LIMIT 20;
"
```

Pick a session with ~30-80 messages (enough to test continuity, not so long it's painful to debug). Note the id, msg_count, last user message.

Then do a HAND experiment:

1. Export transcript: pull `messages` for that session, render to a single concatenated text blob (system-prompt-shaped header + chronological turns).
2. Spawn a fresh ACP session in this worktree's HAPI hub (or against the operator's running hub - **operator approval required** before any hub-side write).
3. As the first user turn of the new session, paste the transcript blob with a wrapper like: "I'm resuming a prior conversation. Below is the full prior transcript verbatim. Read it carefully, internalize it, then I will continue with new questions."
4. Then send a follow-up prompt that asks the new session to recall something specific from late in the prior transcript (e.g. "what was my last decision about X?").
5. Judge: did it answer correctly? Did the "voice" / coding style feel continuous? How many tokens did the preamble cost?

Repeat for ONE more session of different shape (e.g. longer, different domain). Two data points minimum.

### Step 1.3 - Quantify the fodder

Read-only audit of the operator's `~/.hapi/hapi.db`:

```bash
sqlite3 ~/.hapi/hapi.db "
SELECT
  CASE
    WHEN json_extract(metadata,'$.cursorSessionProtocol') = 'acp' THEN 'acp'
    WHEN json_extract(metadata,'$.cursorSessionId') IS NOT NULL THEN 'legacy-streamjson'
    ELSE 'no-cursor-id'
  END AS bucket,
  json_extract(metadata,'$.lifecycleState') AS lifecycle,
  count(*) AS n
FROM sessions
WHERE json_extract(metadata,'$.flavor') = 'cursor'
GROUP BY bucket, lifecycle
ORDER BY bucket, lifecycle;
"
```

Report:

- How many legacy-stream-json sessions exist
- Distribution by lifecycle (running / inactive / archived)
- Of those, how many have intact `cursorSessionId` AND intact on-disk `~/.cursor/chats/<wsh>/<chat-uuid>/store.db`
- How many would benefit from migration vs how many are obvious "throw away" candidates (e.g. zero messages, archived years ago, etc.)

### Step 1.4 - Phase 1 deliverable

Write a single markdown report to `docs/plans/2026-06-06-cursor-legacy-to-acp-spike.md` (in the orchestrator mirror, not in this worktree - so it stays fork-private and reaches the operator's docs immediately). Sections:

1. **Cursor-agent layer findings** - what `agent acp` actually accepts; what's blocked
2. **Replay-migration experiment** - 2 hand experiments, with concrete continuity judgments + token-cost numbers
3. **Fodder audit** - how many sessions actually fit "migration would help"
4. **Recommendation** - one of:
   - **(a) Build replay-migrator** - acceptable cosmetic continuity, build a tool; design sketch follows
   - **(b) File upstream RFC against cursor-agent** - true migration needs cursor-side support; here's the proposed surface
   - **(c) Sunset-only** - migration cost > value; surface legacy/ACP in UI + warn before removal; nothing else
5. **Open questions for operator** - anything you need a decision on before phase 2

When the report is written, **ping orchestrator and STOP** - do NOT proceed to phase 2 without operator greenlight.

---

## Hard rules for phase 1

- **READ-ONLY against `~/.hapi/hapi.db`.** Audit queries are fine; `UPDATE` / `DELETE` / `INSERT` are NOT until operator explicitly approves a phase-2 plan.
- **DO NOT mutate any of the 90+ fodder sessions** at the hub level (no archive flip, no metadata patch, no resume kick). The "manual experiment" is a NEW session spawned alongside; the source legacy session stays untouched.
- **Backup `~/.hapi/hapi.db` before any mutation** if phase 2 is eventually greenlit (`cp ~/.hapi/hapi.db ~/.hapi/hapi.db.bak.peer-D-$(date +%s)`).
- **No PR open in phase 1.** This is research; the deliverable is a doc + a recommendation.
- **If you need to spawn an ACP test session against the live hub:** ping orchestrator first with "moving | spawning test ACP session against live hub on <directory> | none". Don't surprise the operator's live state.

---

## Phase 2 - DEFERRED until operator greenlights phase 1 report

The shape of phase 2 depends on phase 1's recommendation. Sketch:

- **(a) Build replay-migrator:**
   - File upstream issue describing the design (cosmetic continuity caveat included)
   - Hub: `POST /api/sessions/:id/migrate-to-acp` → renders transcript → spawns new ACP session → injects preamble → links old↔new via metadata cross-reference (`migratedFrom`, `migratedTo`)
   - Web: button on legacy-session rows
   - CLI: `hapi cursor migrate --all-legacy` for bulk
   - Tests + fork PR + cold-review + upstream PR (same shape as peers A/B/C)
- **(b) Upstream RFC:**
   - File issue on cursor-agent (separate repo) describing required surface
   - File companion HAPI issue describing the consumer-side hooks once cursor-agent ships
   - No HAPI code in this PR
- **(c) Sunset-only:**
   - Smaller scope: add `cursorSessionProtocol` to the inactive-list UI as a badge ("LEGACY" vs "ACP")
   - Add a one-time toast on hub upgrade summarizing legacy session count + sunset expectation
   - Tests + fork PR + upstream PR

---

## Hooks/policy (same as other peers)

- No stashes; WIP commits if interrupted
- Worktree layout canonical (you're already in `~/coding/hapi/worktrees/cursor-acp-migrator/`)
- Never edit `~/coding/hapi/driver/` by hand
- If phase 2 produces a PR: fork-stage cold-review (`gh pr create --repo heavygee/hapi --draft`) → `hapi-pr-reply` for all threads → operator applies `cold-review-clean` → `hapi-pr-create` upstream
- NEVER `gh pr comment` on PRs with unresolved threads

## When you're done with phase 1

```bash
hapi-ping-peer 24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1 "Peer D SPIKE: phase-1 report at docs/plans/2026-06-06-cursor-legacy-to-acp-spike.md - recommendation: (a|b|c). Awaiting operator greenlight for phase 2."
```

If you discover during phase 1 that one of the experiments needs operator input (e.g. permission to spawn a test ACP session against the live hub, or a decision on which fodder session to pick), ping with status `blocked` and the specific question.

## Links

- #799 (the migration PR that didn't include a migrator): https://github.com/tiann/hapi/pull/799
- Our local fix that papers over ACP-rejects-legacy: `docs/operator/session-resurrection.md` + the fork-only soup layer `fix/cursor-acp-legacy-fallback`
- Postmortem context: `docs/plans/2026-06-06-cursor-auth-queue-drop-and-systemic-resurrection.md`
- Procedure: `docs/operator/AGENTS.md`, `docs/tooling/new-feature-intake.md`
