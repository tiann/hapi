# Patient-drain WORKING detection misses mid-turn sessions

Status: backlog
Date opened: 2026-06-13
Severity: high - patient drain skipped seven sessions that were not actually idle, including 4-5 that were within minutes of having dispatched a tool call

## What broke

`hapi-sessions-health.sh` (the WORKING-count source for `hapi-restart-hub`'s patient drain) classifies a session as `WORKING` only when the hub-side `thinking` flag is `true`:

    if thinking:
        return 'WORKING', f'thinking {think_age}', procs
    return 'OK', 'idle, ready for input', procs

The hub flips `thinking` on while the LLM is streaming a response or while a tool call is in progress. **Between the moment a tool result arrives and the moment the agent dispatches the next request - the reasoning phase between operations - `thinking` is false.** The session is mid-turn but the probe sees idle.

## Forensic trigger

2026-06-13 18:57:02 BST: operator's backup agent ran `hapi-restart-hub` (default patient path) from a Cursor agent shell. Pre-flight reported:

    patient: caller appears to be a Cursor agent (CURSOR_AGENT=1); subtracting 1 from WORKING count to avoid self-deadlock
    patient: WORKING raw=1 effective=0
    patient: effective WORKING=0, no drain needed
    Restarting hapi-hub + hapi-runner ...

Operator pointed at session `2b0b6360` (`pr 885 web-session-refetch-storm`) afterward and said "agents should END with summary - this one did not". Investigation: that session had a `tool-call-result` at 18:55:54 (3 minutes before the restart), no closing `AGENT_NOTIFY_SUMMARY` line. The agent was reasoning about the next tool call when the hub went down.

Audit of all sessions whose final pre-restart message lacked the summary line, in the hour before the restart:

    sid       last_msg             gap     project
    2b0b6360  18:55:54             3min    pr 885 web-session-refetch-storm
    885df5ee  18:55:04             2min    i698 pr699 bothappy status indicators
    8cccdd0b  18:54:06             3min    Peer 829 mermaid feedback (Approach B)
    8a8e8e52  18:53:08             4min    overseer prep
    58e5bcac  18:51:42             5min    pr896 scratchlist-v2
    97596986  18:24:49             32min   PR847 codex-usage (likely stuck or paused)
    7b422b92  18:09:00             48min   pr897 refetch-storm-fix-b (likely stuck or paused)

First five within 5 minutes of the restart - almost certainly mid-turn. Patient drain saw none of them. WORKING count of 1 was just the caller (Cursor agent itself).

## The contract that already exists

`AGENTS.md` already requires every assistant response to end with the `AGENT_NOTIFY_SUMMARY` JSON line. That line is the canonical "I am done with this turn" signal. The patient-drain probe is not consulting it.

## Candidate fix - tail-check + recency window

Replace the `thinking=true` predicate with:

    most_recent_agent_message_does_not_end_with_AGENT_NOTIFY_SUMMARY
      AND
    most_recent_message_age < HAPI_WORKING_RECENCY_WINDOW (default 600s)

Reasoning:

- The summary-line tail check captures the actual contract the operator enforces.
- The recency window prevents stuck/abandoned sessions from blocking patient drain forever (a session that has not advanced in 30 minutes is not "in flight" in the sense patient-drain cares about; it is wedged on something else and patient drain waiting on it is not the right response).

## Edge cases to design before shipping

Do not ship without thinking through:

1. Sessions whose flavor never emits `AGENT_NOTIFY_SUMMARY` (older agents, third-party MCP wrappers, Cursor sessions that pre-date the contract). Probe needs a fallback when the contract is not in play. Possibilities: per-flavor opt-in, or treat "session has any message ever ending with summary" as evidence the contract is in play.
2. Sessions where the most recent message is from the user (operator typed, agent has not started yet). Tail-check on a user message returns "no summary" trivially, but the session is not mid-turn; it is waiting on the agent to start. May or may not want patient drain to wait on those.
3. Sessions actively at a confirmation prompt (agent has emitted summary, operator has not replied; new user message arrives, agent starts; agent emits tool call, awaits result). The transition matters: between user-message-received and first-tool-call-dispatched, what does the probe see?
4. Cost. Tail-check requires reading the latest message content per session. For 100+ sessions this is a SQLite scan that the probe currently does not do. Need a cheap path - probably an indexed query plus an in-memory cache.
5. False positives during restart cascades. If hub just restarted and sessions are reconnecting, their last message is from the pre-restart era and probably mid-turn. Patient drain on a fresh restart should not block on those.

## Out of scope for this plan

`STUCK?` and `ZOMBIE` classification in `classify()` use the same `thinking=true` assumption in some branches. Same disease, separate audit, separate fix. Track in a sibling plan when this one ships.

## Tests required before merge

- Unit-style: 5+ test cases hitting the edge cases above, mocked DB rows.
- Integration: synthetic in-flight session at restart time, verify patient drain waits.
- Regression: existing sessions where the probe correctly identifies WORKING via the old path; new path must not regress those.
- Performance: probe latency at 100, 500, 1000 sessions. Current probe is already several seconds; tail-check must not balloon it.

## Definition of done

- Patient drain detects sessions in the "between tool calls" reasoning phase.
- Operator can run `hapi-restart-hub` from anywhere and trust that the WORKING count reflects actual in-flight agent work, not just hub-side flag state.
- Edge cases above are designed for, with documented per-case behaviour.
- Operator-fork rule and canonical agent guide are updated if any operator-facing behaviour changes (e.g. new env var to tune the recency window).

## Backlog priority

High. Today's incident was discovered because the operator manually noticed an agent that did not emit the summary line. Without their eye on it, this would have been silent.

## Related sibling plans

- TTY gate fix that broke the supported wrapper path silently before the ancestor walker landed (8ef45b44).
- `--impatient` TTY gate fix that closed the operator's-backup-agent self-trap (d4f3322a).

Same disease pattern across all three: the supported path looks safe, the underlying probe or wrapper has a gap, no one knows until something downstream notices.
