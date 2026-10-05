# HAPI iOS

Native SwiftUI/UIKit client for HAPI, independent of `web/` at the code level.
It shares the [client protocol](../docs/api/client-contract/index.md) and
web-generated golden fixtures in `shared/fixtures/`.

## Current capabilities

The app provides sessions/chat, approvals and questions, new sessions,
attachments, files/Git, Scratchlist, standard dictation, usage/storage,
settings and encrypted APNs notifications. It pairs with multiple hubs and
keeps one active. Session lists support machine filtering, pinning and archive;
sending to an inactive session can resume it and migrate the draft/navigation
when the returned session ID changes.

Model, permission and Codex collaboration controls follow the session's agent/capabilities;
usage/storage require the owner namespace. Rename, Delete and explicit Reopen
have API wrappers but no current iOS UI. See the [native app guide](../docs/guide/native-apps.md)
for platform differences, web-only features and everyday use.

## Requirements

- Xcode 16 or newer with Swift 6 support.
- Deployment target: iOS 17.0.
- Runtime dependencies (SPM, declared in `Packages/HapiKit/Package.swift`,
  used only by the `HapiUI` target): `swiftlang/swift-markdown` (GFM parsing
  for the custom renderer) and `raspu/Highlightr` (code highlighting, kept
  behind a protocol so it is swappable). `HapiProtocol`/`HapiClient` stay
  dependency-free.

## Build

Native chat scrolling architecture and acceptance checklist:
[Native transcript scrolling](../docs/native-chat-scrolling.md).

Open `ios/Hapi.xcodeproj` in Xcode and run the shared `Hapi` scheme, or from
the command line:

```sh
# App (simulator, no signing)
xcodebuild build -project ios/Hapi.xcodeproj -scheme Hapi \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO

# Package tests (macOS; protocol/client plus UI package tests)
swift test --package-path ios/Packages/HapiKit
```

CI runs package tests, the simulator build, and app-hosted transcript tests
on `macos-15` via `.github/workflows/ios.yml` (triggered by changes under
`ios/**` and `shared/fixtures/**`).

### Linux verification (no Mac needed)

`ios/scripts/linux-test.sh` compiles and tests the non-UI targets
(HapiProtocol + HapiClient and their test suites, including the
`shared/fixtures` golden suites) in a Swift Linux container:

```sh
ios/scripts/linux-test.sh                # full swift test in docker
ios/scripts/linux-test.sh --filter Chat  # extra args pass through to swift test
```

Requires docker; defaults to the `swift:6.1-noble` image
(`HAPI_SWIFT_IMAGE` overrides). The script rsyncs the package and the
fixtures into a repo-depth staging dir (`HAPI_LINUX_STAGE` overrides;
kept between runs so builds are incremental) and mounts it at `/work`,
so the tests' `#filePath`-relative fixture resolution works unchanged.
Always edit the real worktree files — every run re-stages them.

HapiUI (SwiftUI + swift-markdown + Highlightr) cannot build on Linux;
`Package.swift` drops the UI product/targets and their dependencies
under `#if os(Linux)`, and the script leaves those sources out of the
staging copy. The few Darwin-only APIs in HapiClient are conditionally
compiled (`#if canImport(Security)` for the Keychain store — Linux tests
use `InMemoryCredentialStore` through the `CredentialStoring` seam;
`#if canImport(CryptoKit)` for snapshot-file digests with an FNV-1a
fallback; `#if canImport(FoundationNetworking)` for URLSession types and
a delegate-based SSE transport where `URLSession.bytes` is unavailable).

### Protocol conformance fixtures

Run package tests from a full repository checkout. Test paths resolve
`shared/fixtures/` relative to `#filePath`; copying only the package loses that
context. The Linux script stages the package and fixtures at the required depth.

| Suite | Coverage |
|---|---|
| `HapiProtocolTests` | Wire decoding, mode catalogs, versioned patches, and normalize → reduce → group projections against the golden fixtures. |
| `HapiClientTests` | Pagination fixtures through the message-window controller, chat pipeline/interactions, REST requests, authentication, SSE recovery, stores and push. |
| `HapiUITests` / `HapiTests` | Renderer logic and app-hosted layout, interaction, recycling and transcript behavior on supported Apple toolchains. |

Fixture conformance pins protocol/state semantics, not identical web/native
presentation. When changing fixture inputs or generation, run
`bun run gen:fixtures` at the repo root and include generated changes; never
hand-edit fixtures. See [fixture guidance](../shared/fixtures/README.md) and
[UI development](#ui-development) for targeted app-hosted checks.

New-session directory regression checks: `ios/scripts/linux-test.sh --filter
'NewSession|RemoteDirectoryBrowser'` covers path queries and browser navigation;
`HapiTests/NewSessionDirectoryTests` covers the form's defaults, roster refresh,
offline machines and spawn validation. On a device, verify home → parent → a
project outside home, explicit workspace-root prefixes, `~/` and hidden-directory
completion, and clearing the input while machine health updates arrive. A
restored or selected offline machine stays selected until the user chooses an
online machine; its old path is never silently moved to another host.

## Pairing

The app supports multiple hubs with one active selection. See the
[auth contract](../docs/api/client-contract/auth.md) for the wire rules.

- **Manual entry:** start `hapi hub --relay`, then *Enter Manually* → HTTPS
  hub address and access token → *Pair*. The address starts empty, with a
  separate protocol menu defaulting to HTTPS; type the domain/IP and optional
  port without a scheme. Pasting a full HTTP(S) URL updates that menu. A full
  companion or web pairing link pasted into either field fills both values
  for review — only submitting the form starts a connection. For a source-tree
  `bun run dev` hub, put an HTTPS reverse proxy or tunnel in front of
  `localhost:3006`; a physical phone must reach that endpoint. The app checks `GET /health`,
  requires `protocolVersion == ProtocolVersion.supported`, exchanges the
  token with `POST /api/auth` and stores credentials in the Keychain.
- **QR scan:** the in-app scanner accepts both hub QR forms —
  `hapicompanion://bind?hub=…&code=…` and the web direct-access URL
  `https://<web>/?hub=…&token=…`. Web **Settings → Companion pairing** also
  displays the companion QR.
- **Deep link:** opening `hapicompanion://bind` presents pairing confirmation;
  an already-paired hub can be selected directly.
- **Simulator:** use manual entry because `DataScannerViewController` is
  unavailable. Camera pairing is optional on physical devices too.
- **Sign out:** home → hub menu removes that hub's credentials and falls back
  to another paired hub or pairing. A rejected access token, or a freshly
  issued JWT rejected again, triggers re-pairing. Temporary network/5xx refresh
  failures retain credentials.

The parser accepts HTTP URLs. Manual entry uses the selected protocol
(default HTTPS); HTTP must be selected explicitly or supplied in a full URL
or pairing link. The form warns that HTTP is unencrypted and may be restricted
by iOS. It never guesses HTTP for a local address or downgrades after a failed
HTTPS connection. Input acceptance is not a transport exemption.
`Hapi/Info.plist` and the project build settings declare no ATS exceptions,
including no `NSAllowsLocalNetworking`. Use HTTPS endpoints for a reliable
pairing setup; HTTP behavior remains subject to system network policy.

Manual app-layer acceptance: pair → kill/relaunch → background/foreground →
pair a second hub and switch → sign out → scan both QR forms → open a deep
link for unpaired/paired hubs. Also check that transient hub failures preserve
pairing, while a rejected rotated token shows the sign-out banner.
Manual-entry form and system-paste behavior is covered by app-hosted
`ManualPairingFormTests` and `ManualEntryPresentationTests`; pure pairing
and auth behavior is covered by the package tests; this checklist is for the
app wiring and platform interaction.

## Push notifications

End-to-end encrypted APNs push; wire details live in the
[native push contract](../docs/api/native-companion-contract.md). Official
builds use the hub's default push relay. Self-signed builds need matching
provider credentials as described below.

**How it works**

- **Registration.** After the first successful pairing the app asks for
  notification permission (standard alert/sound/badge prompt — the Android
  timing: never on a pristine unpaired install), registers with APNs, and
  sends `POST /api/devices/register`
  `{token: <hex APNs token>, platform: "ios", deviceId: <stable UUID>,
  pushKey: <base64 32-byte key>}` to **every** paired hub — each hub pushes
  independently for its own namespace. Registration re-runs on every app
  start and token rotation (cheap upsert; heals reinstalls and hub-side
  pruning), and Settings → Notifications has a manual *Re-register push*.
  Sign-out sends a best-effort `DELETE /api/devices/register {token}` from a
  credentials snapshot taken before the Keychain wipe. There is no
  background retry queue (the Android WorkManager part has no iOS
  equivalent) — the next trigger heals transient failures.
- **E2E envelope.** The hub never sends plaintext through APNs. The wire
  notification is `{aps: {mutable-content: 1, alert: <generic>},
  hapi: {v: 1, e: <envelope>}}` where `e` is
  `base64(nonce[12] || AES-256-GCM ciphertext || tag[16])` over the FCM
  data-contract JSON, keyed by this install's `pushKey` with AAD
  `hapi-push-v1`. Whether the hub delivers via direct APNs or a relay is
  entirely hub-side — the app only ever registers and decrypts.
- **Notification Service Extension.** The `HapiNotificationService` appex
  decrypts on device: reads the push key from the shared Keychain access
  group (`$(AppIdentifierPrefix)run.hapi.companion.push`,
  after-first-unlock so lock-screen pushes decrypt), swaps in the real
  title/body, stamps the action category, and stores the decrypted fields in
  `userInfo` for the tap/action handlers. Undecryptable payloads deliver
  the generic alert unchanged. The appex links nothing beyond the SDK — it
  carries an SDK-only copy of the HapiKit `PushEnvelope` decrypt, kept honest
  by the shared test vector.
- **Actions.** `permission-request` → Allow / Deny; `ready` and
  `task-notification` → inline Reply. `input-request` previews the first
  question, remaining question count and session name, with tap-to-open only
  (no approval or Reply action). Apple Watch mirrors the preview; answer on
  the phone. Handlers run in the notification
  delegate's async completion and resolve the owning hub Android-style
  (active hub first, then the roster; 404 "Session not found" / 403 = try
  the next hub) — approve/deny post `{}`, reply posts `{text, localId}`.
  Failures surface as a local notice instead of vanishing. A tap deep-links
  to the session chat; a push for the chat currently on screen is suppressed
  (the in-app SSE stream is already showing it).

**Layer map**: `HapiClient/Push/` (envelope + payload + key, Linux-tested),
`Endpoints/DeviceEndpoints.swift` (register/unregister),
`Hapi/Models/PushCoordinator.swift` (registrar + delegate + action runner),
`HapiNotificationService/` (the appex). The AES-GCM decrypt and the contract
test vector are verified by `HapiClientTests/Push/*` — structural checks run
in the Linux container, the CryptoKit vector/tamper tests on Darwin CI.

### Self-signed builds with push

1. Select a paid/organization team under *Signing & Capabilities* for both
   the `Hapi` app and `HapiNotificationService` extension. Use bundle IDs
   registered to that team. Free personal teams cannot sign push entitlements.
2. Keep the same Keychain access group in both targets:
   `$(AppIdentifierPrefix)run.hapi.companion.push`. The app also declares
   `aps-environment: development`; distribution signing determines the final
   entitlement. The extension shares the key through `keychain-access-groups`,
   not an App Group container.
3. Configure the hub with `HAPI_IOS_PUSH=apns` and `APNS_KEY_P8_PATH`,
   `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_BUNDLE_ID` matching the signed app.
   Set `APNS_ENV=sandbox` for development tokens or `production` for
   distribution tokens. Alternatively use a self-hosted push relay with
   matching provider settings. The official relay cannot send to an arbitrary
   self-signed app. See [transport configuration](../docs/api/native-companion-contract.md#transports-self-host-direct-apns-vs-official-relay).

APNs availability on a simulator depends on the host/runtime and signing
setup. Use `xcrun simctl push <simulator> <bundle-id> <payload.json>` for local
notification injection, with `hapi.e` encrypted using that install's push key.
This checks local handling, not provider delivery. Verify registration,
background/lock-screen delivery and actions on a signed physical device.

## Layout

| Path | Responsibility |
|---|---|
| `Hapi.xcodeproj/` | App, notification extension and app-hosted tests. App sources use Xcode synchronized folders. |
| `Hapi/Models/` | `AppModel` pairing/navigation, active `HubSession`, per-chat `ChatSession`, and `PushCoordinator`. |
| `Hapi/Features/` | SwiftUI screens and app models for pairing, sessions, chat, new sessions, files, Scratchlist and settings; UIKit transcript hosting. |
| `Packages/HapiKit/Sources/HapiProtocol/` | Foundation wire models, catalogs, pairing parser, versioned patches, chat reduction, message-window logic and Git parsers. |
| `Packages/HapiKit/Sources/HapiClient/` | Auth/REST/SSE, stores and disk snapshots, message windows, chat interaction, attachments, dictation, push and testable feature logic. |
| `Packages/HapiKit/Sources/HapiUI/` | Reusable Markdown, syntax highlighting, diff rendering, theme and typography. |
| `HapiNotificationService/` | SDK-only extension that decrypts APNs content using the shared Keychain key. |
| `Packages/HapiKit/Tests/`, `HapiTests/` | Package and app-hosted verification. |

The app owns navigation, lifecycle and screen presentation; HapiKit supplies
protocol, transport, testable feature logic and reusable UI. `HapiProtocol` and
`HapiClient` build without the UI dependencies on Linux.

The active hub maintains a global SSE connection; an open chat adds a
session-scoped connection. Chat event handling is ordered through the window
actor. Preserve per-hub credentials/drafts, version watermarks, resume cursors
and superseding-session navigation when changing this wiring. The transcript
uses `AnchoredTranscriptList` (`UICollectionView` with SwiftUI hosting) and
prepares Markdown off the main thread; see
[native transcript scrolling](../docs/native-chat-scrolling.md).

## Scratchlist workflow

The composer tray toggles a session-local `chat` / `scratchlist` destination.
Scratchlist mode shows one recent draft, or just a header while the input is
focused or when using accessibility text sizes, and an explicitly labelled
**Save draft** action. Tap the header to open the full list, or × to return to
chat. Closing the drawer preserves input; taking a draft or accepting a queue
send returns to chat mode. The queue remains a
separate, automatically delivered surface.

Text and attachments park as one snapshot. Failed saves retain input and
retry the same entry ID. Taking a saved attachment creates a borrowed hub
reference, without resuming the session; an explicit chat send stages it to
the active/resumed session's upload directory. Queue actions do not consume
the composer and use a stable local ID for the saved entry version. A failed
post-acceptance deletion retries removal only. The full inventory uses one
navigation stack for reading and transactional editing, with discard guards
and editor identities protecting against late uploads.

Inventory rows show two lines of text, an attachment count, **Take draft** and
a menu for queueing, editing, copying and deleting. Pull down for search
(including attachment filenames); full filenames and relative timestamps live
in the detail view. The editor's + menu offers photos and files. Empty states
and routine chrome avoid explanatory paragraphs; failures stay inline with
their recovery action, without a duplicate toast.

Regression suites: package `ScratchlistComposerWorkflowTests`,
`ScratchlistAttachmentFlowTests`, `ScratchlistStoreTests` and
`ComposerAttachmentsTests`; app-hosted `ScratchlistScreenModelTests` and
`ScratchlistPresentationTests` (including transcript-anchor preservation).
The presentation suite attaches light/dark, compact, accessibility, inventory
and editor renders. Manually check keyboard/VoiceOver, conflict choices,
photo/file retry, and inactive-session sending on a connected device.

## UI development

### Localization catalog

`Hapi/Resources/Localizable.xcstrings` is **manually managed**, including every
entry's `"extractionState" : "manual"`. Keep `SWIFT_EMIT_LOC_STRINGS = NO` for the
app/extension in Debug and Release. That setting disables compiler extraction;
it does **not** prevent the Xcode editor from synchronizing or saving a catalog.
Unspecified ownership can still turn entries into `stale` during synchronization.

Use Xcode's native catalog formatting (key order, spacing, escaping), not a
generic JSON formatter. After adding or editing translations, run from repo root:

```sh
python3 ios/scripts/localizations.py --check   # read-only ownership check; no Xcode needed
python3 ios/scripts/localizations.py --fix     # macOS/Xcode: mark manual, normalize native format
```

The normalizer uses `xcstringstool` on a temporary copy, verifies that all keys,
translations, plural variations and comments survive, and writes only if needed.
It never deletes real entries: review/remove unwanted auto-extracted additions
before `--fix`, rather than silently making them permanent. Keep dynamic values
and decorative text verbatim in SwiftUI where they are not localization keys.

CI checks manual ownership, tests normalization idempotence, and verifies that
building/testing does not rewrite the catalog. Formatting is delegated to the
installed Xcode rather than reimplementing its ordering in Python; `--check`
does not enforce one Xcode version's byte-level formatting on another version.

After migrating an existing checkout, use **Product → Clean Build Folder** if
Xcode still synchronizes old extraction results, then rebuild/reopen and inspect
the diff. Do not hide the file with `.gitignore`, `skip-worktree`, or restore it
unconditionally: real translation edits must remain visible and committed.

### iPad navigation and resizing

iPad uses a two-column `NavigationSplitView`: sessions in the sidebar and a
separate detail navigation stack for chat → files/viewer/process pages. The
sidebar requests 280–360pt (320pt ideal); the system collapses the same view
hierarchy in compact windows. iPhone keeps its single `NavigationStack`.
Cold starts and hub switches show **Select a session** until the user chooses
one; notifications and new sessions can open an ID before its list row arrives.
Selection and nested navigation are in memory, not restored across launches.

`SessionNavigationState` owns selection, detail path and column visibility;
neither window geometry nor sidebar filters may clear them. Reopening the
selected session preserves its file page. A different/superseding session resets
the entire detail stack, but a late superseding callback cannot replace a chat
the user has since selected. Only explicit removal events or successful archive
operations clear the current selection, never optimistic list removal/rollback.

The detail's identity is hub/session-based, so resizing preserves the existing
chat, draft, attachment tray and transcript anchor. Native menus/sheets remain
native; the hub sign-out and attachment dialogs are anchored to their buttons.
The explicit scene manifest disables additional HAPI windows, **not** Split
View/Stage Manager with other apps. Do not enable scene-manifest generation
(which generates multiple-scene support) or require full screen. Multiwindow,
third-column inspectors, keyboard shortcuts and drag/drop are not implemented.

`SessionNavigationTests` covers navigation/removal policy and the built scene
manifest. `SessionSplitPresentationTests` runs on an actual iPad simulator and
uses the production split shell/list plus a real, non-networked chat specimen:
selection, compact programmatic opening, nested Back, filtering, resizing,
reading anchors, draft/attachment retention and surface/subscription lifetime.
CI keeps the iPhone suite and adds iPad Air 11-inch (M2). Run it locally with:

```sh
HAPI_TEST_DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2 \
  ios/scripts/test-transcript.sh \
    -only-testing:HapiTests/SessionNavigationTests \
    -only-testing:HapiTests/SessionSplitPresentationTests
```

Optional specimens: set `TEST_RUNNER_HAPI_IPAD_CAPTURE` to a **new temporary
directory**; these are synthetic test conversations, not release screenshots.
Before release, manually verify mini/11/13-inch portrait and landscape,
one-third/half-screen and Stage Manager resizing, keyboard docking/floating and
hardware-keyboard transitions, light/dark, Chinese/English, Dynamic Type and
VoiceOver. Check settings/new-session/Scratchlist/inspection sheets while
resizing, notification navigation, and background/foreground reconnection.

### Reading typography

`HapiUI` separates color palettes (`HapiTheme`) from resolved Dynamic Type
metrics (`HapiTypography`). Install `.hapiTypography()` at a presentation root,
outside `AnchoredTranscriptList`; hosted rows inherit those metrics. Do not
scale the resolved values again. Body/user/composer text starts at 16pt,
inline code at 15pt, code/diffs/terminal at 14pt, and captions at 12pt.
Body and code add 3pt and 2pt of scaled inter-line spacing respectively.

The transcript and composer share a centered, at-most-720pt reading column
with 16pt minimum side margins. Font, Bold Text, locale, and effective width
changes invalidate height measurements while preserving the reading anchor.
Ordinary streaming updates retain unchanged hosting roots and measurements.

User messages stay fully expanded through 8,000 characters and 120 source lines,
even when they span multiple screens. Only larger payloads fold to a preview
bounded to 2,000 characters / 24 lines. The folding threshold is separate from
the preview budget; both bound the actual text passed to layout. **View full
message** opens a screen-owned reader with one 4,000-character / 80-source-line
part mounted at a time, previous/next navigation, and exact full-content copy.
Paging preserves Unicode and whitespace without scanning the entire payload on
open. The reader survives cell recycling and pauses hidden history/tail following;
closing it preserves the reading position. Stored/sent messages are never truncated.

The UIKit transcript suite covers typography changes, recycling, shrinking
text, tablet/phone widths, and tail following. Optional deterministic visual
specimens cover light/dark/OLED, mixed Chinese/English, code, tables, diffs,
approvals, and the actual composer. They use a non-networked test interactor;
they are **not** live conversations or App Store screenshots. Capture into a
new temporary directory, never over the release gallery:

```sh
TEST_RUNNER_HAPI_TYPOGRAPHY_CAPTURE=/tmp/hapi-typography-review \
  ios/scripts/test-transcript.sh -only-testing:HapiTests/TypographySnapshotTests
```

### Session settings

The chat gear presents a single-page model/effort and permission/collaboration
form. All selections use native menus; permission explanations, high-risk
indicators, model-loading/retry states and update feedback remain in the form.
Changes apply immediately; Done only dismisses. On regular-width windows the
production toolbar button anchors an iPad popover; compact windows adapt that
same presenter to a medium/large sheet (large for accessibility text).

Run the configuration and real-presentation tests on both phone and tablet:

```sh
ios/scripts/test-transcript.sh \
  -only-testing:HapiTests/SessionConfigTests \
  -only-testing:HapiTests/SessionConfigPresentationTests

# Pick a device type supported by your installed runtime:
# xcrun simctl list devicetypes
HAPI_TEST_DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB \
  ios/scripts/test-transcript.sh \
  -only-testing:HapiTests/SessionConfigTests \
  -only-testing:HapiTests/SessionConfigPresentationTests
```

The script creates and deletes an isolated simulator. Set
`TEST_RUNNER_HAPI_SESSION_CONFIG_CAPTURE` to a new temporary directory for
non-networked specimens (not App Store screenshots). A widened phone window
is not a substitute for the native iPad anchor test. For AXe-driven menu and
Done checks, run only
`SessionConfigPresentationTests/testNativeDevicePresentationIsAnchoredOnIPadAndAdaptsOnIPhone`
with `TEST_RUNNER_HAPI_SESSION_CONFIG_INTERACTIVE_SECONDS=180`; leave the panel
open when the pause ends. Manually check rotation and Split View/window resizing,
menu checkmarks and risk announcements, and that closing preserves the chat's
draft and reading position.

### Tool inspection

Inline approvals use a neutral card with a quiet pending/submitting/handled
status, a full-input link, and adaptive action rows. `ChatActionButtonStyle`
owns the complete 44pt minimum target (10pt corners); do not add system bordered
button padding or another minimum label height. Approvals, question navigation
and plan actions share only this style, never their submission semantics.
Queued-message actions also keep 44pt targets and stack when the column is too
narrow. Native alerts, sheets and form controls retain their system styling.

`PermissionActionPresentationTests` covers flavor gates, action geometry, busy
and already-handled states, failures, themes and large text. To capture isolated,
non-networked approval specimens, set `TEST_RUNNER_HAPI_APPROVAL_CAPTURE` to a
new temporary directory and run it through `ios/scripts/test-transcript.sh`.

Plan proposals (`ExitPlanMode` / `exit_plan_mode`) are reading documents, not
activity summaries: their complete `input.plan` Markdown stays visible in the
conversation, before any approval controls. The same renderer is used in the
inspector; null output does not show a misleading "No output" placeholder.
Shared Codex proposals expose **Implement plan** and **Continue planning** only
when the active session's `agentState.codexPlanProposalId` matches the tool-call
id. Implementation uses the dedicated plan endpoint, not permission approval;
continue hides that proposal’s action menu locally and focuses the composer,
preserving its draft and plan mode without sending a message. The plan document
remains readable, and a new proposal gets a fresh menu. Pending/error state
survives row recycling. Withdrawn, historical and child proposals stay read-only
(an outstanding operation/error can still be shown).
Plans are prewarmed in the chat Markdown cache and never use the ordinary
tool-output preview/paging budget. The inspector retains raw fields under Source.

Tool summaries open a native large sheet instead of expanding their output
inside the conversation. Tool groups also stay as one summary row: tapping one
opens a native lazy list in the same inspector. Calls remain chronological, with
each new presentation initially positioned at the latest tool. Streaming never
scrolls the list; **Latest tool** explicitly returns to its end. Details push
inside the same sheet, retaining the list position on Back. Both levels keep a
toolbar Close action and native swipe dismissal. The inspector resolves stable
group/tool IDs from live data; output-only changes do not reconfigure unchanged
group summaries in the transcript. Group headers prioritize total calls over
category counts.
File/image summaries show the action and basename; commands use a bounded preview.
Success is quiet, while running/errors remain visible; every row keeps a 44pt target.
Edits show their recorded input, with a separate **View current file** action.
Task/Agent sidechains open a process page; approvals and question answering remain in
the conversation/process, not in the read-only inspector.

Question inspectors show recorded selections, custom answers and notes with
Markdown questions/options. `request_user_input` also restores answers from
historical results; live permission answers take precedence. Answered cards
avoid duplicate results, but retain errors and the full input/result/answers
under **Source**. Answer submission remains in the conversation.

Synchronous questions use a dedicated inline card, not the orange approval
footer. Only one question is shown at a time: single-selection taps advance
to the next question, while multiple-selection and text questions use **Next
question**. **Previous question** retains all choices and notes; the last step
always requires **Submit answer**. Recommended labels are display-only badges,
never default selections or rewritten wire values. Other-answer/note fields
expand on demand; text-only questions and prefilled drafts show them immediately.
Codex choice questions with `isOther: true` also offer **None of the above**.
Selecting it stays on the current question and focuses optional notes; empty
notes are valid. Its wire value remains `None of the above` in every language,
and recorded answers/notes appear in summaries and details. Requests without
`isOther` (including Pi and MCP forms) keep their existing choices.
All form state survives transcript-cell recycling for the retained request.
Successful records collapse to answer summaries; missing recorded answers are
shown as handled, not inferred from local drafts. Ordinary approvals retain their approval footer.

Question tests include pure navigation/answer-building checks and app-hosted
layout/recycling specimens (fake data; no live agent or saved credentials):

```sh
TEST_RUNNER_HAPI_QUESTION_CAPTURE=/tmp/hapi-question-review \
  ios/scripts/test-transcript.sh -only-testing:HapiTests/QuestionAnswerDraftTests \
    -only-testing:HapiTests/QuestionCardPresentationTests
```

Inspection pauses transcript tail-following and hidden history paging, without
opening another SSE subscription. Closing returns to the reading anchor;
opening/closing at bottom does not itself show **Back to latest**. The button
appears when the transcript is far enough from bottom (or the live tail has been
trimmed), and explicitly resumes following. Trimmed records remain visible as
labeled, read-only snapshots; missing groups retain their last membership,
without switching to another group. Incomplete history is labeled and can be
loaded from the conversation after closing the inspector. Large text is loaded
in 20,000-character parts and can be copied in full; large diffs use paged source
instead of eager rows.

The inspector recognizes namespaced command/script/patch calls. File reads use
source-language highlighting; web/agent prose uses Markdown (large documents
fall back to paged source). Common nested result envelopes are unwrapped, with
command exit/status metadata kept visible. **Source** reveals the original
input/result, including fields not shown in the preview; mixed text/media
results stay JSON instead of losing non-text blocks.

The app-hosted suite covers selection, live updates, native sheet presentation,
2/42/240-call lists, initial positioning, detail navigation, surface handoffs,
Unicode paging, and reading-position preservation. Native swipe gestures and
release-device animation smoothness still need manual acceptance. Transcript
specimens run the real ChatModel/ChatTranscriptView with fake HTTP and closed
loopback SSE; sheet specimens are non-networked. Both use deterministic test
records, not live sessions or App Store screenshots. Capture into a fresh directory:

```sh
TEST_RUNNER_HAPI_TOOL_CAPTURE=/tmp/hapi-tool-review \
  ios/scripts/test-transcript.sh -only-testing:HapiTests/ToolInspectionPresentationTests \
    -only-testing:HapiTests/ToolTranscriptPresentationTests
```

### Home filtering

Home keeps a fixed Sessions title: hub switching on the leading edge,
Filters and New Session on the trailing edge. The native menu currently
offers machine single-selection; only applied filters add a summary line.
Filters are transient per home/hub and never select a new session's machine.
Options/counts come from all session summaries, including historical machines;
the online roster supplies names only. Missing names use a labeled short ID.
Session-count updates do not reorder options or reset the list's scroll position.

App-hosted filter tests use observable in-memory stores (no network or pairing).
Optional layout captures are test specimens, not live or App Store screenshots:

```sh
TEST_RUNNER_HAPI_HOME_CAPTURE=/tmp/hapi-home-review \
  ios/scripts/test-transcript.sh -only-testing:HapiTests/SessionListFilterTests \
    -only-testing:HapiTests/HomeFilterPresentationTests
```

## Notes

- The `hapicompanion://` URL scheme is registered via `Hapi/Info.plist`,
  alongside the camera (QR pairing + attachment capture) and microphone
  (dictation) usage strings; everything else is generated through
  `GENERATE_INFOPLIST_FILE` + `INFOPLIST_KEY_*` build settings. The modern
  out-of-process `PhotosPicker` needs **no** photo-library permission, so
  there is no `NSPhotoLibraryUsageDescription`.
- `run.hapi.app` is the bundle id; signing is `Automatic` and CI builds
  with `CODE_SIGNING_ALLOWED=NO`.
- CI uses the runner's default Xcode; each job prints `xcodebuild -version`
  first so failures are attributable to a toolchain bump.
