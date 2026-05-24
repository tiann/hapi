# Operator-local tooling (not for upstream)

Personal scripts and machine scans must **not** land in upstream PRs. This repo already ignores `localdocs/` and `execplan/` - use those instead of extending `.gitignore`.

**Agent instructions:** canonical guide is [`docs/operator/AGENTS.md`](operator/AGENTS.md) only. Root `AGENTS.md` is **deleted on this fork** (upstream keeps theirs; we never PR either).

## Where things live

| Kind | Location | Committed? |
|------|----------|------------|
| Machine chat index (293 sessions, paths, summaries) | `~/.hapi/operator/reconnectable-agent-chats.{json,txt}` | No - outside repo |
| Personal batch attach presets | `localdocs/operator/attach-existing-agent-sessions.sh` | No - `localdocs/` ignored |
| Regenerate chat index | `localdocs/operator/regenerate-chat-index.sh` | No |
| Generic attach-by-id (future PR F) | `scripts/attach-agent-chat.sh` | Yes, when ready |
| Voice dogfood evidence | `docs/dogfood/*.md` (sanitized) | Yes - product evidence |

## Commands

```bash
# Refresh index after new chats
./localdocs/operator/regenerate-chat-index.sh

# Lookup / attach (reads ~/.hapi/operator/ by default)
./scripts/lookup-agent-chat.sh 12
./scripts/attach-agent-chat.sh 3054d570

# Your hardcoded 8-session batch
./localdocs/operator/attach-existing-agent-sessions.sh
```

Override index path: `HAPI_CHAT_INDEX=/path/to.json`

## Belt-and-suspenders (no repo changes)

**`.git/info/exclude`** - personal gitignore, never committed. See yours for `PLAN.md` and any scratch paths still in the tree.

**Global ignore** - `~/.config/git/ignore` applies to all repos on this machine.

**Local pre-commit hook** - `.git/hooks/pre-commit` can refuse `git add` of operator paths; template in comments below.

```bash
#!/bin/sh
# .git/hooks/pre-commit (local only)
blocked='localdocs/|~/.hapi/operator|reconnectable-agent-chats|attach-existing-agent-sessions'
if git diff --cached --name-only | grep -Eq "$blocked"; then
  echo "Blocked: operator-local paths" >&2
  exit 1
fi
```

## Friction check before `git add -A`

- `docs/dogfood/` here is for **sanitized voice dogfood**, not full-machine chat inventories.
- `PLAN.md` at repo root is operator scratch unless you explicitly want it upstream.
