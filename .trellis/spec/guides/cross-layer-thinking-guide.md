# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:
- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:
- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary | Common Issues |
|----------|---------------|
| API ↔ Service | Type mismatches, missing fields |
| Service ↔ Database | Format conversions, null handling |
| Backend ↔ Frontend | Serialization, date formats |
| Component ↔ Component | Props shape changes |

### Step 3: Define Contracts

For each boundary:
- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

---

## Checklist for Cross-Layer Features

Before implementation:
- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens

After implementation:
- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip


## Slash Command Contract Checklist (CLI ↔ Hub ↔ Web)

When changing slash command discovery, verify:
- [ ] CLI function signature and handler wiring carry project directory context
- [ ] Hub response type includes all `source` variants used by CLI
- [ ] Web type union and filtering logic include the same `source` values
- [ ] Nested command paths are explicitly mapped to command names (e.g., `group/file.md` -> `group:file`)
- [ ] Integration check confirms `/api/sessions/:id/slash-commands` returns project commands

Reference executable contract:
- `backend/quality-guidelines.md` → `Scenario: Slash Command Cross-Layer Contract (Project + Nested)`

---

## Session-Scoped Client Cache Checklist (Web State ↔ Session Identity)

When UI state is cached across renders (e.g. `useRef`, query fallback, optimistic state):
- [ ] Is cache keyed/scoped by stable identity (`session.id`, `workspaceId`, etc.)?
- [ ] On identity change, do we reset previous identity cache before deriving fallback UI?
- [ ] Does fallback logic prevent previous entity errors/status from leaking into the current entity?
- [ ] Is loading/error tri-state evaluated after scope reset?
- [ ] Is there an integration test that covers "create new entity -> initial load -> no old cache leak"?

Typical failure pattern:
- Previous session status (`Git unavailable` or stale branch counters) remains in ref fallback while new session query is still loading.
- User sees wrong status until route remount/re-entry forces state reset.

---

## PR Automation Thinking Checklist

When running automated post-coding PR workflow:
- [ ] Did we run branch topology audit before creating PR?
- [ ] Is PR branch based on `upstream/main` instead of product-only branch?
- [ ] Before squash/rebase/PR replacement, did we create `backup/safety-*`?
- [ ] Are we only auto-fixing blocking review/PIA items (not speculative suggestions)?
- [ ] If replacing PR, was the new PR created and linked before closing the old one?

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Automated Clean PR Delivery Loop (Branch Governor + PR Autopilot)`

---

## Independent Mainline Migration Checklist

When switching from upstream-collaboration mode to independent development mode:
- [ ] Is `main` merged/rebased with intended source branch before changing remote topology?
- [ ] If rebase/merge paused, did we fully resolve conflicts before running `pull`?
- [ ] Does `main` explicitly track `origin/main`?
- [ ] Is `upstream` remote removed (or intentionally retained) with clear policy?
- [ ] Did we verify end-to-end sync (`pull --rebase origin main` then `push origin main`)?

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Independent Development Mode (Origin-only Mainline)`

---

## Branch Strategy Thinking Checklist

When deciding branch strategy for fork + upstream collaboration:
- [ ] Is there a clean upstream mirror branch (`main`) with no product-only commits?
- [ ] Are upstream PR branches created from mirror `main` instead of product branch?
- [ ] Is product development isolated to a dedicated long-lived branch (e.g., `main-custom`)?
- [ ] Is there a periodic sync plan from `main` into product branch?
- [ ] Before force-pushing `origin/main`, did you verify unique commits that may be lost?

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Branch Topology for Upstream Collaboration + Custom Product Line`

---

## Monorepo Workspace Dependency Checklist (Build Path)

When fixing build failures in a Bun workspace monorepo (`web`/`hub`/`cli` + shared package):
- [ ] Does every imported workspace package name exactly match the producer package `name` field?
- [ ] Did you run dependency installation at repository root after rename or workspace metadata changes?
- [ ] Is the dependency link visible from the consumer (`web/node_modules/<pkg>`) before diagnosing bundler config?
- [ ] If Vite/Rollup says "failed to resolve import", did you verify package linking first (before alias/external workarounds)?
- [ ] Is there a CI/local prebuild check that validates workspace links for critical shared packages?

Typical failure pattern:
- Import path in app code is correct, but workspace links are stale/missing because install step was skipped after package rename.
- Symptom appears as bundler resolution error, but root cause is dependency graph state.

Recommended fast verification:
1. Check producer package name (e.g. `shared/package.json`).
2. Check consumer dependency declaration (e.g. `web/package.json`).
3. Verify installed link in consumer `node_modules`.
4. Run root install (`bun install`) and rebuild.

---

## Global Package Manager Context Checklist (Dependency Warning Triage)

When analyzing `pnpm install -g` or other global install warnings:
- [ ] Is the warning from this project's direct dependency graph, or from unrelated global packages already present on the machine?
- [ ] Did you reproduce in a clean environment/profile before changing repository dependencies?
- [ ] Does install succeed and does the shipped CLI binary run (`--help` / basic command)?
- [ ] If warning is external and non-blocking, did you record it as monitored risk instead of forcing repo-level overrides?
- [ ] If warning is from direct dependencies, is there a concrete compatibility plan (upgrade/isolate/pin) with release impact assessed?

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Global npm Install Peer-Dependency Drift (Published CLI Package)`

---

Create detailed flow docs when:
- Feature spans 3+ layers
- Multiple teams are involved
- Data format is complex
- Feature has caused bugs before
