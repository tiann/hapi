# Peer handoff: composer eats text on 4xx/5xx (issue #15)

**Issue:** https://github.com/heavygee/hapi/issues/15
**Spawn location:** new worktree at `~/coding/hapi/worktrees/composer-error-retain-text` (branch `fix/composer-retain-text-on-error`)
**Owner peer task:** ship fix end-to-end, including upstream PR.

---

## Step 0 -- intake (done vs owned by you)

**Done by orchestrator before spawning you:**
- Issue filed: #15
- Reproduction: `POST /api/sessions/:id/messages` returns 4xx/5xx during e.g. a hub restart, composer clears typed text -- happens repeatedly during dogfood restarts.
- Daily-rebuild restart blip measured at 0.52s; common cause of the trigger.

**Owned by you:**
- Locate the composer component(s) in `web/src/`
- Identify the `onSubmit` -> `setState` reset order causing the destructive clear
- Implement: clear input ONLY on `2xx`; retain on 4xx/5xx/network error
- Optimistic render (message bubble in "sending" state) is welcome but optional
- Visual error affordance on the input (border colour + inline error message)
- Tests
- Branch from `upstream/main`, push, open PR to `tiann/hapi`

---

## Acceptance (from issue #15)

- [ ] Submit -> 500/502/503/network error -> composer text **not** cleared
- [ ] Submit -> 400/401/403 -> composer text **not** cleared, error surfaces inline
- [ ] Submit -> 2xx -> composer clears as today
- [ ] Operator can edit retained text and retry without re-typing
- [ ] Test covering all three branches

---

## Implementation hints

- The composer is somewhere in `web/src/components/` -- grep for `POST.*messages` or `sendMessage(` to find the dispatch site.
- Likely a `useState` for the input value that gets reset eagerly inside the submit handler before the network call resolves.
- Pattern: capture `const pending = input` before clearing, then `setInput('')` only inside the success path; in the catch / non-2xx branch, restore with `setInput(pending)` and surface the error.
- Don't break the existing "message sending" optimistic render if there is one.

## Test ideas

- Unit: mock the API client, assert input state across success / 500 / network error / 401
- Integration / Playwright (optional): kill the hub mid-send, verify text still in input after the error toast

---

## Constraints

- Branch off `upstream/main` only; don't include `docs/operator/` or `docs/plans/` in the PR diff (fork convention).
- Don't bump SCHEMA_VERSION; this is pure frontend.
- Worktrees go in `~/coding/hapi/worktrees/` (canonical layout).

## When done

- Open PR to `tiann/hapi`, link issue #15
- Comment on issue #15 with the PR link
- Ping orchestrator session
