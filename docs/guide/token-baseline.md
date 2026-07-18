# Token replay baseline

HAPI can generate an offline token baseline dashboard from local Codex and Claude transcript logs.

Run:

```bash
bun run baseline:tokens
```

The command prints an output directory containing:

- `report.md` — human-readable dashboard
- `summary.json` — structured summary
- `codex_sessions.csv`
- `codex_compactions.csv`
- `claude_sessions.csv`
- `claude_compactions.csv`

Custom paths:

```bash
bun run baseline:tokens -- \
  --out ./hapi-token-baseline \
  --hapi-codex-root ~/.hapi/codex-home/sessions \
  --cli-codex-root ~/.codex/sessions \
  --claude-root ~/.claude/projects
```

Boundary:

- The command only replays existing local JSONL logs.
- It does not call Codex, Claude, or any model provider.
- It measures native compact events already emitted by the official CLI runtimes.
- Use this baseline before and after HAPI prompt/UI/compaction-adjacent changes to verify that compact telemetry parsing and compaction ratios did not regress.
- It is not a substitute for real new-session smoke tests or human review of capability and user experience.
- For the runtime compaction boundary, see [Context compaction](./context-compaction.md).

## Regression gate

Run the local strict real-history replay gate:

```bash
bun run baseline:tokens:check
```

This is equivalent to:

```bash
bun run baseline:tokens:check:local
```

The local strict gate compares the current replay summary against `docs/metrics/token-baseline-gate.local.json`.
It enforces both local-history volume minimums and compaction ratio maximums.
Use it on the maintainer machine that has the real HAPI/Codex/Claude transcript corpus.

For CI or another machine that may not have the same local transcript volume, run the portable gate:

```bash
bun run baseline:tokens:check:portable
```

The portable gate compares against `docs/metrics/token-baseline-gate.portable.json`.
It does not enforce local-history volume minimums.
Missing replay data is reported as a warning, while available compaction ratios still fail on regression.

The checked-in gates store only aggregate thresholds, not raw transcript content or local file paths.
