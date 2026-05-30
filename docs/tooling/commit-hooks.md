# Git commit hooks (fork)

Install once per clone:

```bash
~/coding/hapi/scripts/tooling/install-git-hooks.sh
```

Sets `core.hooksPath` → `scripts/tooling/git-hooks/` (no Husky/npm required).

## What is blocked

| Gate | Scope |
|------|--------|
| **Paths** | `localdocs/`, `.env*`, `AGENTS.local.md`, `*~` |
| **Operator paths on PR branches** | `docs/operator/`, `docs/plans/` when branch is not `main` / `driver/integration` / `docs/*` |
| **Persona / fork-only strings** | `jessica-mood`, `SOUL_SESSION`, `SOUL.md`, `localdocs/` in staged content |
| **Secrets (heuristic)** | `CLI_API_TOKEN=`, `*_API_KEY=`, `sk-`, `ghp_`, etc. in staged diff |
| **Commit message** | `jessica-mood`, `SOUL.md`, `AGENTS.local`, `Co-authored-by: Cursor` |

**Allowed:** ElevenLabs voice name `Jessica` in product code (`web/src/lib/voices.ts`) — not the same as fork route `jessica-mood`.

## Bypass

```bash
HAPI_SKIP_COMMIT_HOOKS=1 git commit ...
```

Use only for emergencies; never on upstream PR branches.

## Upstream PRs

Hooks run on every commit in this clone. Upstream PR branches must still pass:

```bash
git diff --name-only upstream/main...HEAD | grep -E '^(docs/operator|docs/plans)' && echo STOP
```
