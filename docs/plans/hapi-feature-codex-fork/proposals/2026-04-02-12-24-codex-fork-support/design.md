# Codex Fork Support Proposal

## Change Summary
- Wire Codex fork through CLI, runner, hub, and web
- Reuse upstream Codex app-server `thread/fork`
- Keep resume semantics unchanged

## Affected Modules
- cli
- hub
- web

## Behavior
- `hapi codex fork <sessionId>` starts a new session forked from an existing Codex thread
- Web adds a Fork action for Codex sessions
- Hub exposes `POST /api/sessions/:id/fork`
