# Git commit hooks (fork)

Install once per clone:

```bash
~/coding/hapi/scripts/tooling/install-git-hooks.sh
```

Sets `core.hooksPath` → `scripts/tooling/git-hooks/` (pre-commit, commit-msg, **pre-push**).

## Harvest resistance

Fork branches on `origin` must not carry **operator canon**, **plans**, **localdocs**, **XR POC**, or **persona routes** — even on `main`. Hooks block **staging** and **push** of that material so clones/remotes are not a harvest target.

| Layer | Blocks |
|-------|--------|
| **pre-commit** | Staging `docs/operator/`, `docs/plans/`, `localdocs/`, `xr-poc`, `.cursor/rules/operator*`, env files, `jessica-mood` paths/content, `SOUL_*` / `SOUL.md`, secrets |
| **pre-push** | Any **outgoing** commit range that touches those paths or adds `jessica-mood` / SOUL content |
| **commit-msg** | Same tokens in message body |

**Allowed in product code:** ElevenLabs voice name `Jessica` in `web/src/lib/voices.ts` (upstream). **Not allowed:** `hub/.../jessica-mood`, interior-note persona wiring, `docs/operator/*`.

## Overrides

| Variable | Use |
|----------|-----|
| `HAPI_ALLOW_OPERATOR_COMMIT=1` | One-off commit that must touch `docs/operator/` or `docs/plans/` (still review before push) |
| `HAPI_SKIP_COMMIT_HOOKS=1` | Emergency only — disables all three hooks |

**Note:** `docs/operator/` already in historical `main` — hooks stop **new** leaks. To strip from remote history use a separate git history rewrite (not automated here).

## Upstream PR branches

Product PRs to `tiann/hapi` must not include fork paths regardless — `git diff --name-only upstream/main...HEAD` should never list `docs/operator/` or `docs/plans/`.
