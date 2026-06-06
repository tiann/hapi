# Garden idea: mindmap orientations for agent groupings

Captured 2026-05-25. **Not canon** — backlog / design note.

## Idea

Replace (or augment) the flat **arc of orbs** with **mindmap-style spatial layout** so active agents show **relationships and groupings** at a glance — not just a sorted list in 3D.

Operator should feel *where* agents belong in a project graph, not only *that* they exist.

## What it might look like in VR

- **Root / you** near origin (or implicit — camera is the root).
- **Group hubs** — platonic or glyph nodes for repo, machine, worktree, flavor, or custom tag.
- **Agent orbs** hang off their group on **spokes** (branch length = recency or activity).
- **Sibling agents** share a parent angle sector; **cousins** on distant branches.
- **Cross-links** — thin lines or pulses between orbs that share files, parent session, or recent handoff (when hub exposes it).

```
                    [infra cluster]
                   /      |      \
              orb A    orb B    orb C
                 \        |        /
                  \   [hapi repo] /
                   \      |      /
                    --- YOU ---
                         |
                    [garden XR]
                         |
                      orb D
```

Orientation is **semantic**, not cosmetic: turning left = "same repo family"; behind you = idle backlog; forward arc = hot / needs attention.

## Signals we already have (or could derive)

| Signal | Grouping use |
|--------|----------------|
| `metadata.path` | Repo / directory cluster |
| `metadata.machineId` | Machine / host island |
| `metadata.worktree` | Branch / worktree subtree |
| `metadata.flavor` | Agent type (claude/codex/gemini) — shape or sub-cluster |
| `metadata.summary.text` | Optional label on group node |
| Attention / permission / thinking | Pulse on **branch** or **orb** (existing state glyphs) |
| Future: explicit `parentSessionId`, tags, project id | True graph edges |

## Interaction (fits existing gaze grammar)

- **Dwell orb** — focus + voice (unchanged).
- **Dwell group hub** — expand/collapse subtree; or filter world to that group only.
- **Sticky attention** — branch stays highlighted until resolved (see r3f-v9+ attention model).
- **Voice:** "show me everything on hapi" → camera eases / fades non-matching groups.

## Why VR (not a flat mindmap app)

- **Peripheral layout** — groups can sit behind / beside without competing for monitor pixels.
- **Shape + color + position** triple-encoding (platonic solids + mindmap = Tron CLU territory).
- **Spatial memory** — "the red cube on the left branch" beats tab #4.

## Open design fights

1. **Auto-layout vs pinned layout** — force-directed on each SSE update vs operator-drags-group once, saved in localStorage.
2. **Max readable groups** — Miller still applies; collapse to ~5–7 top-level hubs.
3. **Drift from hub truth** — layout is client interpretation; grouping keys must come from hub metadata, not Garden-only fiction.
4. **Single vs multi-root** — one operator vs shared garden room (future).

## Suggested build order (after current orb POC stable)

1. **Cluster by `metadata.path` dirname** — replace `layoutPosition()` arc with tree layout (same orbs, smarter positions).
2. **Group glyph nodes** — empty parent meshes + labels; orbs parented in Three.js groups.
3. **Saved layout prefs** — per tailnet user, optional pin/rotate whole map.
4. **Edges** — only when hub exposes explicit relationships; don't fake edges from guesswork.

## Related

- [XR multi-agent workstation vision](./2026-05-24-xr-multi-agent-workstation-vision.md)
- `web/src/garden/utils/sessionVisuals.ts` — today's arc layout
- Platonic orb shapes (r3f-v10) — group nodes could use **dodecahedron** (container) vs **sphere** (agent)

## Friction / kill criteria

- If **sort-by-urgency arc** is enough for ≤4 agents, mindmap is polish until N≥6 regularly.
- Kill auto mindmap if layout **changes every SSE tick** — operator nausea; layout must be stable or animated slowly.
