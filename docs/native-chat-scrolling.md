# Native transcript scrolling

Native-only presentation policy. No Web, Hub or REST/SSE format changes.
iOS and Android still reduce the same protocol messages; golden fixtures pin
that contract, not the native view appearance.

Plan proposals are an exception to compact tool summaries: both native clients
show the complete input document as Markdown by default, before approvals.
Android retains explicit manual folding; iOS retains its separate inspector.
Plan text joins off-main Markdown preparation before transcript publication;
stable tool IDs and normal self-sizing/anchor compensation remain unchanged.

## Behavior

- Preload when approximately one viewport from the oldest retained row.
  Short/hidden-only transcripts also request history, without another gesture.
- One older request at a time. Its `historyVersion` must reach a rendered
  layout before another page starts. Layout reports viewport demand first.
  If a tail sync invalidates a pending page, its completion rechecks demand
  without waiting for a layout acknowledgement that will never arrive.
- Preserve the current visible message ID and its offset, including movement
  while HTTP is in flight. Prepending never calls `scrollToItem`.
- Browsing history disables tail following. A fixed-height history control
  avoids loading-spinner insertion/removal shifts. “Back to latest” remains
  available even when the live tail has been trimmed out of memory.
- Retry failures after 500 ms and 1,500 ms; then require a tap. Three pages
  without display progress, or a non-advancing cursor, pause automatic loading
  without falsely announcing the beginning of the conversation.
- Leaving the preload band, leaving the screen, or returning to latest cancels
  older loading. Generation checks and a synchronous before-apply gate reject
  late responses. Epoch invalidation still forces authoritative recovery.
- A same-model return from an overlay preserves history mode. Background
  tail refreshes (including replay-gap recovery and trailing sync runs) still
  validate the server epoch. Same-epoch responses preserve a truncated history
  window; an epoch change or explicit reset replaces obsolete history.
  Explicit latest navigation can also replace it. Failed latest refreshes
  keep the retry affordance.

## Implementation

### Identity across snapshots

Native tool-group IDs are allocated once per snapshot. When a run splits,
only one resulting group inherits its old ID; new groups reserve existing
groups' historical IDs so a prepend cannot steal a later reading anchor.
Collision fallbacks are deterministic and reused on subsequent renders.
All distinct groups/tools remain present; no random or row-index identities.

The iOS collection additionally coalesces repeated deliveries of a logical
row (same ID): latest value, first position. The lookup, layout and diffable
snapshot all consume that normalized sequence; duplicate counts are logged.
This is a last-resort guard, not a substitute for distinct tool-group IDs.

### iOS

`AnchoredTranscriptList` owns a `UICollectionView` with SwiftUI hosting cells.
A custom layout retains stable-ID height estimates across snapshots, applies
offset adjustments within UIKit layout, and compensates self-sizing changes
above the viewport. Snapshot commits are serialized/coalesced. Viewport resize
keeps the live bottom pinned only while following the tail.
Visible-rectangle queries binary-search the ordered frame array, then visit
only intersecting rows (`O(log n + visible rows)`). Height changes update the
affected suffix's geometry, without allocating attributes for offscreen rows.
Attributes are cached lazily and never mutated after being handed to UIKit;
unchanged IDs/width do not rebuild geometry on a content-only refresh.

Only changed row values or widths request diffable reconfiguration. Existing
hosting roots read a shared observable renderer and the latest representable
environment; SwiftUI diffs their content without reinstalling every visible
hosting configuration. This preserves theme, Dynamic Type, locale, direction,
services, and action/value captures without an incomplete environment whitelist.
The row builder executes inside a SwiftUI body so row-owned observable reads
belong to the row. Dynamic heights still use UIKit self-sizing; no frozen-height
or measurement-result cache is introduced.

`ChatPresentationState` keeps expansion/form state outside recycled cells,
pruned to retained message/request IDs. Tool groups remain one summary display
row, without changing protocol groups. The per-chat Markdown cache
prepares new sources off-main before publication; image decoding/display
preparation also runs off-main.

iOS tool groups open a large native sheet with a lazy list of summary rows;
tool details push within that sheet. Each new presentation starts at the latest
tool, but streaming never initiates another scroll. Returning from details
retains the list position; **Latest tool** explicitly scrolls to the end. Group
summary equality excludes member results, avoiding redundant transcript cell
reconfiguration. Sidechain processes continue to use a navigation page.
The screen-level presenter resolves live group/tool IDs rather than storing a
sheet inside a recycled cell. A group root owns inspection without requiring a
selected tool; its lease lasts through dismissal. `isInspectionPresented` freezes
tail-follow intent and suppresses hidden history demand, retaining the normal ID/offset anchor through
streaming and dismissal; closing alone never forces a jump to latest. Navigation
surfaces share one chat pipeline/SSE lifetime; a covered composer cancels recording.
Normal retention/epoch rules still apply: a tool or group trimmed from the window
can be read as a labeled last snapshot, not mistaken for a live record. Missing
groups retain their last membership rather than switching to another group.
Partially loaded groups identify incomplete history without issuing hidden
history requests from the inspector.

### Android

`ChatTranscript` uses a chronological `LazyColumn`, not `reverseLayout`.
Stable keys preserve its first visible item and partial-row offset. A measured
height cache estimates the top preload distance; unmeasured rows use an
estimate. Layout acknowledgement checks visible keys against their new
indices, including equal-size bounded-window replacements.
Tail-follow intent and the consumed jump token use saved state alongside the
list position, so navigation return/activity recreation does not replay an
old jump-to-latest command or report a false tail viewport to the ViewModel.
No `layoutInfo` reads occur in transcript composition. Tail geometry is
observed through `snapshotFlow` only while following; corrections are queued
outside measurement/placement to avoid reentrant layout. Row heights use
size-change callbacks, not callbacks on every global-position change, and
unchanged viewport demand is not repeatedly sent to the coordinator.
`ChatHost` hoists the list and reading state above a nested Navigation Compose
host. Groups remain one summary row; tool/group/message/process inspectors use
full-screen native destinations. Opening inspection disables tail following,
cancels hidden history demand and dictation, and hides the IME. Back/Close alone
never jumps to latest. Session events and SSE remain owned by the conversation
host/holder, including while an inspector covers the thread and across rotation.

`ChatInspectionState` resolves live IDs and retains only selected snapshots for
trimmed tools/messages/groups. A missing group keeps its previous membership;
epoch invalidation clears selections and returns to the thread. Group browsing
starts at the latest tool once, then uses explicit navigation to latest. No
hidden history request originates in the browser. `TranscriptProjection` omits
member payloads and ordinary tool results from the transcript, retaining summary
identity through output-only updates without changing protocol groups or detail
data. Inline plan proposals retain results so diagnostics and Source stay live.

The history coordinator uses a dedicated queued Main scope sharing the
holder's lifetime, independent of its Default worker scope. Lifecycle,
viewport/layout callbacks, store observation, request completion and retry
transitions are main-thread serialized. Network/store work and the chat/
Markdown pipeline stay on workers; only the before-apply veto is atomic.

An explicitly pruned `SaveableStateHolder` retains recycled row interactions.
Markdown ASTs are prepared on the pipeline
dispatcher and cached per chat; misses parse off-main. Images retain the
existing asynchronous, cached Coil loader.

### Bounds

- Page size: **200** regular messages.
- Tail window: **400**; native history retention: **800**. This matches the
  prepend budget, preventing the next SSE event from shrinking 800 rows to
  the reference/default history limit of 600.
- Reference/default window policy remains 600 for conformance tests. The
  native override is local state, neither persisted nor transmitted.
- Existing queued-message and background-agent buckets retain their separate
  rules; 800 is not a cap on every possible display row or on heap bytes.
- Markdown caches: 800 entries and approximately 8 MiB source/AST cost budget
  each. Oversized documents render on demand but are not retained in cache.
- Not an offline archive; no cross-launch reading-position persistence.
- Android user text: inline through 8,000 graphemes / 120 source lines, otherwise
  a 2,000 / 24 preview. The full reader mounts one 4,000 / 80 page. Tool source
  mounts one 20,000 / 400 page. Paging never accumulates visited text layouts;
  original source remains available for copy/export. These are layout budgets,
  not a limit on payload bytes or the size of a single Unicode grapheme.

## Automated checks

From the repository root:

```sh
swift test --package-path ios/Packages/HapiKit
ios/scripts/test-transcript.sh

cd android
./gradlew :core:protocol:test :core:data:testDebugUnitTest :app:testDebugUnitTest
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
# Run on a dedicated test emulator; avoid installing into a personal device.
./gradlew :app:connectedDebugAndroidTest
```

The iOS script creates/deletes its own simulator. Both native workflows run
layout tests in CI. Coverage includes real UIKit/Compose variable-height rows,
bounded prepends after reader movement, tail growth while reading history,
current-row growth, recycled expansion, short/hidden-only pages, and paging
coordinator/store cancellation, retry, cursor, and retention behavior.
Stateful group-ID tests cover splits, inherited-ID collisions, prepends, and
stable recomputes. UIKit tests also verify that regrouping preserves both
groups and the existing reading anchor, plus duplicate-delivery handling.
`TranscriptRefreshTests` verifies that offscreen streaming does not reconfigure
unchanged visible cells, while visible edits resize, recycled rows see the
latest data, and equal items receive updated environments and action captures.
Debug counters also check the zero-configuration budget for ordinary context
updates; UIKit may request cells itself when layout-direction traits change.
Replay-gap tests cover same-epoch retention, epoch/reset replacement, and
trailing validation. App coordinators cover a slow invalidated page returning
after tail sync; Compose tests cover saved-screen and saved-instance-state
restoration with consumed and new jump tokens.
Android also tests Default workers against a separate UI executor across 20
acknowledged pages (including acknowledgement before request completion),
and restores group-summary anchors across navigation and saved state. API 29/36
instrumentation covers grapheme preservation, single-page long-message layout
at 200% font scale, reader restoration, and explicit-only group following.
Unit tests cover retained snapshots, output-only summary reuse, hidden history
cancellation with a late HTTP response, and the shared subscription lifetime.

These are deterministic layout regressions, not proof of release-device FPS.

Real-clock simulator measurements, CPU sampling, differential-refresh results,
and limitations: [Simulator scroll profiling](native-chat-scroll-profile.md).

### Scroll work budgets

Measured before/after this optimization with dedicated simulators/emulators
and the same 800-row debug regression probes:

| Probe | Before | After |
| --- | ---: | ---: |
| Android: whole-transcript compositions during a 1,200 px / 600 ms history scroll | 37 | 0 |
| iOS: geometry probes for 200 visible-rectangle queries | 160,000 | 3,864 |
| iOS: attributes allocated during 20 self-sizing updates | 16,000 | 21 |

`ChatTranscriptTest` uses Compose's tracer (test-only) to ensure the whole
transcript does not recompose every frame; legitimate visible-cell composition
is not suppressed. `TranscriptGeometryTests` compares indexed queries with a
linear reference across variable heights, prepends/trims, width changes and
empty windows. Debug-only counters enforce query/allocation budgets. These
counts are not elapsed-time, total-allocation, or FPS benchmarks. Release-device
frame deadlines and memory still require the profiling checklist below.

## Release-device acceptance

Use a release/profile build on iOS 17 and a recent iPhone (60/120 Hz), plus
Android API 26 and a recent Android device, including a lower-end device.

1. Replay a 10,000+ message session with mixed Markdown, long code/diffs,
   images, permissions, and tool groups in both platforms' inspectors.
   Traverse well beyond the 800-message window repeatedly.
2. Test slow dragging, fast upward flings, reversing direction during a
   request, and a response arriving during deceleration. No forced animation,
   cancelled momentum, or unexplained reading-position jump.
3. Under 200 ms / 1 s / 3 s latency, packet loss, and offline/reconnect, verify
   serial paging, bounded retries, manual recovery, and no “beginning” lie.
4. Stream into the tail while reading a partial tall row. Open/close tool
   inspectors, load images, rotate, change text size, show/hide the keyboard, and
   open/close a media overlay. Text/forms/expansion must survive recycling.
5. Return to latest after history trimming, both online and offline. A failed
   refresh must not silently claim that an old retained row is the live tail.
6. Inspect Instruments (Time Profiler / Animation Hitches / Allocations) and
   Android Perfetto FrameTimeline / memory profiler. Record frame deadlines,
   long main-thread work, and steady-state memory. Compare against baseline;
   do not infer smoothness from simulator timings or unit-test duration.

Static prepend anchor regression tolerance: 1 point on iOS / 1 pixel in the
Compose test. Fling continuity, real keyboard/accessibility interactions, and
release-device frame/memory measurements remain manual acceptance checks.

Android's opt-in `ChatFrameProfileTest` additionally probes long user-message
previews and a 200-tool group's output updates at 10 Hz, with Java/native heap
samples and `dumpsys meminfo` alongside frame metrics. Run in the profile build
on representative 60/120 Hz devices. A software emulator can validate behavior;
it cannot establish frame-rate or memory acceptance on those devices.
