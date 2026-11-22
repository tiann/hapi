---
description: "Track agent working time with hapi usage, token usage per session, and Claude, Codex and Antigravity plan quotas and rate limits."
---

# Usage and quotas

HAPI answers three different questions about how much your agents are doing:

| Question | Where | Scope |
|----------|-------|-------|
| When were agents working, and for how long? | `hapi usage` (CLI) | Your namespace |
| How many tokens did they process? | **Settings → Token usage** (web), **Settings → Usage** (iOS / Android) | Hub owner only |
| How much of my plan's rate limit is left? | **Settings → Token usage → CLI account quotas** and the quota chip next to the composer (web) | Hub owner for Settings; any session for the chip |

## Agent activity: `hapi usage`

The hub records each agent **turn** — from the moment a session starts thinking until it stops — in its database. Turns survive hub restarts: on startup the hub closes turns that the previous process left open at the session's newest message, and if the agent keeps thinking within 10 minutes of the restart, the same turn continues.

`hapi usage` reads those turns back across every machine connected to the hub:

```bash
hapi usage                                    # last 24 hours
hapi usage --since 7d
hapi usage --since 2026-10-01 --until 2026-10-08
hapi usage --json                             # machine-readable, schema hapi.activity.v1
```

`--since` and `--until` accept relative durations (`30m`, `24h`, `7d`), an ISO date, or epoch milliseconds. A window can be at most 31 days.

The summary lists sessions sorted by time worked, with title, agent, machine (`this machine` for the local one), number of turns, and `(working now)` for a turn still in progress:

```
Agents worked 3h 12m across 4 sessions:
     1h 40m  refactor auth · claude · this machine · 6 turns
     ...
```

Only the part of each turn inside the window is counted, and time spent waiting on a permission prompt or a question is subtracted from it.

`--json` prints the full report (each session's turns and waits) for other tools such as time trackers. Errors go to stderr so stdout stays parseable.

| Exit code | Meaning |
|-----------|---------|
| `2` | Bad arguments |
| `3` | Not signed in, or the hub refused the token |
| `4` | Hub too old to answer |
| `1` | Any other error |

`hapi usage` authenticates like the other CLI commands — `HAPI_API_URL` / `CLI_API_TOKEN`, or the settings saved by `hapi auth login`. It reports the namespace of that token; it is not restricted to the hub owner. See the [CLI reference](./cli-reference.md) for shared options.

## Token usage dashboard

**Settings → Token usage** in the web app (and **Settings → Usage** in the iOS and Android apps) shows tokens processed while agents ran under HAPI, for the last 7 days, 30 days, or all time:

- Totals: processed tokens, non-cached tokens, input, output, cache read, cache creation, cache hit rate, and request count
- A daily trend, plus breakdowns by agent and by model
- The number of sessions with usage

Token usage from transcripts imported from earlier local history is excluded, and costs are not shown.

::: info Hub owner only
The token dashboard and the account quotas below are only available to the hub owner (the `default` namespace). Other namespaces get an explanatory message instead. See [Namespaces](./namespace.md).
:::

## CLI account quotas

The **CLI account quotas** section at the top of **Settings → Token usage** asks every online machine which agent accounts are signed in there and how much of each plan's rate limit is used. Each card shows:

- The agent, and the machine name when more than one machine is online
- Plan and, for Codex, credit balance when the account reports them
- Each limit window as a bar with the percent remaining and used, and when it resets

**Refresh quotas** forces a fresh read on every machine. Otherwise the runner caches results for about a minute, and the page does not refetch on its own.

### Which agents report quotas

| Agent | Source | Notes |
|-------|--------|-------|
| Claude Code | Reads the plan's 5-hour and 7-day windows on demand from Claude Code (the same data as its `/usage` command), plus `rate_limit` events observed during Claude turns | Expired login shows **Not signed in**. A custom endpoint or API key with no plan window shows **Custom endpoint / API key** |
| Codex | Asks the Codex app-server for the account and its rate limits, plus rate-limit updates observed during Codex turns | Shows plan and credits; additional named limits appear as separate groups. API-key accounts without plan windows show **Custom endpoint / API key** |
| Antigravity | Runs Antigravity's `/usage` command headlessly | Windows are grouped by model group |

Other agents do not report account quotas. Agents that are not installed on a machine are hidden from the list.

If a card says **Update the runner on this machine to view CLI account quotas**, that machine's runner predates quota support — upgrade HAPI there and restart the runner.

### Plan quota next to the composer

In a web chat, a compact chip next to the context meter shows the current agent's plan usage on that session's machine, for example `5h 42% (2h13m) · 7d 18% (2d14h)`: used percent and time until reset for the 5-hour and weekly windows. On narrow screens only the 5-hour window fits; tap the chip for a popover with bars, reset countdowns and reset times.

- The chip turns amber at 20% remaining or less, and red at 5% or less.
- It refreshes every 2 minutes and hides itself if a read fails rather than show stale numbers.
- It appears only when the account reports an account-wide 5-hour or weekly window — in practice **Claude Code** and **Codex**. Antigravity's per-model-group windows stay in Settings.
- It needs a runner with quota support on the session's machine.

The iOS and Android apps do not show account quotas yet.

## Related

- [Session list](./session-list.md) — live session status
- [Configuration](./configuration.md)
- [Authentication](./authentication.md) — signing the CLI in for `hapi usage`
