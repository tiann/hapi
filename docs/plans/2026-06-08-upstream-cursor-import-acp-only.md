# Plan: Upstream Cursor import to HAPI (ACP-only, no legacy bridging)

**Status:** Planned, not yet drafted
**Filed:** 2026-06-08
**Supersedes:** PR `heavygee/hapi#36` (closed 2026-06-08); precursor plan `docs/plans/2026-05-23-web-agent-chat-import-picker.md`
**Upstream targets:** Builds on `tiann/hapi#732` (RFC, cold), mirrors `tiann/hapi#796` (codex import) for Cursor, depends on `heavygee/hapi#34` / `tiann/hapi#824` (ACP migrator) merging first

---

## Strategic premise

`cursor-agent` will deprecate legacy stream-json. `#799` already migrated NEW sessions to ACP; `#34` is migrating LEGACY sessions to ACP on resume. The trajectory is clear: stream-json is sunsetting.

Therefore: **any HAPI feature that produces, accepts, or shepherds a stream-json session row is building technical debt.** The Cursor import feature in HAPI must produce ACP-only sessions, full stop. A chat that cannot be transplanted to ACP is an unimportable chat - not a stream-json session.

This is the same call upstream made implicitly with `#799` for new sessions; this plan makes it explicit for imports.

---

## What this PR does

Mirrors `tiann/hapi#796` (codex import) for Cursor, with the ACP-only constraint baked into the design:

1. **Discovery endpoint** - `GET /api/cursor/importable-sessions` lists local Cursor chats from both:
   - `~/.cursor/chats/<wsh>/<uuid>/store.db` (legacy stores)
   - `~/.cursor/acp-sessions/<uuid>/{store.db,meta.json}` (already-ACP stores)
   - Returns: `{uuid, workspacePath, firstUserMessage, mtime, alreadyImported, importedHapiSessionId, sourceFormat: 'legacy'|'acp'}`

2. **Import endpoint** - `POST /api/cursor/import { uuid, workspacePath }`:
   - If `sourceFormat === 'acp'`: synthesize HAPI metadata row with `cursorSessionProtocol='acp'`, backfill messages, return new session id.
   - If `sourceFormat === 'legacy'`: invoke `#34`'s `cursorLegacyMigrator` as a library primitive - cp to acp-sessions, synth meta.json, verify via `agent acp` (initialize + session/load + tiny session/prompt).
     - **If verify succeeds:** create HAPI row with `cursorSessionProtocol='acp'` from birth, backfill messages, return new session id.
     - **If verify fails:** return structured error (`verify_load_failed`, `missing_on_disk_store`, `target_already_exists`, etc.). Chat is unimportable. **No fallback to stream-json.**
   - All metadata writes use the version-mismatch retry pattern from `#34`.

3. **Web UI** - `CursorSessionSyncDialog.tsx` mirroring `CodexSessionSyncDialog.tsx`:
   - Lists candidates with workspace filter, multi-select.
   - Per-row badge: "ACP" or "legacy (will transplant)" so operator knows what'll happen.
   - On import: shows per-session in-flight status (reusing `CursorMigrationBanner` from `#34`).
   - Verify-failure cases shown with structured error + "skip" action.

4. **CLI** - `hapi cursor import <uuid> [--workspace <path>]` and `--list` flag mirroring codex.

5. **Reuse, don't duplicate** - `cursorLegacyMigrator.ts` from `#34` is the transplant primitive. Import code calls it; doesn't reimplement.

---

## How this subsumes current fork tooling

| Fork tool | Status after this PR lands upstream |
|---|---|
| `scripts/attach-agent-chat.sh` / `.ts` | Retired. Operator uses web dialog or `hapi cursor import` CLI. |
| `scripts/backfill-agent-transcript.ts` | Retired as user-facing tool. The 50_000 cap + `truncated` flag discipline (`#37`, merged `9f18789b`) should be ported into the upstream import code's backfill helper. |
| `scripts/tooling/hapi-resurrect-session.sh` | Subsumed. The "resurrect" case becomes a sub-case of import: "import a legacy chat whose HAPI row exists but is archived-crashed with `cursorSessionId=NULL`." Import endpoint handles it by detecting the dangling HAPI row, re-linking, then doing the standard transplant. |
| `scripts/import-recovered-md.ts` | Stays as fork-only operator tool. Specstory `.md` recovery is an unusual edge case unlikely to be upstream-bound. |

The Cursor import PR is the upstream landing path for ~75% of what the fork tooling does today.

---

## Strict refusal contract (ACP-only enforcement)

The import endpoint refuses (no mutation, structured error) on:

- `verify_load_failed` - `agent acp` session/load failed on the transplanted store
- `missing_on_disk_store` - no `store.db` at the legacy or ACP path
- `target_already_exists` - ACP directory already exists for this UUID (race or prior partial import)
- `already_imported` - HAPI session row already references this UUID
- `agent_binary_not_found` - `agent` not on PATH (the `#34` dogfood gotcha; document the systemd PATH fix prominently)
- `verify_timeout` - probe ran longer than configurable timeout
- `corrupted_store` - SQLite open or schema check failed

Every refusal: legacy `store.db` untouched, no HAPI row created, structured error returned to caller, banner cleared.

**No stream-json HAPI row is ever created by this import path.** Not as a partial state, not as a fallback, not as "we'll try ACP later." The operator either gets an ACP session or a clear error.

---

## Test plan (sketch)

- Unit tests covering every refusal path (mocked filesystem + mocked `cursorLegacyMigrator`).
- Integration test (opt-in via `CURSOR_IMPORT_INTEGRATION=1`) that:
  1. Builds a synthetic legacy store via `#34`'s `buildSyntheticLegacyStore` fixture
  2. Calls the import endpoint
  3. Asserts new HAPI session is ACP from birth, messages backfilled, legacy source removed
- Fault-injection integration test that mutates the synthetic store to fail verify, asserts no HAPI row created, structured error returned.
- Web dialog tests mirroring `CodexSessionSyncDialog.test.tsx` patterns.

---

## Coordination with `#34`

- **Must merge after `#34`** because we depend on `cursorLegacyMigrator.ts` as a library.
- Once merged, `#34`'s auto-migrate-on-resume becomes the LEGACY remediation path for sessions that were imported before this PR landed (i.e. sessions that snuck into HAPI as stream-json via `attach-agent-chat.sh` or other pre-this-PR mechanisms).
- After both ship: the only remaining stream-json sessions in HAPI are the ones a user manually creates with a `--legacy` flag (if such a flag even exists; if not, even better).

---

## Pre-PR audit (must do before writing code)

- Run `agent acp` verify probe against every chat in operator's `~/.cursor/chats/` (~300+ chats per recent `#34` body claims). Count pass/fail/error breakdown.
- If pass rate >= 95%: ship as designed. The handful of unimportable chats get structured errors.
- If pass rate < 90%: document failure modes in the PR body, decide whether each one is a fixable upstream cursor-agent bug or genuinely-unimportable.
- Goal: never ship a feature where 1-in-5 imports silently fails or produces unusable state.

---

## Open questions for the PR author (future me or peer)

1. **Workspace path handling.** A Cursor chat's `wsh` is the MD5 of the workspace path it was opened against. If the operator moved the workspace post-chat (worktree rename, machine migration), the discovery scan won't find the chat under the new path. Resurrect script handles this with `--symlink-old-path` flag - import endpoint may need an equivalent (or accept an explicit `wsh` override).
2. **Bulk import?** Codex import supports multi-select. Should we follow suit, or scope this PR to single-import and add bulk in a follow-up? Lean toward single-import first since each transplant is 15-20s and bulk failure handling adds complexity.
3. **Should `hapi cursor import` accept stdin / file of UUIDs for scripted batches?** Operator convenience; can defer.
4. **What happens to a HAPI session row whose `cursorSessionId` points at a chat that was deleted from `~/.cursor/chats/` after import?** Already imported = `alreadyImported` flag in discovery is `true`, but disk store is gone. `#841` already filed upstream about this for the resume path. Not this PR's lane, but worth cross-referencing.

---

## Fork-side cleanup once upstream lands

- Retire `attach-agent-chat.sh`, `backfill-agent-transcript.ts`, `hapi-resurrect-session.sh`. Delete with one commit, replaced by a doc pointer to `hapi cursor import`.
- Update `~/coding/skills/hapi-find-and-attach-legacy-chat/` skill: most of the "Find phase" / "Attach phase" / "Reconnect phase" / "Resurrect phase" content reduces to "use the Cursor import dialog or `hapi cursor import`."
- Port the `#37` truncation discipline into upstream's backfill code if it's not already there.

---

## Why this is the right move (rationale capture for future agents)

1. **Strategic alignment with cursor-agent's direction.** Stream-json is dying. Building on dying tech is debt.
2. **One canonical surface.** Today: fork has 3+ scripts, upstream has nothing for Cursor. Tomorrow: upstream has one dialog + one endpoint + one CLI, fork has nothing extra.
3. **Reuses `#34`'s well-tested primitive.** `cursorLegacyMigrator` has 25 unit + 3 integration tests and passed 4/4 real dogfood migrations including a 374MB store. We get that safety for free.
4. **Mirrors a known-good shape (`#796`).** Codex import was merged by tiann within a day or two of being filed. Mirroring its shape minimizes review friction.
5. **Closes the discovery gap that fork operator scripts have been papering over for months.** RFC `#732` filed 10 days ago is the operator's own previous statement of this need; this PR is its concrete execution.

---

## Decision tree summary

```
operator wants a Cursor chat in HAPI
        |
        v
[upstream-bound] Cursor import dialog or `hapi cursor import <uuid>`
        |
        v
[hub-side] is the chat already ACP at ~/.cursor/acp-sessions/<uuid>/?
        |
   yes -+-> synthesize HAPI row (protocol=acp), backfill, done
        |
   no --+-> invoke cursorLegacyMigrator (cp+meta.json+verify)
              |
        verify ok  -+-> create HAPI row (protocol=acp), backfill, done
                    |
        verify fail +-> structured error, NO HAPI row, legacy store untouched
```

Single path. No protocol fork in the user flow. Clean.
