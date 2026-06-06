# CLAUDE.md (fork-local guide for Claude Code)

This is a fork-local Claude Code guide for `heavygee/hapi`. Claude Code reads this file automatically in addition to `~/.claude/CLAUDE.md` (user-level) and `AGENTS.md` (project root, byte-identical to upstream `tiann/hapi`).

## Read first (fork canon)

| File | Purpose |
|------|---------|
| [`docs/operator/AGENTS.md`](docs/operator/AGENTS.md) | **Canonical fork guide** — HAPI baseline + fork intent + upstream PR discipline + voice/XR pointers. Supersedes root `AGENTS.md` for any fork-specific behavior. |
| [`docs/tooling/new-feature-intake.md`](docs/tooling/new-feature-intake.md) | New product behavior — discovery, peer spawn handoff (`§0` block), soup vs clean demo, gates before operator test. |
| [`docs/tooling/pr-review-loop.md`](docs/tooling/pr-review-loop.md) | Pre-PR gate, pre-push cold review, post-push monitor. Explains `cold-review-clean` semantics and fork-vs-upstream bot drift. |

## Why root `AGENTS.md` is upstream-verbatim

Root `AGENTS.md` is intentionally byte-identical to `tiann/hapi:main:AGENTS.md` so that **ChatGPT Codex Cloud** (the PR review bot) reads the same project context on fork PRs as on upstream PRs. This closes one of the structural causes of fork-vs-upstream bot drift documented in `docs/tooling/pr-review-loop.md`.

Fork-private operator instructions live in `docs/operator/AGENTS.md` and are loaded by:

- **Cursor:** `.cursor/rules/operator-fork.mdc` (alwaysApply)
- **Claude Code:** this file (auto-discovered at repo root)
- **Other agents on this machine:** user-level `~/.claude/CLAUDE.md` chain + `~/coding/AGENTS.local.md` (operator-private)

## Operator-private overlays (gitignored)

- `~/coding/AGENTS.local.md` (machine policy)
- `~/coding/hapi/AGENTS.local.md` (repo-local operator overlay; never committed)

## Runtime vs workspace

Cursor/Claude workspace is usually `~/coding/hapi` (mirror + local docs). **`~/coding/hapi-driver`** is the daily-driver runtime via `hapi-active` — not the default place agent rules load from.

## Peer agents

Orchestrator must pass completed vs owned intake steps when spawning peers — template in `docs/tooling/new-feature-intake.md` §0.

## Hard rules (carry over from `.cursor/rules/operator-fork.mdc`)

- **Before any `hapi-driver-rebuild` or `hapi-use-worktree`:** run `hapi-driver-status --quiet` (exit 0 idle, 75 busy, 2 stale). The scripts auto-flock; precheck avoids 30-agent collisions on the stack. See `docs/tooling/driver-soup.md#coordination-avoid-stack-switch-contention`.
- **NEVER `sudo systemctl restart hapi-hub.service`** (or `... hapi-hub.service hapi-runner.service`). It yanks WORKING agents mid-turn. Use **`hapi-restart-hub`** (patient drain, 10min timeout, `--impatient` for hung-hub emergencies). For stack switches use `hapi-use-worktree`. See `docs/tooling/driver-soup.md#patient-restarts-dont-yank-live-agents`.
- **Upstream PR branches:** from `upstream/main` only; never include `docs/operator/`, `docs/plans/`, or this `CLAUDE.md` in the PR diff (the leak scanner enforces this).
- **Plans:** `docs/plans/`.
