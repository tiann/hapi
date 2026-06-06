# Garden VR testing strategy (fork-ready)

Operator note — **max automated testing** for the Garden XR POC before moving to a dedicated repo. Upstream HAPI web has almost no 3D tests; this doc is the contract for the fork.

## Goal

Automate everything that **determines** what the operator sees and hears in VR. Reserve the Quest headset for **perception and platform quirks** only.

You will never get 100% "what I see in VR" in CI. You can get ~85% confidence from layered tests that fail before you strap the headset on.

## Testing pyramid (implement in order)

| Tier | What | Catches | CI? | Headset? |
|------|------|---------|-----|----------|
| **0** | Pure TS (layout, filters, message parse, dwell constants) | Wrong orbs, wrong text, wrong colors | Always | No |
| **1** | Hooks + timers (`useGardenAttention`, focus state machine) | Attention loop, VR gate, dwell math | Always | No |
| **2** | R3F components with mocked XR store | Panel on orb, billboard props, exit progress | Always | No |
| **3** | Offscreen WebGL golden frames (fixed camera matrices) | Scene layout regressions, missing orbs | Optional (GPU runner) | No |
| **4** | IWER / WebXR emulation E2E | Gaze hit targets, Enter/Exit VR, pointer events | Nightly or `workflow_dispatch` | No |
| **5** | Quest smoke script (human, 5 min) | Browser chrome, HRTF, comfort, perf | Never auto | Yes |

**Fork rule:** Tiers 0–2 are merge-blocking from day one. Tier 3 when Garden leaves POC. Tier 4 before any public demo. Tier 5 stays manual but scripted.

## Tier 0 — Pure logic (in repo now)

Files under `web/src/garden/utils/`:

- `sessionVisuals.ts` — `layoutPosition`, `filterGardenSessions`, `sessionColor`, `sessionLabel`
- `messageText.ts` — `extractLastMessageText` (Codex/Cursor/assistant shapes)

Run: `cd web && bun run test`

These tests are cheap, fast, and survive framework swaps (R3F → IWSDK) if utils stay framework-agnostic.

## Tier 1 — Hooks and state machines

| Hook / module | Mock | Assert |
|---------------|------|--------|
| `useGardenAttention` | `useXR` → `{ session: mock \| undefined }` | No cue when flat; cues after delay; avoids same orb twice |
| Focus dwell (future extract) | fake `delta` in `useFrame` | 1.2s threshold before `onFocus` |
| Exit pad (future extract) | fake `delta` | 2.5s before `session.end()` |

Use Vitest fake timers (`vi.useFakeTimers()`). Do **not** import Three or Canvas in Tier 1.

## Tier 2 — R3F component tests

Add `@react-three/test-renderer` (or render with `@react-three/fiber` `createRoot` on a detached canvas in jsdom — limited).

Preferred pattern:

```typescript
// AgentOrb.test.tsx — mock @react-three/xr, @react-three/drei Text
// Assert group children count, hit sphere radius args, panel mounted when focused=true
```

Mock list for component tests:

- `@react-three/xr` — `useXR`, `useXRStore`, `XROrigin`, `XR`
- `@react-three/drei` — `Billboard`, `Text`, `Stars` → passthrough `group`
- `@react-three/fiber` — `useFrame` invokes callback with `{ clock: { getDelta: () => 0.016 } }`

Test **structure and props**, not pixel output.

## Tier 3 — Golden frame snapshots

Render `GardenScene` (or isolated `GardenWorld`) with a **fixed camera** at known poses:

| Camera pose | Assert |
|-------------|--------|
| `(0, 1.6, 0)` look at origin | N orbs visible, arc symmetry |
| `(0, 1.6, 0)` yaw +90° | Side orb in frame |
| `(0, 0.3, 0)` pitch down | Exit pad ring visible |

Implementation options:

1. **Vitest + headless-gl / `@react-three/test-renderer`** — PNG hash in `web/src/garden/__snapshots__/`
2. **Playwright** — screenshot `#garden-canvas` after `page.goto('/garden?test=1&seed=sessions-fixture')`

Use a **deterministic session fixture** (mock `useSessions`) so orb count and colors are stable.

CI note: needs `ubuntu` runner with EGL/OSMesa or a self-hosted GPU box. Start with local-only (`bun run test:visual`), promote to CI when stable.

## Tier 4 — IWER / WebXR emulation E2E

`@react-three/xr` already depends on **IWER** (`iwer`, `@iwer/devui`). Use it for desktop "fake VR":

1. Dev entry: `/garden?xr=emulate` loads IWER before `createXRStore().enterVR()`
2. Playwright flow:
   - Login (or inject token)
   - Go `/garden?xr=emulate&fixture=sessions`
   - Click Enter VR (emulated session starts)
   - Simulate gaze ray onto orb bounding box (IWER dev UI or programmatic pose)
   - Assert DOM/HUD or query garden test hooks (`data-testid="garden-focused-session"`)

Kill criteria: if E2E only passes with mocks and never with IWER, delete the E2E — it's lying.

Docs: [IWER](https://meta-quest.github.io/immersive-web-emulation-runtime)

Alternative: [WebXR Emulator extension](https://github.com/MozillaReality/WebXR-emulator-extension) for manual dev; less CI-friendly.

## Tier 5 — Quest smoke (manual, required before release)

Checklist (copy into release notes):

- [ ] `/garden` shows build stamp (`GARDEN_BUILD`)
- [ ] Enter VR from Quest Browser
- [ ] At least one orb visible for active session
- [ ] Single spatial ping on attention cue (no stacked tones)
- [ ] Gaze dwell ~1.2s opens **orb-attached** panel (not head-locked HUD)
- [ ] Floor pad fills ring and exits VR
- [ ] No PWA stale cache (hard refresh if needed)

Record pass/fail + build stamp in dogfood log.

## Test data fixtures

Create `web/src/garden/test/fixtures/sessions.ts`:

- `FIXTURE_ACTIVE_THINKING_PENDING` — 3 sessions, distinct colors
- `FIXTURE_EMPTY` — all idle (expect 0 orbs)
- `FIXTURE_MAX_EIGHT` — 12 active (expect 8 after filter)

Create `web/src/garden/test/fixtures/messages.ts` — mirror shapes from voice readback tests (`contextFormatters.test.ts`).

Wire fixtures via:

- Vitest imports (unit)
- Query param `?fixture=` (E2E / visual)
- MSW or mock `useSessions` in test wrapper

## CI layout (fork repo)

```yaml
# .github/workflows/garden.yml
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: bun run test -- web/src/garden

  visual:
    runs-on: ubuntu-latest  # or self-hosted
    if: github.event_name == 'schedule'
    steps:
      - run: bun run test:visual

  xr-e2e:
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule'
    steps:
      - run: bun run test:e2e -- garden
```

Root `package.json` scripts (fork):

```json
{
  "test:garden": "cd web && vitest run src/garden",
  "test:visual": "cd web && vitest run src/garden/**/*.visual.test.ts",
  "test:e2e": "playwright test e2e/garden"
}
```

## What not to automate (yet)

- Spatial audio localization (HRTF) — manual
- Motion comfort / IPD — manual
- Quest thermal throttling — manual spot check
- Full immersive UI chrome (browser exit gestures) — manual

## Migration checklist (HAPI POC → own repo)

- [ ] Copy `web/src/garden/**` + this doc
- [ ] Copy / adapt Vitest tests (`*.test.ts`)
- [ ] Add Tier 2 component tests before first refactor
- [ ] Add `test/fixtures/` and `?fixture=` dev hook
- [ ] Add IWER dev bootstrap (`?xr=emulate`)
- [ ] Add Playwright project `garden` when hub auth story is stable
- [ ] Keep utils free of R3F imports so Tier 0 survives framework changes

## Related

- [XR multi-agent workstation vision](./2026-05-24-xr-multi-agent-workstation-vision.md)
- Voice readback tests: `web/src/realtime/hooks/contextFormatters.test.ts` (message shape parity)
