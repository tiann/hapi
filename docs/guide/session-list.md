---
description: "Find and organize HAPI sessions: presence badges, project grouping, search by details or message text, sort and filter, unread handling and row actions."
---

# Session list

HAPI's Web session list combines live session state, project grouping, search,
and local display filters. The list is designed to keep sessions that need
attention easy to find while still allowing older sessions to be searched.

## Ordering and grouping

The default order follows **your most recent input**, not the agent's most
recent output. Sending a new message moves a session forward once. Streaming,
tool/Todo updates, waiting for approval, completion, and reconnects do not
reorder ordinary rows. Status and unread indicators still update live.

1. Globally pinned sessions.
2. Project-pinned sessions.
3. `lastUserMessageAt` descending (or `createdAt` before any user input).
4. Creation time descending, then session ID for deterministic ties.

The Web app groups sessions by machine and project directory. Within a project,
pins come first, followed by the same user-input order. Project and machine
groups use their pinned state and newest member's ordering key, not live
activity. There is no fixed-order preference to configure.

The Hub persists the original user-message timestamp, including local CLI
input. Historical imports and duplicate/echoed messages do not acquire a fresh
ordering timestamp. Deletion or rewind does not rewind this monotonic clock.
An unattended session's new output is indicated as unread rather than moving
it ahead of conversations you have interacted with more recently.

The detailed API contract is documented in [REST — sessions](../api/client-contract/rest.md#sessions--list--detail)
and [SSE — keep-alive noise](../api/client-contract/sse.md#keep-alive-noise).

`updatedAt` remains the session activity clock used by timestamps, not the
ordering key. It is different from `activeAt`: `activeAt` is the CLI connection keep-alive
clock and does not, by itself, move a session in the list. A connected session
can therefore be idle; see [active is transport liveness, not agent health](../api/client-contract/sse.md#active-is-transport-liveness-not-agent-health).

**Settings → Display → Pin in-progress sessions** controls an **In progress**
section shown above the project folders (global pins stay above it):

- **Off** keeps every session in its project folder.
- **Long-running jobs** (the default) lifts unarchived sessions with a running
  [session job](./session-jobs.md) meter.
- **Working & pending** also lifts sessions whose agent is working or waiting
  on you.

Connected-but-idle sessions stay in their project folders in every mode. Rows
move into and out of the section as their status changes, but are ordered by
user input rather than ongoing output. **Active sessions only** in the same
settings group hides inactive sessions, except the open session and sessions
with a running job that have not been archived. A disconnected, archived
conversation stays in **Archived** even if its job is still reporting. Its row
retains the job meter. After 15 minutes without a heartbeat the job no longer floats
into **In progress** by itself. A job meter never spins the agent indicator. An independent process can keep reporting after archive;
work in the stopped session process tree can be terminated.

A session counts as working while it has open tool calls, even between agent
rounds. Autonomous loops that keep running tools therefore show as working
rather than as waiting for input.

## Custom folders

Use **New folder** in the session list to create a folder. Open it and choose
**New subfolder** to organize sessions further. From a session’s row menu,
choose **Move to folder** and select a destination. Choose **No folder** to
return the session to its regular list grouping.

The Hub saves folders and assignments for the current namespace. Search can
find sessions across folders. Deleting a folder removes its subfolders and
returns their sessions to the regular list.

## Text search

The search field has two scopes. The icon at its left edge switches between
them.

**Session details** (the default) searches session metadata, including:

- the displayed title (name, summary, path, or ID fallback);
- worktree labels and paths;
- summary text;
- agent flavor and machine label; and
- the session ID.

A **Default / Exclude** menu beside the field applies to this scope:
**Exclude** inverts the match and shows only sessions that do *not* match the
query.

**Message text** searches the messages inside every session (at least 2
characters). Matching sessions are listed with a snippet of the matching
message; opening a result jumps to that message. Very long messages are
truncated for indexing, so the list notes when results may be incomplete. The
status and **Unread only** filters still apply. Inside a chat, the same
message-text search is available for the current session.

In the session-details scope, plain-text matching is case-insensitive and supports partial substrings. A
multi-word query uses AND semantics: every term must match at least one
searchable field. Queries containing `*` or `?` use wildcard matching, where
`*` matches any sequence and `?` matches one character.

Search results are ranked by relevance rather than by date alone. Title and
worktree matches are more prominent than summary, machine, path, or ID-only
matches; token-boundary matches and exact/contiguous title phrases receive
additional preference. When relevance is tied, the stable user-input order is used
as the tie-breaker. This means an older session with a distinctive title can
appear above a newer session that only matches a common path segment.

Search preserves the session-list structure: pinned rows remain contiguous and
project groups remain visible. Matching project groups open automatically, but
the preview limit still applies within an open group. Search does not apply a
relevance cutoff; use the group's batch reveal controls to show additional
matching rows.

## Filters and display settings

- **Sort and filter** in the list toolbar holds the rarely changed view
  choices: sort by last message (the default) or date created; **Active
  first** (on by default); show all sessions, active only, or archived only;
  and **Unread only**. The currently open session stays visible. Choices are
  remembered locally, and a dot on the button marks a non-default view.
- **Machine** filters can be applied when more than one machine is present:
  chips under the toolbar on wide screens, a filter button in the toolbar on
  narrow ones. The selection is remembered locally in the browser and falls
  back to All when that machine is no longer available.
- **Keep unread sessions visible** (Settings → Display, on by default) keeps unread rows
  beyond the preview limit in **expanded** folders. A closed folder hides every row,
  including on first load. Explicit folds are remembered in this browser for the current hub and namespace.
  The toolbar still shows the unread count.
- **Session preview limit** controls how many rows are initially visible within
  each project group. Unread sessions, sessions with pending requests, and the
  selected session can remain visible; a project can reveal more rows in
  batches.
- **Session list status hints** chooses Basic (runtime state) or Extended
  (also permission, input, background-task, new-activity and scheduled-message
  hints).

## Row and group actions

- **Session rows.** Hover a row (desktop) to archive it or unpin it directly.
  The row menu also offers rename, global or project pin, and **Open in
  separate window**.
- **Deleting a session with a job.** Wait for a reporting job to finish. If its heartbeat
  is stale and you have confirmed the process has ended, the delete dialog lets you
  remove just that record. Confirm deletion separately afterward.
- **Status indicators.** The agent icon carries the presence badge. A spinner
  beside the title combines running activity with unread state; an unread
  session at rest shows a dot.
- **Titles.** Agents name sessions automatically and may update the title as
  work progresses. In the **Rename** dialog, the padlock locks a title so
  agent activity cannot change it; tap it again to unlock.
- **Project groups.** Right-click (or long-press) a project header to copy its
  path, start a new session in that directory, or archive all of its sessions.

Empty, inactive session stubs without conversation, an agent identity, or an
explicit title signal are not shown in the normal sidebar. Duplicate rows
representing the same underlying agent session are collapsed, with the live,
selected, pinned, or most recent row preferred as appropriate.

## Other Web session pickers

The other Web surfaces intentionally use related but different policies:

### Share-target picker

The `/share` picker snapshots the session list when it opens so live SSE
updates do not reshuffle the rows under the user's finger.

- With no query, it shows recent active sessions, sorted by `updatedAt` and
  capped by the session preview limit.
- With a text query, it searches all matching sessions,
  including inactive sessions, and keeps `updatedAt` descending order.
- It reuses the session metadata matching fields, but it does not apply the
  main sidebar's relevance ranking.

### `@` session suggestions

Composer `@` suggestions only include sessions with conversation content.
Active sessions appear first, followed by an inactive section that can be
collapsed or expanded. The browser remembers that choice. Each group shows up
to 20 matches, ordered by relevance and recency; names, directories, and
machine labels affect matching. Empty stubs are never mention targets, and
collapsing inactive sessions does not hide file suggestions.
