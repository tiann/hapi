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

`updatedAt` remains the session activity clock used by timestamps and the date
filter, not the ordering key. It is different from `activeAt`: `activeAt` is the CLI connection keep-alive
clock and does not, by itself, move a session in the list. A connected session
can therefore be idle; see [active is transport liveness, not agent health](../api/client-contract/sse.md#active-is-transport-liveness-not-agent-health).

When enabled in **Settings → Display**, the optional in-progress layout moves
active sessions into Working, Pending, Active, and Idle sections. Global and
project pins remain distinct from these sections. This optional layout still
moves rows between sections as their status changes, but orders rows within
each section by user input rather than ongoing output.

## Text search

The search field on the Web session list searches session metadata, including:

- the displayed title (name, summary, path, or ID fallback);
- worktree labels and paths;
- summary text;
- agent flavor and machine label; and
- the session ID.

Plain-text matching is case-insensitive and supports partial substrings. A
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

- **Date range** filters by the local calendar date of `updatedAt`. The end
  date includes the whole local day.
- **Unread only** is a transient view filter. The currently open session stays
  visible, and the filter is cleared when the page is reloaded.
- **Machine** filters can be applied when more than one machine is present.
  The selection is remembered locally in the browser and falls back to All
  when that machine is no longer available.
- **Active sessions only** hides inactive sessions but keeps the selected
  session visible.
- **Session preview limit** controls how many rows are initially visible within
  each project group. Sessions with pending requests and the selected session
  can remain visible; a project can reveal more rows in batches.
- **Session-list status** controls whether rows show the standard or detailed
  attention/status presentation.

Empty, inactive session stubs without conversation, an agent identity, or an
explicit title signal are not shown in the normal sidebar. Duplicate rows
representing the same underlying agent session are collapsed, with the live,
selected, pinned, or most recent row preferred as appropriate.

## Other Web session pickers

The other Web surfaces intentionally use related but different policies:

### Share-target picker

The `/share` picker snapshots the session list when it opens so live SSE
updates do not reshuffle the rows under the user's finger.

- With no query or date range, it shows recent active sessions, sorted by
  `updatedAt` and capped by the session preview limit.
- With a text query or date range, it searches all matching sessions,
  including inactive sessions, and keeps `updatedAt` descending order.
- It reuses the session metadata matching fields, but it does not apply the
  main sidebar's relevance ranking.

### `@` session suggestions

Composer `@` suggestions only include sessions with conversation content.
With an empty query they prefer active and recent sessions; after typing, they
use a separate title/ID/active/recency ranking. Names, directories, and
machine labels affect matching, but an empty stub is never a mention target.
