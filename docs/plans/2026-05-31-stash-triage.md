# Stash triage — 2026-05-31

> Read-only / non-destructive triage of the 16 lingering stashes in `~/coding/hapi`. **No `git stash drop`/`pop`/`apply`/`clear` was run. No commits, branch changes, or doc edits to the just-landed policy.** Operator decides disposition.
>
> Triage peer dispatched by orchestrator session `89e3b242` (`agentSessionId=6904d349-f576-489f-bcd7-972f37f3942a`), which was intentionally not messaged.

## TL;DR — actionable counts

| Bucket | Count | Stashes |
|---|---|---|
| `drop` (owner confirmed safe-to-drop)                    | **4** | `@{1}`, `@{4}`, `@{7}`, `@{8}` |
| `keep-for-investigation` (partial owner confirmation)    | **1** | `@{2}` (3 of 7 files confirmed recoverable elsewhere; 4 still unowned) |
| `unknown-owner-ask-operator`                             | **11** | `@{0}`, `@{3}`, `@{5}`, `@{6}`, `@{9}`, `@{10}`, `@{11}`, `@{12}`, `@{13}`, `@{14}`, `@{15}` |
| `apply-and-drop`                                         | **0** | — |

Net for the operator: **5 stashes have an actionable recommendation (4 drop + 1 partial-keep); 11 need operator review** (5 of those land on the orchestrator itself, which we were told to skip).

## Methodology

1. `git stash list` → 16 entries, all authored by `HeavyGee` (no author signal).
2. Per stash: `git stash show --stat stash@{N}` (no patch bodies into context) → file list.
3. Per stash: chose 2–6 distinctive tokens (filenames, plan slugs, branch names, message fragments — avoiding noise like `bun.lock`/`AGENTS.md`) and ran `rg -c --fixed-strings <tok> ~/.cursor/projects/.../agent-transcripts/*.jsonl` summed per transcript to rank candidate sessions. (Run in sandbox so 19 transcripts × ~tens of MB never entered context.)
4. Mapped `agentSessionId → sid + session name + cwd + branch` from `GET /api/sessions` (full map at `/tmp/hapi-sessions-map.json`).
5. Sent triage messages via `POST /api/sessions/<sid>/messages` to **active** sessions only (the route requires `requireActive: true`; inactive sessions return 409).
6. Polled `GET /api/sessions/<sid>/messages?limit=40` filtering `seq > baseline AND role == "agent" AND (data.type == "message" OR content.type == "text")` to find textual replies (filtering out tool-call/event noise).

### API used

- **Auth:** `POST /api/auth` with `{accessToken: "<CLI_API_TOKEN from ~/.hapi/settings.json>"}` → JWT (HS256, 4h, `{uid,ns}`).
- **Send:** `POST /api/sessions/<sid>/messages` body `{text, localId}`, header `authorization: Bearer <jwt>`.
- **Read:** `GET /api/sessions/<sid>/messages?limit=40`.

All 6 sends returned `{"ok":true}` HTTP 200. The endpoint exists, works, and routes the message into the agent's inbox as a `user`/`sentFrom:"webapp"` message that the session sees on its next turn.

## Owner inference table

`hits` is the sum of `rg -c` matches in that session's transcript across all chosen tokens for that stash. Confidence is mine (triage peer's) read on the gap between top and runner-up.

| stash | age | branch | top candidate (sid · session-name) | hits | runner-up | conf | active? | orchestrator? |
|---|---|---|---|---|---|---|---|---|
| @{0} | 4h | feat/voice-selection-all-backends | `599e19c2` Peer #738 Cursor summarize HAPI wiring | 18 | ca718ede (8) | high | yes | no |
| @{1} | 7h | feat/voice-selection-all-backends | `77634369` PR 692 - plugable voice backup | 46 | 9543f7a3 (21) | medium-high | yes | no |
| @{2} | 7h | main | `1afa941b` meta HAPI triage/problems (+ `1362844d` hapi-monitor as alternative) | 5 / 42 | competing | low–med | yes | no |
| @{3} | 7h | main | `89e3b242` orchestrator | 125 | 599e19c2 (19) | high | yes | **yes — skipped** |
| @{4} | 10h | driver/integration | `17022f2c` android watch | 19 | 89e3b242 (3) | high | yes | no |
| @{5} | 10h | main | `8d4f8729` peer agent product (inactive) | 24 | 77634369 (19) | medium | **no** | no |
| @{6} | 10h | main | `45eb9f18` legacy chat attachments (inactive) — close call with 599e19c2 | 19 | 599e19c2 (7) | medium | **no** | no |
| @{7} | 1d | feat/pluggable-voice-backend | `77634369` PR 692 (low — only bun.lock signal) | n/a | — | low | yes | no |
| @{8} | 1d | main | `1479c320` Peer #737 Mermaid lightbox | 148 | 766e8deb (20) | very high | yes | no |
| @{9} | 1d | docs/new-feature-intake-playbook | `89e3b242` orchestrator | 30 | 599e19c2 (13) | high | yes | **yes — skipped** |
| @{10} | 2d | hapi-issue-resume-race-fix | `82a4fe63` meta - PR watcher (inactive); true owner `64a34c7a` #728 peer (inactive) | 5 | 89e3b242 (2) | low | **no** | no |
| @{11} | 3d | main | `89e3b242` orchestrator | 91 | 993adbe1 (23) | high | yes | **yes — skipped** |
| @{12} | 4d | feat/session-list-attention | `b8b43d98` i698 pr699 status indicators (inactive) | 80 | 89e3b242 (15) | medium-high | **no** | no |
| @{13} | 4d | feat/pluggable-voice-backend | `89e3b242` orchestrator | 26 | 993adbe1 (12) | high | yes | **yes — skipped** |
| @{14} | 5d | driver/integration | `89e3b242` orchestrator | 120 | 1479c320 (41) | high | yes | **yes — skipped** |
| @{15} | 7d | main | `b9fe39ab` XR Garden (inactive) or `9543f7a3` eleven labs extraction (inactive) | 31 / 21 | tight | low–med | **no** | no |

Inactive candidates cannot be messaged (the `POST /api/sessions/:id/messages` route uses `requireSessionFromParam(..., {requireActive:true})` and rejects with 409 `Session is inactive`). Five orchestrator-owned stashes were skipped per the spec.

## Recommendation table

| stash | age | branch | owner-guess (final) | confidence | message-sent | reply | recommendation |
|---|---|---|---|---|---|---|---|
| @{0} | 4h | feat/voice-selection-all-backends | 599e19c2 → **disowned**; next candidates ca718ede, 8d4f8729 are inactive | low (after disown) | yes | (c) Not mine — work already committed on `feat/cursor-summarize-738` @ `396a030` | **unknown-owner-ask-operator** |
| @{1} | 7h | feat/voice-selection-all-backends | 77634369 | confirmed | yes | (b) safe to drop — stash is *inverted* vs picker commits `78274dc`/`43a6fb3`/`a36fc61`/`a6c793b`; would delete `voicePickerCatalog.ts` etc. | **drop** |
| @{2} | 7h | main | partial: 3/7 files = `1362844d` hapi-monitor (confirmed recoverable in server-setup `989b4ed`); 1/7 files = `1afa941b` (superseded in tree); 4/7 files = unowned (`hapi-companion-fcm-ping.mjs`, `hapi-patient-stack-restart.sh`, `peer-handoff-queued-sse-758.md`, `2026-05-30-voice-composed-prompt.md`) | partial | yes (both 1afa941b & 1362844d) | hapi-monitor: "(b) safe to drop *for my portion*; ask owners of the other 4 files first" | **keep-for-investigation** |
| @{3} | 7h | main | 89e3b242 orchestrator | high | **no** (skipped) | — | **unknown-owner-ask-operator** (orchestrator owns) |
| @{4} | 10h | driver/integration | 17022f2c android watch | confirmed | yes | (b) safe to drop — `fcmService.ts` byte-identical to driver commit `1352b2c`; `cli/AGENTS.md` is duplicate boilerplate | **drop** |
| @{5} | 10h | main | 8d4f8729 peer agent product **(inactive)** | medium | **no** (inactive) | — | **unknown-owner-ask-operator** |
| @{6} | 10h | main | 45eb9f18 legacy chat attachments **(inactive)** | medium | **no** (inactive) | — | **unknown-owner-ask-operator** |
| @{7} | 1d | feat/pluggable-voice-backend | 77634369 | confirmed (low-conf guess, confirmed by owner) | yes (bundled with @{1}) | (b) safe to drop — stale bun.lock bump `@twsxtd/hapi-win32-x64` 0.18.3→0.18.4 | **drop** |
| @{8} | 1d | main | 1479c320 Peer #737 Mermaid lightbox | confirmed (very high) | yes | (b) safe to drop — lightbox shipped as `a74e018..4584dfe` on PR #741; non-lightbox files in same stash not from this session (caveat noted) | **drop** |
| @{9} | 1d | docs/new-feature-intake-playbook | 89e3b242 orchestrator | high | **no** (skipped) | — | **unknown-owner-ask-operator** (orchestrator owns) |
| @{10} | 2d | hapi-issue-resume-race-fix | true owner 64a34c7a `#728 peer` **(inactive, PR merged)** | low | **no** (inactive) | — | **unknown-owner-ask-operator** |
| @{11} | 3d | main | 89e3b242 orchestrator | high | **no** (skipped) | — | **unknown-owner-ask-operator** (orchestrator owns) |
| @{12} | 4d | feat/session-list-attention | b8b43d98 i698 pr699 status indicators **(inactive)** | medium-high | **no** (inactive) | — | **unknown-owner-ask-operator** |
| @{13} | 4d | feat/pluggable-voice-backend | 89e3b242 orchestrator | high | **no** (skipped) | — | **unknown-owner-ask-operator** (orchestrator owns) |
| @{14} | 5d | driver/integration | 89e3b242 orchestrator | high | **no** (skipped) | — | **unknown-owner-ask-operator** (orchestrator owns) |
| @{15} | 7d | main | b9fe39ab XR Garden / 9543f7a3 eleven labs extraction **(both inactive)** | low–med | **no** (inactive) | — | **unknown-owner-ask-operator** |

## Raw replies (verbatim, agent text only)

### stash@{0} — 599e19c2 (Peer #738 Cursor summarize HAPI wiring) @ seq 471

> (c) Not mine — drop after orchestrator confirms with the actual owner; my Cursor #738 work is committed on `feat/cursor-summarize-738` (`396a030`), no uncommitted CLI surface from me.
>
> `AGENT_NOTIFY_SUMMARY {"version":1,"agent":"peer-cursor-summarize","project":"hapi","status":"done","action":"Confirm stash@{0} not mine; orchestrator may proceed with other-owner disposition","summary":"Disowned stash@{0}; my #738 work is committed on feat/cursor-summarize-738"}`

### stash@{1} + stash@{7} — 77634369 (PR 692 - plugable voice backup) @ seq 711

> Both safe to drop.
>
> 1. **stash@{1}** — **(b) safe to drop.** Stash predates the four picker commits now on `feat/voice-selection-all-backends` (`78274dc`/`43a6fb3`/`a36fc61`/`a6c793b`); diff is inverted (-721/+164) and would *delete* `voicePickerCatalog.ts`, `voicePickerPreferences.ts`, settings/index.tsx wiring, etc. The only adds are the two `docs/plans/*voice-selection*.md` files, both already present on disk in `~/coding/hapi-worktrees/voice-selection-all-backends/docs/plans/` (and fork-private, so won't push).
> 2. **stash@{7}** — **(b) safe to drop.** One-line bun.lock bump for `@twsxtd/hapi-win32-x64` 0.18.3→0.18.4 — local install drift, not feature work; upstream/main rebase already supersedes it.
>
> `AGENT_NOTIFY_SUMMARY {"version":1,"agent":"voice-pr","project":"hapi","status":"done","action":"none","summary":"stash@{1} drop (inverted vs committed picker work); stash@{7} drop (stale bun.lock bump)"}`

### stash@{2} — 1afa941b (meta HAPI triage/problems) @ seq 837 — DISOWNED

> **Not mine.** I never invoked `git stash` in this session, and only **one** of the 7 files in that stash overlaps with anything I touched [`docs/plans/peer-handoff-queued-sse-758.md` — already superseded in tree by `docs/plans/peer-handoff-758-inactive-send.md`]. The whole-file deltas on `scripts/*` (a `health.sh` insertion of 1398 lines is the entire file, not a fix) tell me this is somebody else's bulk recreation — almost certainly the agent that owned `hapi-sessions-health.sh` / plot / FCM ping work earlier today (consistent with `hapi-monitor 1362844d` being your competing candidate). **Recommendation:** re-ask hapi-monitor.

### stash@{2} — 1362844d (hapi-monitor) @ seq 1068 — PARTIAL OWNER

> (b) safe to drop — **for my portion** (`scripts/hapi-sessions-health.sh`, `scripts/hapi-sessions-plot.c`, `scripts/build-hapi-sessions-plot.sh`). Those were swept by `git stash -u` earlier today, recovered + relocated to `~/coding/server-setup/scripts/hapi/`, and committed (latest commit `989b4ed` 23:14, well past the stash snapshot). I don't own the other 4 files in the stash (`scripts/tooling/hapi-companion-fcm-ping.mjs`, `scripts/tooling/hapi-patient-stack-restart.sh`, `docs/plans/peer-handoff-queued-sse-758.md`, `docs/plans/2026-05-30-voice-composed-prompt.md`) - ask their respective owners before dropping the whole stash.
>
> `AGENT_NOTIFY_SUMMARY {"version":1,"agent":"hapi-sessions agent","project":"hapi","status":"done","action":"orchestrator confirms ownership of remaining 4 files in stash@{2} before drop","summary":"My 3 monitor files in stash@{2} are recovered in server-setup - safe to drop. Other 4 files not mine."}`

### stash@{4} — 17022f2c (android watch) @ seq 2182

> (b) safe to drop. The `fcmService.ts` diff in stash@{4} is byte-identical to commit `1352b2c` already on `hapi-driver` (the data-only FCM fix I shipped earlier this session). `cli/AGENTS.md` is just operator-voice boilerplate that duplicates `~/coding/AGENTS.md` and is explicitly excluded from upstream PRs per the operator-fork rule. Nothing unique to recover.
>
> `AGENT_NOTIFY_SUMMARY {"version":1,"agent":"watch-companion agent","project":"hapi-companion","status":"done","action":"Orchestrator 89e3b242 may drop stash@{4}; fcmService.ts diff is byte-identical to driver commit 1352b2c","summary":"Verified stash@{4} is redundant: hub fcm fix already committed on hapi-driver, AGENTS.md is duplicate boilerplate."}`

### stash@{8} — 1479c320 (Peer #737 Mermaid diagram lightbox) @ seq 2271

> (b) safe to drop — lightbox parts are already shipped as commits `a74e018..4584dfe` on `feat/mermaid-lightbox-737` (PR #741); the non-lightbox files in the stash (`hub/.../machines.ts`, `shared/apiTypes.ts`, `routes/sessions/file.tsx` 256-line gut, locales, operator-local doc) are not from this session.
>
> `AGENT_NOTIFY_SUMMARY {"version":1,"agent":"PR babysit agent","project":"hapi","status":"done","action":"orchestrator 89e3b242 may drop stash@{8}","summary":"Lightbox portion of stash@{8} is fully shipped on feat/mermaid-lightbox-737; non-lightbox files in same stash not from this session."}`

> ⚠️ Caveat on @{8}: the lightbox author confirmed *their* portion is shipped but explicitly noted the **other files in the same stash** (`hub/.../machines.ts`, `shared/apiTypes.ts`, `routes/sessions/file.tsx`, locales, operator-local doc) are not theirs. The stash was named `wip pre-upstream-sync` — likely orchestrator wrapping multiple peers' WIP before the upstream sync. Operator: confirm those files are also safely landed before dropping.

## Blockers / caveats

1. **Inactive sessions cannot be messaged.** The `POST /api/sessions/:id/messages` route enforces `requireActive: true`. Stashes whose best owner candidate is inactive (`@{5}` 8d4f8729, `@{6}` 45eb9f18, `@{10}` 82a4fe63/64a34c7a, `@{12}` b8b43d98, `@{15}` b9fe39ab/9543f7a3) cannot be triaged via this channel. Alternatives: operator pings the session manually, or accepts the inferred owner as the disposition source.
2. **Orchestrator-owned stashes were intentionally not messaged** per spec. The orchestrator is the dispatcher and already knows the inventory. Operator should walk them with the orchestrator session: `@{3}`, `@{9}`, `@{11}`, `@{13}`, `@{14}`.
3. **stash@{2} is multi-author**: 3/7 files from hapi-monitor (recoverable in `~/coding/server-setup/scripts/hapi/` @ `989b4ed`), 1/7 from 1afa941b (already superseded in tree), 4/7 still unowned. Cannot recommend a clean `drop` without ownership confirmation on the remaining 4 (`scripts/tooling/hapi-companion-fcm-ping.mjs`, `scripts/tooling/hapi-patient-stack-restart.sh`, `docs/plans/peer-handoff-queued-sse-758.md`, `docs/plans/2026-05-30-voice-composed-prompt.md`).
4. **stash@{0} disowned without forward pointer.** 599e19c2 disowned and the runner-up candidates are inactive. Operator decision needed: drop (since the CLI/runner files in question likely have an analogue in the active CLI/runner refactor lineage) or keep until an offline owner returns.
5. **Branch-name signals can dominate file-content signals.** For low-content stashes (`@{7}`, `@{10}`, `@{12}` — all bun.lock-only), the branch name pulls toward whichever session had the most recent activity *on* that branch. That introduces orchestrator over-weighting; treat low-confidence rows accordingly.
6. **No destructive commands executed.** No `git stash drop/pop/apply/clear`. No `git stash push`. No commits, no branch changes. The 16 stashes are exactly where they were when this peer started.

## Artifacts (gitignored locations, not committed)

- `/tmp/hapi-jwt-stash-triage.txt` — short-lived JWT (4h)
- `/tmp/hapi-sessions-map.json` — sid → name + cwd + branch + agentSessionId map
- `/tmp/stash-files.txt` — per-stash file lists
- `/tmp/stash-triage-msgs.json` — drafted message bodies for the 5 sends
- `/tmp/stash-triage-out/post-<sid8>.txt` — per-send response (`{"ok":true}` HTTP 200)
- `/tmp/stash-triage-baseline.txt` — pre-send seq baseline for reply detection
- `/tmp/stash-triage-replies.json` — final scraped agent replies
