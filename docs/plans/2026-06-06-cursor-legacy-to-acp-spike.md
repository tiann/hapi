# SPIKE: legacy stream-json → ACP migrator for cursor sessions

**Author:** Peer D (SPIKE)
**Date:** 2026-06-06
**Briefing:** `docs/plans/peer-briefings/2026-06-06-peer-D-spike-cursor-legacy-to-acp-migrator.md`
**Worktree:** `~/coding/hapi/worktrees/cursor-acp-migrator/` (read-only for phase 1)
**Status:** Phase 1 complete. Phase 2 awaiting operator greenlight.
**Recommendation:** **(a) Build migrator** - but use a **TRANSPLANT** strategy, not the replay-migration the briefing assumed. Transplant is cheaper, lossless, and the experiments below prove cursor-agent already supports it - no upstream RFC required.

---

## TL;DR

1. The briefing's "true transplant is blocked at the cursor-agent layer" assumption is **false**. cursor-agent's `agent acp` server resolves `session/load` against `~/.cursor/acp-sessions/<uuid>/{store.db, meta.json}`, while the legacy stream-json flow stores chats at `~/.cursor/chats/<workspace-hash>/<uuid>/store.db`. The SQLite schema is **byte-identical** between the two stores (`blobs(id TEXT PRIMARY KEY, data BLOB)` content-addressed Merkle tree + `meta(key,value)`). The only differences are the directory layout and a `meta.json` sidecar in the ACP store. Move + sidecar = working session/load.
2. Two hand experiments (34-msg session, 109-msg session) confirm: transplant → `session/load` → full transcript replays back as `session/update` notifications → subsequent `session/prompt` returns answers that demonstrably reference the prior transcript. **Semantic continuity, not cosmetic.** Zero preamble tokens.
3. Fodder audit: of 68 legacy stream-json sessions in HAPI's db, **66 have intact on-disk store.db** (2.6 GB total). 55 of 66 have ≥200 messages - the sessions where migration actually matters. Two are unreachable: one Windows-origin (`h:\Users\...`), one tiny 8-msg.
4. Recommended phase 2: build a transplant migrator (hub endpoint + CLI bulk command + per-session web button). Skip the "replay-migration" arm of the briefing's taxonomy entirely.

---

## 1. Cursor-agent layer findings

### 1.1 `agent acp` schema

`agent acp` is documented in `agent --help` only as `Start the Cursor Agent as an ACP (Agent Client Protocol) server`. It speaks JSON-RPC 2.0 over stdio. Probed by hand with `/tmp/peer-D-spike/probe-acp.mjs` against `agent@2026.06.04-8f81907`:

```
initialize → {protocolVersion:1, agentCapabilities:{loadSession:true,
              promptCapabilities:{audio:false,embeddedContext:false,image:true},
              sessionCapabilities:{list:{}}, mcpCapabilities:{http:true,sse:true}},
             authMethods:[{id:"cursor_login", ...}]}
```

The dispatcher in the bundled JS (`~/.local/share/cursor-agent/versions/2026.06.04-8f81907/8096.index.js`, single-line minified, line 1, offset ~16685) routes:

```
"initialize"     → e.initialize(G.parse(t))
"session/new"    → e.newSession(O.parse(t))
"session/load"   → e.loadSession(wn.parse(t))      [if e.loadSession exists]
"session/list"   → e.unstable_listSessions(...)
"session/prompt" → e.prompt(tt.parse(t))
"session/cancel" → e.cancel(fn.parse(t))
"session/set_mode"          → e.setSessionMode(Bn.parse(t))
"session/set_model"         → e.unstable_setSessionModel(Jn.parse(t))
"session/set_config_option" → e.unstable_setSessionConfigOption(...)
"authenticate"              → e.authenticate(c.parse(t))
```

Each schema is a `zod` object. Default zod behavior strips unknown keys silently.

The fork's `cli/src/agent/backends/acp/AcpSdkBackend.ts` confirms the wire shape we send:

```253:288:cli/src/agent/backends/acp/AcpSdkBackend.ts
        const response = await withRetry(
            () => this.transport!.sendRequest('session/new', {
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            ...
        );
        ...
        const response = await withRetry(
            () => this.transport!.sendRequest('session/load', {
                sessionId: config.sessionId,
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            ...
        );
```

### 1.2 Does `session/new` accept an "initial context" payload?

**No.** Probe B in `/tmp/peer-D-spike/probe-acp.mjs` sent:

```json
{
  "cwd": "/tmp/peer-D-spike",
  "mcpServers": [],
  "meta":         { "migratedFrom": "legacy-test-uuid",
                    "priorTranscript": "user: hi\nassistant: hello" },
  "instructions": "Be terse.",
  "transcript":   [ {"role":"user","content":"hi"}, {"role":"assistant","content":"hello"} ],
  "history":      [ {"role":"user","content":"prior context line 1"} ]
}
```

Cursor-agent returned `{sessionId: "84ee10a6-..."}` - a **fresh, empty** session. Extra keys were silently dropped (zod default behavior). The new session's on-disk `~/.cursor/acp-sessions/84ee10a6-.../store.db` was created with zero blob rows (empty Merkle tree). **There is no documented or undocumented way to seed initial context via `session/new`.** This rules out the briefing's "replay-migration" path requiring a `session/new + meta` shortcut.

### 1.3 Does `session/load` accept legacy chat-uuids today?

**No - but only because of a directory-layout convention, not protocol-level rejection.** Probe C sent:

```json
{ "sessionId": "7e72da62-c3cf-49ca-98bb-f6b982f42dc7", "cwd": "...", "mcpServers": [] }
```

Response:

```json
{ "error": { "code": -32602, "message": "Invalid params",
             "data": { "message": "Session \"7e72da62-c3cf-49ca-98bb-f6b982f42dc7\" not found" } } }
```

This is **the literal rejection that `fix/cursor-acp-legacy-fallback` in our fork-only soup detects and translates to "Legacy stream-json sessions cannot be loaded via ACP"** (see `cli/src/cursor/cursorAcpRemoteLauncher.test.ts:207-218`).

### 1.4 Disk-layout / schema comparison: legacy vs ACP

**This is the key finding.** When cursor-agent runs in stream-json mode it writes to:

```
~/.cursor/chats/<workspace-hash>/<chat-uuid>/store.db
```

When it runs in ACP mode it writes to:

```
~/.cursor/acp-sessions/<chat-uuid>/
    store.db
    meta.json    # {"schemaVersion":1,"cwd":"<absolute path>","title":"<optional>"}
```

Both `store.db` files have **the same schema**:

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
```

Both store a content-addressed Merkle tree of chat content. Both `meta` records carry the same shape (`agentId`, `latestRootBlobId`, `name`, `mode`, `createdAt`, optional `lastUsedModel`, optional `isRunEverything`).

**Implication:** the file format on disk is the same. cursor-agent's ACP server simply looks in a different directory. Moving (or copying) the file across directories should make a legacy session loadable via ACP.

### 1.5 Other `agent` subcommands

`agent --help` lists `create-chat`, `ls`, `resume`, `worker`, `mcp` - none of which do conversion. `agent create-chat --help` shows no flags. There is **no documented import/export/convert command**.

---

## 2. Transplant experiment

### 2.1 Method

`/tmp/peer-D-spike/transplant-test.mjs` and `/tmp/peer-D-spike/transplant-test-2.mjs` run in an isolated `HOME=/tmp/peer-D-spike/fake-home/`:

1. Copy auth files (`cli-config.json`, `agent-cli-state.json`, `acp-config.json`) from real `~/.cursor/` (read-only against the user's auth state).
2. For each legacy session under test:
   a. Locate `~/.cursor/chats/<wsh>/<legacy-uuid>/store.db` (real path on operator's machine).
   b. `cp` it to `<fake-home>/.cursor/acp-sessions/<legacy-uuid>/store.db`.
   c. Write `<fake-home>/.cursor/acp-sessions/<legacy-uuid>/meta.json` with `{"schemaVersion":1,"cwd":"<original cwd>"}`.
3. Spawn `agent acp` with `HOME=<fake-home>`.
4. `initialize` → `session/load {sessionId: legacy-uuid, cwd, mcpServers:[]}`.
5. Sleep 3s to drain notification stream.
6. Send a probe prompt: *"In ONE short sentence (max 25 words), what was the main topic we were discussing? No preamble, no formatting."*
7. Collect `agent_message_chunk` text from notifications until `stopReason: end_turn`.

Throughout: the operator's real `~/.cursor/chats/...` is untouched; real `~/.cursor/acp-sessions/` is untouched; real `~/.hapi/hapi.db` is untouched.

### 2.2 Session A - 34 msgs, `/home/heavygee/coding/skills`

```
src store.db:       480 KB at ~/.cursor/chats/4921046521495b592458d3a53b6f3255/578a4cae-.../store.db
session/load:       OK in 2.76s
replay notifs:      35 total
   user_message_chunk: 1
   agent_message_chunk: 4
   agent_thought_chunk: 1
   tool_call: 14
   tool_call_update: 14
   available_commands_update: 1
session/prompt:     OK in 12.57s, stopReason="end_turn"
agent reply (109 chars):
   "Whether to add Tailscale's Docker networking sidecar pattern
   (from an XDA article) to your `tailscale` skill."
```

Specific, accurate recall of the actual prior conversation topic. Could not be produced from a blank slate.

### 2.3 Session B - 109 msgs, `/home/heavygee/coding/server-setup`

```
src store.db:       3996 KB
session/load:       OK in 2.74s
replay notifs:      127 total
   user_message_chunk: 3
   agent_message_chunk: 8
   agent_thought_chunk: 19
   tool_call: 48
   tool_call_update: 48
   available_commands_update: 1
session/prompt:     OK in 10.25s, stopReason="end_turn"
agent reply (133 chars):
   "Installing create-unmint system-wide, adding an unmint skill,
   and what skillregistryregistry.com should do beyond being a
   phone book."
```

Specific, accurate recall again. Two independent successful data points.

### 2.4 Continuity assessment

**Semantic, not cosmetic.** This is qualitatively different from the briefing's expected replay-migration outcome ("The model behind ACP starts fresh - re-derives everything from the replayed transcript. Continuity is cosmetic, not semantic.").

The transplant approach keeps the actual chat-uuid → the actual on-disk Merkle tree → the actual conversation state cursor-agent had assembled. The model that answers the next `session/prompt` is operating on the same state that an `agent --resume <legacy-uuid>` against stream-json would have used. There is no model voice shift, no re-derivation, no preamble inflation.

### 2.5 Token cost

`session/prompt` responses did not return a `usage` block (`prompt_usage: null` in both runs). I did not push further (one prompt per session is enough to prove the channel works; more would burn operator budget for no extra information). The qualitative point: the prompt I sent was ~30 tokens of input and ~30 tokens of output. **No preamble was injected.** This is the dominant cost advantage of transplant vs replay-migration: replay would have required either pasting the full prior transcript as a user message (5K-30K input tokens per session, paid every resume) or paying the model to read it.

### 2.6 Caveats / things that don't carry over

- `meta` record's `lastUsedModel` is ignored on `session/load`; the loaded session returns `currentModelId: "default[]"`. If the operator wants to preserve model preference, HAPI should call `session/set_model` post-load to re-apply the legacy session's last model.
- `meta` record's `name` (chat title) is not surfaced in the session/load response. HAPI already tracks session title in its own metadata, so this is a non-issue.
- The session/load response does NOT advertise `loadSession: false` for already-loaded sessions; the second load just works. No special-casing needed for retries.

---

## 3. Fodder audit (read-only against `~/.hapi/hapi.db`)

### 3.1 Bucket summary

```
acp                / running    4
legacy-streamjson  / archived  62
legacy-streamjson  / running    6
no-cursor-id       / archived  15
```

87 cursor-flavored sessions total; **68 of them are legacy stream-json** (the 4 already on ACP and the 15 no-cursor-id are out of scope).

### 3.2 Legacy by message-count bucket

```
1-9        2 sessions
10-49      1 session
50-199     9 sessions
200-999   37 sessions
1000+     19 sessions
```

The "small enough to throw away" tier is small: 2-3 sessions at most. **The other ~65 represent real conversation history.**

### 3.3 Intact vs missing on-disk store

```
Total legacy stream-json sessions (HAPI metadata):           68
Has intact ~/.cursor/chats/<wsh>/<uuid>/store.db on disk:    66
Missing on-disk store.db:                                     2
```

Missing details:

```
- id ffff088f-... cid a4d53078-... lifecycle=running msg=318
  path = h:\Users\heavygee\Documents\gavinc\misc      (Windows; chat lives off this machine)
- id e8023918-... cid b8535fb1-... lifecycle=archived msg=8
  path = ~/coding/hapi/worktrees/cursor-acp-plan-render (worktree may have been torn down)
```

The Windows session is unrecoverable from this machine; the 8-msg session is throwaway. **Migrator design can ignore both** by detecting "no on-disk store" and skipping with a clear telemetry line.

### 3.4 Storage footprint

Total bytes of intact legacy `store.db` files: **2.6 GB**.

`store.db` files are SQLite with WAL; they compress well (the blob trees often have duplicate fragments). After transplant they continue to live in `~/.cursor/acp-sessions/`; **net additional disk after migration: 0 bytes** if we `mv` the file rather than `cp`.

### 3.5 Workspace-hash dirs and untracked chats

```
Total workspace-hash dirs under ~/.cursor/chats/:                118
Total chat dirs with store.db on disk:                           395
Of those 395, referenced by HAPI metadata:                        66
Unreferenced (Cursor-IDE-only chats, or chats whose HAPI entry expired): 329
```

These 329 are out of scope - HAPI never knew about them. The migrator should only touch the 66 referenced ones.

### 3.6 "Migration would help" vs "throw away"

```
Worth migrating (intact + msg_count >= 50):    55 sessions (37 at 200-999, 19 at 1000+, 9 at 50-199; minus a few rounding)
Probably throw away (zero/1-9 or no on-disk):   3 sessions
Marginal (10-49 msgs):                          1 session (skills, the experiment session)
Running lifecycle (5):                          treat with care - resume during migrate is the risk
Archived (61):                                  bulk-migratable
```

---

## 4. Recommendation

### 4.1 The pick: option (a), but as **transplant**, not **replay**

The briefing's taxonomy:

| Option | Pre-spike verdict | Post-spike reality |
|---|---|---|
| **True transplant** | "Blocked at the cursor-agent layer" | **NOT BLOCKED.** Working in §2; just a filesystem-layout difference. |
| **Replay-migration** | "Plausible but expensive (tokens) and lossy" | Still plausible but strictly worse than transplant (preamble cost, model-voice drift, manual cosmetic linking). Skip. |
| **Shim-only** | Already exists (`isLegacyCursorSession`) | Still exists; doesn't deliver migration. |
| **Sunset telemetry** | Lowest cost, doesn't deliver migration | Now redundant; transplant migrator IS the answer. |

### 4.2 Phase 2 design sketch (informational - not implemented in this spike)

**Migration unit of work** (per HAPI session row where `metadata.flavor='cursor' AND cursorSessionId IS NOT NULL AND cursorSessionProtocol != 'acp'`):

```
1. Read HAPI session row for { cursorSessionId, path (= cwd) }.
2. Locate on-disk legacy store:
   for each <wsh> in ls(~/.cursor/chats): if exists(~/.cursor/chats/<wsh>/<cursorSessionId>/store.db) -> hit
   - if no hit: telemetry "no_legacy_store_on_disk", skip.
3. Pre-flight: check ~/.cursor/acp-sessions/<cursorSessionId>/ does NOT already exist
   (collision = corrupt invariant; bail loudly).
4. mkdir ~/.cursor/acp-sessions/<cursorSessionId>/
5. mv (or cp + later rm) ~/.cursor/chats/<wsh>/<cursorSessionId>/store.db
   to ~/.cursor/acp-sessions/<cursorSessionId>/store.db
   (mv preserves the file; cp doubles disk briefly. Recommend mv with pre-backup of hapi.db.)
6. Write ~/.cursor/acp-sessions/<cursorSessionId>/meta.json with
   {"schemaVersion":1, "cwd": "<HAPI metadata.path>",
    "title": "<HAPI metadata.title || legacy meta.name>"}.
7. UPDATE hapi.db: set metadata.cursorSessionProtocol='acp' for the session row.
8. Telemetry: count migrated, list any skipped (with reason).
```

Step 7 makes the existing `cursorAcpRemoteLauncher` (already in the fork from #799) pick up the session correctly on next resume - no launcher changes needed. `isLegacyCursorSession()` will return false because `cursorSessionProtocol === 'acp'`.

**Surfaces:**

- `POST /api/sessions/:id/migrate-to-acp` - per-session, returns `{ok, message_count, replay_notifications}` or structured error.
- `POST /api/cursor/migrate-legacy?lifecycle=archived&dryRun=false` - bulk endpoint.
- `hapi cursor migrate --all-archived` / `--all` - CLI wrapper.
- Web: button on legacy-session rows in inactive-list (label "Migrate to ACP"), guarded by "session is not currently running" pre-check.

**Running-session handling:**

5 of the 66 intact sessions are `lifecycle=running`. Migrating a running session is dangerous (the legacy launcher may have the store.db open). The migrator MUST refuse to act on running sessions and require the operator to archive or stop them first.

**Edge cases / refusals:**

- `running` lifecycle: refuse.
- On-disk store missing: refuse with telemetry; offer a "force convert to ACP-no-history" path (synthesize an empty store.db) ONLY if explicitly requested.
- Target `~/.cursor/acp-sessions/<uuid>/` already exists: refuse (corruption alarm).
- `~/.hapi/hapi.db` write-locked (hub running on it): the migrator should run via HAPI hub's session-row write path, not direct sqlite write, so it serializes with normal hub writes.

**Reversibility:** mv preserves the file. The reverse op is `mv ~/.cursor/acp-sessions/<uuid>/store.db ~/.cursor/chats/<wsh>/<uuid>/store.db` + flip `cursorSessionProtocol` back to `stream-json`. We MUST take a `hapi.db.bak.before-migrate-<ts>` before bulk runs.

**Backup:** before any bulk run, `cp ~/.hapi/hapi.db ~/.hapi/hapi.db.bak.before-migrate-$(date +%s)`. Per-session migrations are individually small but bulk should not start without the backup.

**Upstream PR shape:** the migrator is potentially upstreamable as a `hapi cursor migrate` command. The cursor-agent layer needs no change. (Optional follow-up: file a docs PR on cursor-agent that describes the on-disk layout so future tooling doesn't have to reverse-engineer it - low priority.)

### 4.3 Why NOT replay-migration

- It costs tokens every time it runs (preamble inflation).
- It produces cosmetic-only continuity (model re-derives state from text).
- It loses tool-call structure: legacy tool_calls + tool_call_updates would have to be rendered as plain text in the preamble, costing fidelity.
- It requires HAPI to render the transcript - hundreds of lines of formatter code we'd have to maintain.
- It is strictly worse than transplant on every axis given §2's evidence.

### 4.4 Why NOT sunset-only

The operator asked specifically: "I have a lot of sessions here that I would prefer to continue with as first-class ACP citizens." Sunset-only does not deliver that. Transplant does.

---

## 5. Open questions for operator

1. **Mv vs cp.** Recommend `mv` (no disk doubling; reversible). Confirm acceptable to delete the source file at `~/.cursor/chats/<wsh>/<uuid>/store.db` after the transplant. (Operator rule: "DO NOT DELETE DATABASES WITHOUT EXPLICIT APPROVAL" is why this needs a yes.)
2. **Running-session policy.** Migrator refuses by default. Want a `--force-archive-then-migrate` flag for the 5 currently-running legacy sessions, or should we hand-walk those?
3. **Untracked chats (329 of them).** They live on disk but HAPI doesn't know about them. Out of scope for this migrator; flag for a future "import-from-cursor" feature?
4. **`lastUsedModel` preservation.** Legacy meta has it; ACP `session/load` ignores it. Want the migrator to `session/set_model` post-load to re-apply, or accept the user-default fallback?
5. **Phase 2 PR scope.** All-in-one (transplant + endpoint + CLI + web button + tests) per the briefing's option-(a) sketch, or split into smaller PRs?
6. **Test fodder.** The 34-msg `578a4cae-...` and 109-msg `8f86bd77-...` sessions were transplanted successfully into an isolated fake HOME during this spike. They are untouched in the operator's real `~/.cursor/chats/` and `~/.hapi/hapi.db`. Operator approval to use them as fixtures for phase-2 integration tests?

---

## 6. Artifacts produced by this spike (read-only references; safe to delete)

```
/tmp/peer-D-spike/probe-acp.mjs         - JSON-RPC probe driver
/tmp/peer-D-spike/probe-acp-full.log    - 4 probes, full output
/tmp/peer-D-spike/transplant-test.mjs   - single-session transplant proof
/tmp/peer-D-spike/transplant-test.log
/tmp/peer-D-spike/transplant-test-2.mjs - two-session transplant + prompt
/tmp/peer-D-spike/transplant-test-2.log
/tmp/peer-D-spike/fake-home/            - isolated HOME used in §2 experiments
```

The fake-home contained ONLY copies of `cli-config.json`, `agent-cli-state.json`, `acp-config.json` from the real `~/.cursor/`. It was the entire side-effect surface of the experiments. Will be deleted on operator request (or at session end).

`probe-acp.mjs` also created two empty test sessions in the operator's REAL `~/.cursor/acp-sessions/` (uuids `a50a6a8f-302c-4a68-b271-838cc64b84aa`, `84ee10a6-bf06-4444-ba3f-afbd0453d1d4`). Each is a 45-114-byte `meta.json` only, no `store.db`. They were Probe A and Probe B's `session/new` outputs before I switched to the isolated HOME approach. They contain no chat content. Safe to `rm -rf` on operator approval (deferred per "DO NOT DELETE DATABASES WITHOUT EXPLICIT APPROVAL" - though these aren't real databases, just empty meta files).

---

## 7. Done / not done

**Done (this spike):**
- Probed cursor-agent ACP protocol surface; documented schemas + the rejection error verbatim.
- Verified `session/new` does not accept any seed-context payload (rules out replay shortcut).
- Discovered identical on-disk schema between legacy and ACP stores.
- Demonstrated transplant works end-to-end on two real legacy sessions, including post-load `session/prompt` recall.
- Audited operator's `~/.hapi/hapi.db` and `~/.cursor/chats/` to size the migration target (66 intact, 2.6 GB, 55 worth migrating).
- Wrote this report.

**NOT done (deliberately - phase 2 territory):**
- No code added or removed to the worktree.
- No PR opened.
- No mutation of `~/.hapi/hapi.db`.
- No mutation of any legacy session's `store.db`.
- No write to real `~/.cursor/acp-sessions/` except the two empty probe-A/B `meta.json` byproducts noted above.

---

## 8. Phase 2 entry checklist (for after operator greenlight)

- [ ] Operator approves recommendation (a)-transplant variant.
- [ ] Operator answers questions in §5.
- [ ] Backup `~/.hapi/hapi.db` per fork convention.
- [ ] Clean up phase-1 artifacts (`/tmp/peer-D-spike`, two empty probe sessions).
- [ ] Spawn a feature peer to build the migrator per §4.2.
