# AGY.md

Read `AGENTS.md` first. The repo rules there are binding for Antigravity agy work in HAPI.

## HAPI maintenance closure

When changing HAPI itself (source, tests, docs, agent instructions, scripts, config, or runtime maintenance notes):

- Verify with commands that match the touched surface.
- If the user requested review, or the change affects stability, routing, permissions, model selection, agent bridges, or maintenance policy, run the required external review before finalizing.
- If the user asks for the two-reviewer gate, use Codex + Claude-DeepSeek.
- Preserve runner-spawned agent environment attribution: `~/.local/bin` must stay on `PATH`, `HAPI_SESSION_ID` must be set, and handoff should default `CODEX_HANDOFF_CALLER_TAG` to that session id.
- Read review results from recorded artifact paths; fix any `FAIL` or `BLOCKED` finding, then rerun the relevant verification/review loop.
- After verification and required review pass, commit the exact touched paths. Do not leave task-created HAPI changes uncommitted.
- Keep unrelated dirty files separate. Do not use `git add .`, broad `git reset`, broad `git stash`, or `git clean` unless the user explicitly authorizes that cleanup.
- Do not change Claude model selection/list behavior unless the user explicitly asks for that change.
