# Plan: session ↔ branch association

**Status:** draft  
**Owner:** hapi orchestrator session  
**Filed:** 2026-06-06  
**Trigger:** during the 2026-06-06 post-upstream-sync driver rebuild, the orchestrator could not map any of the 7 active feature branches to its owning peer session. Manifest layers referenced 7 branch names that no longer existed; 2 branches had been renamed; 2 were "fork-only with no PR" and the owner-context was unrecoverable. None of this was visible from the session record itself.

## Why

The `~/.hapi/hapi.db` `sessions` table stores `metadata.path` (worktree dir) and `metadata.name` (operator-assigned label), but **does not record which branch / manifest layer a peer owns**. Consequences observed today:

- 80c7e072 named "Peer: #737 Mermaid - awaiting merge" — owning branch (`feat/mermaid-lightbox-737`) only inferrable from the freetext name
- e6abc66e named "katex bug in message display" — owning branch (`fix/markdown-single-dollar-katex`) inferrable but **not by automated query**
- 1dc1a0dd named "PR798 scratchlist" — same story
- All other peers had `metadata.path = ~/coding/hapi` (the mirror root, not the per-feature worktree), so even path-based lookup failed

The orchestrator's options today:
1. Read every session name and pattern-match against branch names (fragile, fails on rename, requires AI judgement)
2. Ask the operator to manually map session → branch (slow, lossy on memory)
3. Ping the wrong peer about a rebase task

All three are bad. The manifest staleness we hit today is the *symptom* — the *disease* is the missing link.

## Proposal

Add **one optional field** to session metadata: `metadata.layer = "<branch-name>"`. Three change-points:

### 1. Schema (hub/src/protocol/types.ts or equivalent)

```typescript
// session metadata extension - all optional
metadata: {
  // ...existing fields...
  layer?: string         // git branch this session owns (e.g. "feat/mermaid-lightbox-737")
  manifestLayer?: boolean // if true, layer is currently in driver-manifest.yaml
}
```

No schema migration needed if metadata is a freeform JSON column (current shape). Existing sessions stay valid.

### 2. Peer-spawn writes it (cli/src/commands/spawn* or wherever peers are launched)

When a peer is spawned with intent to work on a feature branch:

```typescript
// pseudocode
await hub.createSession({
  name: opts.name,
  flavor: opts.flavor,
  path: opts.workspace,
  layer: opts.branch  // <-- NEW
})
```

For peers that already exist when this lands: a one-time backfill script (see #4 below).

### 3. Driver-rebuild script queries it

Replace today's brittle "grep manifest for branch X, hope it's still there" pattern with a clean SQL query:

```bash
# orchestrator: "who owns the mermaid layer?"
sqlite3 ~/.hapi/hapi.db "
  SELECT id, COALESCE(json_extract(metadata, '\$.name'), '(unnamed)') AS name
  FROM sessions
  WHERE json_extract(metadata, '\$.layer') = 'feat/mermaid-lightbox-737'
  ORDER BY updated_at DESC LIMIT 1
"
# -> 80c7e072  "Peer: #737 Mermaid - awaiting merge"
```

The orchestrator now has a 1-line "ping the layer owner" path: 

```bash
hapi-ping-peer "$(hapi-layer-owner feat/mermaid-lightbox-737)" "Please rebase your branch against fresh upstream/main..."
```

### 4. Backfill (one-shot script)

`scripts/tooling/hapi-backfill-session-layers.sh` — heuristic matcher run once:

1. Pull current sessions list
2. For each session with `metadata.name` mentioning a branch-name token (`mermaid-lightbox-737`, `markdown-single-dollar-katex`, etc.), set `metadata.layer` to that branch
3. For each session with `metadata.path` pointing to a worktree (e.g. `~/coding/hapi/worktrees/<name>`), look up that worktree's branch and set `metadata.layer`
4. Dry-run mode default; operator confirms each match before write

### 5. driver-manifest sanity check (defense-in-depth)

`hapi-driver-rebuild` adds a pre-flight: for each manifest layer, look up its owning session(s). If a layer has no owner, warn with `[orphan layer: $branch - no session knows about it]`. Doesn't block, just surfaces drift before it bites mid-rebuild.

## Non-goals (this round)

- Mandatory `layer` field. Stays optional. Peer-spawn that doesn't know its layer (e.g. a peer working across many branches) writes nothing.
- Multi-layer ownership. A session owns 0 or 1 layer in this design. If we hit multi-owner later, expand to an array.
- Auto-discovery of layer renames. If a branch is renamed, peer-spawn at the new branch creates a new layer string; old session's layer reference goes stale. Handled by the backfill + sanity-check loop.

## Implementation order (when this plan is picked up)

1. Schema update + spawn-side write (small, in hub + cli)
2. Backfill script (one-shot, low risk)
3. driver-rebuild sanity check (additive)
4. `hapi-layer-owner` helper script (3 lines, sqlite query)
5. Update `docs/operator/repo-layout-and-dev-flow.md` to describe the new flow
6. Update orchestrator playbook in `docs/operator/AGENTS.md` to reference `hapi-ping-peer + hapi-layer-owner` for rebase coordination

## Effort estimate

S - one focused session. The hard work is the spawn-side wiring (which peer-spawn paths exist?). Schema and tooling are trivial.

## Open questions

- Where do peers actually get spawned from? `cli/src/commands/spawn*`? Web UI new-session form? Both?
- Is there a convention for branch-naming in peer spawns today, or is it freeform?
- Should layer also include manifest-rank (e.g. "this peer owns layer 3 of 11") for ordering-aware ping?
