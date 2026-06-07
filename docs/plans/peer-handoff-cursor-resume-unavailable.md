# Peer handoff: Cursor resume_unavailable / missing cursorSessionId

You are a **feature peer agent** on the operator fork (`heavygee/hapi`). Work autonomously through intake §6 gates, then open an upstream PR on `tiann/hapi`.

## Parent

- Orchestrator: HAPI session where operator requested this peer (android-watch / resume investigation thread)
- Affected session (repro): `0525fe34-2eab-4d8e-a4ed-ef8210d172b6` ("android watch") — archived ~2s after spawn; resume returned 500 until manual recovery
- Recovered session (ops): `2010b5cf-cb9e-404c-bf8e-c4968bb28e7b` after DB patch + hub restart

## Bug summary (file upstream issue with these receipts)

**Symptom:** `POST /api/sessions/:id/resume` returns HTTP **500** with `{"code":"resume_unavailable","error":"Resume session ID unavailable"}` when operator tries to "restart" an inactive/archived **cursor** session.

**Root cause:** `syncEngine.resolveLocalResumeTarget()` requires `metadata.cursorSessionId` for cursor flavor (`hub/src/sync/syncEngine.ts` ~519–543). If the CLI exits/archives before `CursorSession` persists that ID, resume is permanently broken from the UI despite:
- CLI having been started with `--resume <uuid>` (ID in spawn args)
- Cursor transcript existing on disk at `~/.cursor/projects/.../agent-transcripts/<uuid>/`

**Repro timeline (2026-05-31):**
1. Session `0525fe34` spawned 00:39:30 with `cursor --resume d9c3d739-f146-434a-8339-16cfcb791422`
2. User terminated ~00:39:32 — log: `[cursor] Cleanup complete` before `[CursorSession] Cursor session ID ... added to metadata`
3. Hub metadata: `lifecycleState: archived`, `cursorSessionId` **absent**
4. `curl POST .../resume` → 500 `resume_unavailable`
5. DB patch adding `cursorSessionId` + `systemctl restart hapi-hub` → resume succeeded (new session id)

**Related:** [#728](https://github.com/tiann/hapi/issues/728) resume/config race class; fork manifest layer `fix/hub-resume-config-race-728`.

**UX defects to fix:**
1. Persist `cursorSessionId` as early as possible (on spawn when `--resume` known; on `system init` event)
2. Return **409/422** (not 500) when resume token missing; message: start fresh vs resume
3. Optional: recover resume id from transcript path when metadata missing (best-effort, cursor only)
4. Tests in `hub/src/sync/sessionModel.test.ts` (pattern exists for `resume_unavailable`)

## Intake status (orchestrator completed)

- [x] 1 Code search — DONE: `resolveAgentResumeId`, `resolveLocalResumeTarget`, `resumeSession` in `hub/src/sync/syncEngine.ts`; `cursorRemoteLauncher.ts`; `sessionHandlers.ts` metadata updates
- [x] 2 Upstream search — DONE: search `tiann/hapi` for `resume_unavailable`, `cursorSessionId`, #728; cite in issue body
- [x] 3 Playback — DONE: operator confirmed bug + wants upstream issue + fix PR
- [ ] 4 Issue — **YOU:** file on `tiann/hapi` with receipts above + curl/log excerpts
- [x] 5 Demo topology — **clean worktree** (upstream PR); no soup until operator approves

## Your assignment (feature peer)

- Own: **4** file issue → **5** implement in worktree → **6** gates → **8** `gh pr create` vs `upstream/main`
- Do NOT redo: code search / playback
- Worktree: `~/coding/hapi-cursor-resume-fix` @ branch `fix/cursor-resume-id-early-persist` from `upstream/main`
- Read: `docs/operator/AGENTS.md`, `docs/tooling/new-feature-intake.md`, `docs/tooling/cold-pr-review-rubric.md`
- Never commit: `docs/operator/`, `docs/plans/`, root `AGENTS.md`, secrets
- Upstream PR voice: diffident contributor; no fork strategy in PR body

### Implementation sketch

1. **CLI:** When cursor launcher gets `session_id` from stream `init` OR spawn already has resume id, call metadata update immediately (before long agent run).
2. **Hub:** Map `resume_unavailable` to **409** in `hub/src/web/routes/sessions.ts` (not 500).
3. **Tests:** Extend `sessionModel.test.ts` — archived session without cursorSessionId returns 409; early persist path covered if testable.

### Gates (§6 — before operator browser test)

```bash
cd ~/coding/hapi-cursor-resume-fix
bun typecheck
bun run test
# cold review full diff vs upstream/main
```

### Deliverables back to operator

- Link to `tiann/hapi` issue
- Link to PR vs `upstream/main`
- Summary of behavior change + test output

Do not run `hapi-watch-activate-driver` inside a HAPI agent turn.
