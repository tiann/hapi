# Session list

HAPI's Web session list combines live session state, project grouping, search,
and local display filters. The list is designed to keep sessions that need
attention easy to find while still allowing older sessions to be searched.

## Ordering and grouping

The Hub/API provides the session list with this baseline order:

1. Globally pinned sessions.
2. Project-pinned sessions.
3. Active sessions.
4. Among active sessions, sessions with more pending requests first.
5. `updatedAt` descending as the recency tie-breaker.

The Web app then groups sessions by machine and project directory. Within a
project, pinned sessions come first, followed by active sessions and then
inactive sessions; rows with the same status are ordered by `updatedAt`.
Project groups use their pinned/active state and newest member when deciding
their position.

The detailed API contract is documented in [REST — sessions](../api/client-contract/rest.md#sessions--list--detail)
and [SSE — keep-alive noise](../api/client-contract/sse.md#keep-alive-noise).

`updatedAt` is the session activity clock used by the list and date filter. It
is different from `activeAt`: `activeAt` is the CLI connection keep-alive
clock and does not, by itself, move a session in the list. A connected session
can therefore be idle; see [active is transport liveness, not agent health](../api/client-contract/sse.md#active-is-transport-liveness-not-agent-health).

When enabled in **Settings → Display**, the optional in-progress layout moves
active sessions into Working, Pending, Active, and Idle sections. Global and
project pins remain distinct from these sections.

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
additional preference. When relevance is tied, `updatedAt` descending is used
as the tie-breaker. This means an older session with a distinctive title can
appear above a newer session that only matches a common path segment.

Search preserves the session-list structure: pinned rows remain contiguous and
project groups remain visible. Search does not apply a relevance cutoff; if a
group is collapsed, matching rows remain available when that group is
expanded.

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
- **Session preview limit** controls how many rows a collapsed project shows.
  Sessions with pending requests and the selected session can remain visible;
  a project can be expanded in batches.
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
