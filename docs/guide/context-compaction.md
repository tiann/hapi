# Context compaction

HAPI does not summarize, truncate, or rewrite model context by itself.
Compaction always stays aligned with the underlying official CLI runtime.

## Manual compaction

Use the native slash command:

```text
/compact
```

- Codex remote sessions call the official Codex app-server `thread/compact/start` RPC.
- Claude sessions pass `/compact` through to the official Claude Code CLI/SDK slash-command path.
- HAPI isolates the command so it is not batched into an ordinary user turn.

## Codex auto-compact opt-in

Codex app-server supports an official auto-compaction token limit config.
HAPI exposes only that Codex config as an opt-in process setting:

```bash
HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT=24000 hapi codex
```

When set to a positive integer, HAPI starts Codex app-server with:

```bash
codex app-server -c model_auto_compact_token_limit=<value>
```

Boundary:

- Default is off. If the environment variable is unset or blank, HAPI does not pass the config.
- This is Codex-only.
- It is a start-time app-server setting. Restart or resume the Codex-backed session to load a changed value.
- HAPI does not decide when to compact; Codex app-server decides according to its official config.

## Claude boundary

HAPI does not expose a Claude auto-compaction threshold because Claude Code does not provide a matching CLI/SDK setting for HAPI to safely pass through.
Use Claude's official `/compact` command instead.

## Display-only output compaction

Some HAPI views may collapse very large tool outputs into previews so the chat UI stays usable.
That is display-only output compaction, not model context compaction.
It does not summarize or rewrite the agent's model context, and it does not replace the official CLI runtime's own compact behavior.

## Regression checks

After prompt, UI, or compaction-adjacent changes, run:

```bash
bun run baseline:tokens:check
bun run baseline:tokens:check:portable
```

These replay existing local transcripts and check native compact telemetry.
They do not replace real new-session smoke tests or human review of capability and user experience.
