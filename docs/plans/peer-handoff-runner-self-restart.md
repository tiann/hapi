# Peer handoff: runner self-restart / systemd resilience

## Feature peer (operator continues here)

- **URL:** https://hapi.tail9944ee.ts.net/sessions/75b309ab-3fe9-45ba-841b-e2337d5ac0eb
- **Hub name:** `Peer: runner self-restart resilience`
- **Worktree:** `~/coding/hapi-runner-handoff` @ `fix/runner-handoff-systemd-resilience` (from `upstream/main`)
- **On disk:** `PEER_MIGRATION.md` in worktree root
- **Handoff:** queued via hub API

## Parent / trigger

- Orchestrator Cursor: `a890acd1-8251-482c-87a6-7d2cb6e47b84`
- Trigger session: `8903047b-1253-414b-9f1f-bb41f3d713b3` ("android watch") — operator UI showed "no machine online" because runner self-suicided at 22:40:47 BST and systemd `Restart=on-failure` did not recover (clean exit code 0)

## Scope

**Local fork only** per `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md`. Not an upstream PR.

## Sibling peers (separate lanes)

| Peer | Topic |
|------|-------|
| `f9f429a1-3e22-4788-a955-efc319098755` | #758 queued bar + inactive-send |
| **`75b309ab-3fe9-45ba-841b-e2337d5ac0eb`** | **runner self-restart resilience (this)** |

## Orchestrator must not

- Implement or shepherd this fix in the orchestrator chat
- Hand-edit `~/coding/hapi-driver`
