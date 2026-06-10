# Peer handoff: agent markdown table corruption investigation

**Session name:** Peer: agent table markdown / message serialization
**Worktree:** `~/coding/hapi` (main mirror — read + trace only; no feature code)
**Flavor:** cursor, yolo, simple session
**Parent:** meta PR watcher (this session)

---

## Problem statement

Multiple agents running inside HAPI sessions consistently emit malformed markdown tables.
The most recent confirmed instance (2026-06-09):

- Agent emitted a 7-column header with a 4-column separator row.
- DOM analysis confirmed the table landed inside `<p class="aui-md-p">` not `<table>` — HAPI's markdown renderer received malformed input and rendered it correctly as prose.
- Other markdown (h3, ul/li) in the same message rendered fine — the renderer is not at fault.
- Pattern has occurred multiple times across different agent flavors (cursor, claude, codex).

The question is **not** "why do agents make typos." It is: **does something in the HAPI message pipeline cause agents to see malformed tables in their own prior context, and then mirror that malformation?**

---

## Investigation scope

Trace the full path of an assistant message from generation → hub storage → agent CLI input. Look for any point that transforms, truncates, joins, or normalises whitespace/newlines in message bodies.

### Files / areas to examine

| Area | Key files | What to look for |
|------|-----------|-----------------|
| Message storage | `hub/src/db/` | How assistant message body is stored — verbatim or transformed |
| History serialization | `hub/src/session/` | How prior turns are reconstructed into agent prompt input |
| Message joining | `cli/src/cursor/cursorRemoteLauncher.ts`, `cli/src/utils/MessageQueue2.ts` | `waitForMessagesAndGetAsString()` joins with `\n` — does this collapse multiline assistant content? |
| Context formatting | `cli/src/cursor/`, `cli/src/claude/`, `cli/src/codex/` | How conversation history is formatted before passing to agent stdin/args |
| Web message API | `hub/src/web/routes/sessions.ts` | Does the GET messages endpoint normalise content before returning to the web UI? |
| System prompt injection | Any preamble assembly | Does any injected context strip bare newlines? |

### Specific questions to answer

1. Is assistant message body stored verbatim in the DB, or is it serialized through anything that could mangle `\n`?
2. When the hub reconstructs history for an agent, is each turn's content preserved with original newlines?
3. Does `waitForMessagesAndGetAsString()` or any batch-join path ever see assistant message content, and if so what happens to embedded newlines?
4. Is there a code path where prior assistant turns are summarized, truncated, or normalized before re-injection into agent context?
5. Run the cheapest falsification test: send a known-good 2-column table as a message to a test session, read it back via the API, compare bytes — do the newlines survive?

---

## Deliverable

A short findings doc (inline in this session is fine) covering:

- Which paths **do** preserve newlines verbatim
- Which paths **do not** (confirmed transforms)
- Whether any transform could plausibly cause an agent to see a malformed table in its own prior context
- Recommended fix (or "no HAPI bug found — pure agent generation error") with evidence

If a HAPI bug is found: draft an upstream issue body and flag back to meta PR watcher.
If no HAPI bug found: confirm the pattern is pure agent generation error and close.

**Do not open a PR** until investigation is complete and meta watcher approves scope.

---

## Related

- PR #747 review: `waitForMessagesAndGetAsString()` queue-batching flagged by HAPI Bot
- DOM analysis: 7-col header / 4-col separator confirmed as generation error, not renderer error
- Pattern: table malformation observed across cursor, claude sessions in HAPI over ~2 weeks
