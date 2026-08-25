# HAPI iOS (native companion)

Native SwiftUI client for HAPI. Fully independent of `web/` at the code level;
it shares only the protocol contract (`docs/api/`) and the golden fixtures
(`shared/fixtures/`, produced by the consistency track).

## Requirements

- Xcode 16 or newer (iOS 17 SDK).
- Deployment target: iOS 17.0.
- Runtime dependencies (SPM, declared in `Packages/HapiKit/Package.swift`,
  used only by the `HapiUI` target): `swiftlang/swift-markdown` (GFM parsing
  for the custom renderer) and `raspu/Highlightr` (code highlighting, kept
  behind a protocol so it is swappable). `HapiProtocol`/`HapiClient` stay
  dependency-free.

## Build

Open `ios/Hapi.xcodeproj` in Xcode and run the shared `Hapi` scheme, or from
the command line:

```sh
# App (simulator, no signing)
xcodebuild build -project ios/Hapi.xcodeproj -scheme Hapi \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO

# Package tests (also runs on macOS, the package is pure Foundation)
swift test --package-path ios/Packages/HapiKit
```

CI runs both on `macos-15` via `.github/workflows/ios.yml` (triggered by
changes under `ios/**` and `shared/fixtures/**`).

### Localization catalog

`Hapi/Resources/Localizable.xcstrings` is hand-maintained. Compiler string
extraction stays disabled so opening or building the project does not rewrite
the catalog with decorative or intentionally verbatim strings.

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

## Layout

```
ios/
  Hapi.xcodeproj/        Hand-rolled minimal project (objectVersion 77).
  Hapi/                  App target sources. This is an Xcode 16 "synchronized
                         folder": add files here and they join the target
                         without touching project.pbxproj. As of M2a:
                           Models/    AppModel (pairing state machine, hub
                                      switching, deep-link routing, scene
                                      phase) + HubSession (per-active-hub
                                      APIClient/AuthManager/global SSEClient,
                                      connection state, the M2a stores —
                                      session list / machines / last-seen —
                                      the SyncEventRouter feeding them, the
                                      M2f message-window registry, and the
                                      per-chat session factory) + ChatSession
                                      (M2f per-open-chat wiring: session-scope
                                      SSEClient with kept resume cursor,
                                      window open/activate/tail-sync, ordered
                                      event routing — one consume task,
                                      every event awaited to the window
                                      actor before the next — gap-handshake
                                      full resync + detail refetch + catch-up
                                      tail sync, scene-phase suspend/resume).
                           Features/  Pairing/ (welcome, VisionKit QR scan,
                                      manual entry, shared confirm + error
                                      states), Home/ (session list host with
                                      hub switcher + connection dot in the
                                      toolbar), Sessions/ (SessionListView:
                                      status dot with thinking pulse, title
                                      cascade, flavor·machine·worktree meta,
                                      pending/todo badges, unread dots,
                                      pinned section, machine filter chips,
                                      pull-to-refresh, long-press
                                      pin/archive; row taps push the chat),
                                      Chat/ (M2f read-only chat: ChatModel —
                                      window state + session detail →
                                      ChatPipeline off-main, ~100 ms
                                      coalesced, last-seen stamping, header
                                      cascade; ChatView — bottom-anchored
                                      ScrollView/LazyVStack with auto-stick,
                                      new-messages pill, top sentinel paging
                                      with scroll re-anchoring, degraded
                                      banners; Blocks/ — user bubble, agent
                                      markdown, reasoning, tool cards with
                                      per-tool bodies + knownTools-parity
                                      presentation, tool groups, event rows,
                                      cli output, generated images with
                                      full-screen viewer, codex review;
                                      M3ab upgrades: pending permission cards
                                      grow the approval footer — Allow/Deny,
                                      codex Allow/Abort, overflow
                                      allow-for-session / allow-all-edits,
                                      AskUserQuestion option cards + Other
                                      free text, request_user_input fields
                                      with user_note — and failed user rows
                                      become tap-to-retry; Composer/ —
                                      multiline input with long-press
                                      "Send & steer" while thinking, abort
                                      button, the A-M3f attachment tray
                                      ("+" → photo library / camera / files
                                      pickers; upload-on-pick chips with
                                      spinner / thumbnail / tap-to-retry,
                                      ✕ removes; attachments-only sends
                                      allowed) and mic dictation (recording
                                      chip with elapsed + cancel,
                                      AVAudioRecorder m4a/AAC → hub
                                      transcription, transcript appended to
                                      the draft), and the queued-messages
                                      bar with Steer/Edit/Cancel;
                                      Attachments/ — pick preparation
                                      (capped reads, ImageIO downscale of
                                      >4 MB images to 2048 px JPEG, 512 px
                                      previewUrl thumbs), camera capture,
                                      and user-bubble previewUrl thumbnails
                                      (off-main decode, also for web-sent
                                      attachments); SessionConfigView —
                                      the toolbar-gear sheet for permission
                                      mode / model / effort per flavor),
                                      Scratchlist/ (A-M4b per-session parked
                                      notes, a sheet off the chat toolbar's
                                      note icon with entry-count badge: entry
                                      cards — 4-line preview, relative age,
                                      authed attachment thumbnails/filename
                                      chips — edit sheet with PhotosPicker →
                                      guard → JPEG downscale → upload spinner
                                      tile, full-screen attachment viewer,
                                      per-entry "To composer" insertion, and
                                      "Park current draft" in the screen
                                      header — a deliberate placement
                                      divergence from Android's composer
                                      button, since the composer UI is owned
                                      by the attachments package; the store +
                                      guard live in HapiKit),
                                      Links/ (app-wide \.hapiOpenURL handler:
                                      https/http → SFSafariViewController,
                                      confirm-first schemes → alert,
                                      hapi-file:// → the session file viewer
                                      when a chat installed its opener, else
                                      an explanatory alert),
                                      Files/ (A-M4a session files browser off
                                      the chat toolbar folder icon:
                                      Changes/Browse/Search segmented tabs —
                                      branch header incl. detached, staged/
                                      unstaged sections with status letters +
                                      ±counts and degraded-numstat banner;
                                      lazy directory outline with hidden
                                      toggle and dirs-first sort; debounced
                                      ripgrep search — and the single-file
                                      viewer: diff ⇄ full toggle with
                                      staged/unstaged sides and web-parity
                                      auto-fallback, markdown Source/Preview,
                                      images, copy path/contents, citation
                                      "Line N" hint chip; chat hapi-file://
                                      citations push it in full mode),
                                      NewSession/ (A-M3c create form, a sheet
                                      off the session list "+": machine picker
                                      with last-used preselect + health line,
                                      directory field with debounced 250 ms
                                      list-directory autocomplete (per-parent
                                      cache) + per-machine recent-path chips +
                                      exists probe (worktree-blocking /
                                      simple two-tap-create), flavor picker
                                      over CREATABLE, per-flavor options —
                                      claude model/effort/yolo; codex machine
                                      catalog (rpc_target_missing hides it),
                                      reasoning effort, native permission,
                                      collaboration + fast tier when
                                      advertised; copilot agent mode; pi
                                      managed note — session type simple/
                                      worktree + name, UserDefaults draft +
                                      prefs per hub; success dismisses the
                                      sheet and pushes the chat),
                                      Settings/ (A-M4de sheet off the home
                                      hub menu: Appearance — theme mode
                                      system/light/dark/OLED persisted via
                                      HapiClient ThemePrefs and applied in
                                      RootView (HapiUI palette +
                                      preferredColorScheme; system follows
                                      the OS, explicit modes override, OLED
                                      = dark on pure black); Language —
                                      persist-only until the M5 i18n pass;
                                      owner-gated (JWT ns == "default",
                                      fail closed) Usage dashboard — range
                                      7d/30d/all, stat tiles, Swift Charts
                                      daily BarMark chart with calendar-
                                      filled days + tap/drag day selection,
                                      byAgent/byModel top-8 bar rows — and
                                      Storage dashboard — SectorMark donut
                                      of db/wal/shm with the total in the
                                      center, legend rows with bytes +
                                      percents, path, refresh; About — app/
                                      protocol versions + hub health probe
                                      with retry).
  HapiNotificationService/
                         Notification Service Extension target (P3):
                         decrypts the E2E push envelope on device with the
                         shared-Keychain push key and rewrites the generic
                         alert — dependency-free, see "Push notifications"
                         below. Also an Xcode 16 synchronized folder.
  Packages/HapiKit/      Local SPM package with the real logic:
    HapiProtocol         Pure-Foundation protocol layer. As of M2a:
                           Models/   wire types mirroring shared/src/schemas.ts
                                     (Session, SessionPatch + VersionedValue,
                                     AgentState, DecryptedMessage, SessionSummary,
                                     Machine, SyncEvent union, messages page),
                                     plus the summary-side pure logic:
                                     SummaryPatching (sessionSummary.ts
                                     derivations + the useSSE list-patch rules
                                     with their deliberate `>=` version gate —
                                     vs the detail path's strict `>` — and the
                                     keep-alive render-irrelevance filter) and
                                     SessionSorting (the exact list order:
                                     globalPinned > pinned > active > pending
                                     desc among active > recency, stable)
                           Catalog/  permission-mode / flavor tables ported from
                                     shared/src/{modes,flavors,copilotModes}.ts,
                                     plus the static create-form option lists
                                     (claude models/efforts, codex reasoning-
                                     effort fallback — NewSessionCatalogs)
                           Patch/    versioned session-patch application ported
                                     from web/src/lib/sessionPatch.ts
                           Pairing/  BindLink — parses both pairing QR forms
                                     (hapicompanion://bind?hub=&code= and the
                                     web /?hub=&token= URL), form-decoding in
                                     lockstep with the Android port
                           Git/      A-M4a raw-git-stdout parsers ported from
                                     web/src/lib/gitParsers.ts via the tested
                                     Android twins: GitStatusParser
                                     (porcelain-v2 records + branch headers,
                                     buildGitStatusFiles merge, quirks
                                     preserved — rename tab order, UU on both
                                     sides, untracked dirs dropped) and
                                     NumstatParser (binary -\t- markers,
                                     brace + plain rename normalization,
                                     multi-spelling stats map)
                           Chat/     the chat normalization/reduction pipeline
                                     ported file-for-file from web/src/chat/**
                                     (M2b+M2c): Normalize/NormalizeUser/
                                     NormalizeAgent (decode tree incl. agy),
                                     Tracer (sidechain grouping), Reducer*
                                     (timeline, tool pairing, stream coalescing,
                                     agent-run cards, events dedupe/folding,
                                     cli-output merge), ToolGroups (+ codex
                                     exploration family), the normative fixture
                                     projection (FixtureProjection), and the
                                     JS-semantics interop layer (JSInterop:
                                     nullish coalescing, truthiness, canonical
                                     JSON serializer). Validated block-for-block
                                     against shared/fixtures/chat/** by
                                     ChatFixtureTests (one parameterized test
                                     per fixture, line-level diff on mismatch).
                           Window/   the message window state machine ported
                                     from web/src/lib/message-window-store.ts +
                                     messages.ts (M2d): MessageWindowState
                                     (cursors/epoch/generations + persisted v2
                                     snapshot shape), MessageWindowLogic (pure
                                     transitions: tail sync, older pages +
                                     epoch-mismatch reset, trims that never
                                     drop queued rows, SSE ingest, optimistic
                                     lifecycle, queued-state reconcile),
                                     MessageMerge (position order, localId echo
                                     replacement, 10 s dedup fallback) and
                                     WindowMessage (wire row + client status,
                                     tri-state invokedAt, identity-carrying
                                     class — reset preservation compares rows
                                     by instance like the web's `!==`).
                                     Retention calls the chat pipeline's
                                     normalize directly, so the two cannot
                                     drift.
    HapiClient           Transport layer. As of M1b+M1c+M1d:
                           APIClient        typed REST client (Endpoints/*):
                                            Bearer auth, 401 -> refresh ->
                                            retry-once, {error, code} parsing
                                            (APIError), 256 MB URLCache for
                                            generated images. HTTP goes through
                                            the HTTPPerforming seam, so tests
                                            inject a recording performer.
                           Auth/            JWT payload decoding, AuthManager
                                            (actor; single-flight refresh via
                                            POST /api/auth, proactive refresh
                                            10 min before exp, terminal
                                            authFailed state), Keychain
                                            credential store (per-hub records
                                            under run.hapi.companion),
                                            HubRegistry (multi-hub + active
                                            hub in UserDefaults),
                                            HubPairingService (normalize ->
                                            /health + protocolVersion check ->
                                            /api/auth -> persist; unpair with
                                            fallback), tested through the
                                            HTTPPerforming seam.
                           SSE/             actor SSEClient — handshake-gated
                                            connect (resume ok/gap surfaced),
                                            sticky per-subscription cursor with
                                            at-least-once replay, 10 s connect
                                            timeout + 90 s staleness watchdog,
                                            backoff per sse.md (1 s ×2 → 30 s,
                                            300 s after 8 attempts, 0–500 ms
                                            jitter), suspend/resume with the
                                            45 s foreground staleness check,
                                            NWPath change → immediate reconnect.
                                            SSELineParser, ReconnectPolicy/
                                            SSETimings, URLSessionSSETransport
                                            (gzip streaming-decompression
                                            verification TODO — fallback flag
                                            `acceptEncodingIdentity`).
                           MultipartEncoder for the voice-transcription
                                            endpoint (M4c).
                           Stores/          M2a @MainActor @Observable stores
                                            mirroring the Android/web
                                            semantics: SessionListStore
                                            (sorted summaries + per-id detail
                                            cache; full-session upsert
                                            preserving hub-computed scheduled
                                            fields, strict-> detail vs >=
                                            summary patch gates, keep-alive
                                            identity preservation, REST
                                            fallback for unparseable data,
                                            16 ms coalesced refresh,
                                            optimistic pin/archive),
                                            MachineStore (the machine-updated
                                            decision tree), LastSeenStore
                                            (unread watermarks + per-scope
                                            baseline), SyncEventRouter
                                            (SyncEvent fan-out + gap-handshake
                                            full resync), DiskCache (500 ms
                                            debounced atomic JSON snapshots
                                            per hub for instant cold start).
                                            Plus MessageWindowController
                                            (M2d): per-session actor driving
                                            the HapiProtocol window logic —
                                            single-flight tail sync with
                                            trailing drain, older-page loads,
                                            SSE ingest hooks, optimistic
                                            send/cancel, queued-state
                                            reconciliation (≤1000-id batches)
                                            — behind the MessagesProviding
                                            seam (APIClient conforms; the
                                            fixture harness scripts it);
                                            WindowSnapshotStore (per-session
                                            Caches snapshots, LRU 10);
                                            MessageWindowControllers registry
                                            (hydrate on open, seed across
                                            resume/reopen id changes).
                           Chat/            ChatPipeline (M2f): the actor the
                                            app's chat screen runs its
                                            reduction on — queued-row filter,
                                            normalize memoized by row instance
                                            identity, reduce + toolGroups with
                                            previousGroups-stable group ids.
                           NewSession/      pure create-form logic (A-M3c),
                                            tested against the Android/web
                                            reference: NewSessionForm (typed
                                            draft, tolerant decode) +
                                            NewSessionLogic (the exact spawn
                                            body per SpawnSessionRequestSchema
                                            incl. the per-flavor yolo/
                                            permissionMode matrix, parent-path
                                            derivation + suggestion filtering,
                                            recent-path LRU(8), worktree-name
                                            validation, codex catalog helpers,
                                            draft sanitization).
                                            Since M3ab: ChatInteractor — the
                                            per-session interaction engine
                                            (optimistic composer sends with
                                            queue/steer delivery + retry,
                                            session_inactive resume→retry with
                                            superseding-id window seed + draft
                                            migration, queued-bar
                                            cancel/edit/steer with the
                                            invoked-race reconcile,
                                            flavor-exact permission
                                            approve/deny bodies with
                                            optimistic Resolving/
                                            AlreadyHandled overrides settled
                                            by the agentState patch, config
                                            switches with optimistic detail
                                            update + reload-on-error, codex
                                            model catalog); ChatDrafts
                                            (UserDefaults per hub+session,
                                            debounced) and PermissionInputs
                                            (AskUserQuestion /
                                            request_user_input parsers).
                                            SSE/ adds VisibilityReporter:
                                            POST /api/visibility per tracked
                                            handshake subscriptionId on
                                            scene-phase flips, 404 pruning.
                           Settings/        A-M4de pure settings logic,
                                            transcribed (with tests) from
                                            the Android reference: UsageMath
                                            (formatTokens/formatBytes web
                                            thresholds, cache hit rate,
                                            calendar-filled daily bars via
                                            pure Gregorian day math),
                                            StorageMath (donut slices +
                                            half-up percents, web-geometry
                                            test-locked), OwnerGate (JWT
                                            ns == "default", fail closed),
                                            ThemePrefs/LanguagePrefs
                                            (@Observable UserDefaults
                                            persistence). Endpoints/ adds
                                            the owner-only GET
                                            /api/usage/summary and GET
                                            /api/storage/sqlite.
                                            Since A-M3f: Attachments/ —
                                            AttachmentPolicy (the pure
                                            compress/reject/preview policy,
                                            constants shared verbatim with
                                            the Android port: 4 MB image
                                            compress threshold → 2048 px
                                            JPEG q85, 50 MB hard cap, 512 px
                                            previewUrl data-URL thumbs) and
                                            ComposerAttachments (the
                                            upload-on-pick tray:
                                            uploading/ready/failed chips,
                                            retained payloads for retry,
                                            best-effort deletes on remove /
                                            mid-upload removal / discard,
                                            consume() → the send body's
                                            AttachmentMetadata); Voice/ —
                                            DictationController
                                            (idle/starting/recording/
                                            transcribing over recorder +
                                            transport seams, provider
                                            memoized from GET providers,
                                            first standard-capable entry
                                            wins) with VoiceEndpoints
                                            (GET /api/voice/transcription/
                                            providers + the one multipart
                                            endpoint POST
                                            /api/voice/transcription).
                           Files/           A-M4a testable core of the files
                                            feature behind the FilesRequesting
                                            seam (Endpoints/FileEndpoints.swift
                                            adds the six git/files REST calls;
                                            wire types in HapiProtocol
                                            Models/FilesApi.swift): FilesModel
                                            (Changes = status + parallel
                                            numstat sides merged through
                                            GitStatusParser with per-side
                                            degraded banners; Browse = cached
                                            lazy tree flattening with hidden
                                            toggle + dirs-first sort; Search =
                                            300 ms debounce, limit 200) and
                                            FileViewerModel (parallel diff +
                                            base64 file loads, staged toggle
                                            reload, image/markdown/binary
                                            classification, web-parity
                                            auto-fallback to full mode; the
                                            unified-diff emptiness probe is
                                            injected since the parser lives in
                                            HapiUI).
                                            Since A-M4b: ScratchlistStore —
                                            the per-session scratchlist cache
                                            (open/release observation,
                                            16 ms-coalesced refetch on the
                                            scratchlistUpdatedAt SSE signal
                                            via SessionListStore.
                                            onScratchlistInvalidation,
                                            optimistic create/update/delete
                                            with surgical entryId reconcile +
                                            rollback, idempotent create via
                                            client entryId, 200-entry cap
                                            pre-check + hub 409 verdict,
                                            base64 attachment upload with
                                            in-flight names, cached limits
                                            with offline defaults) and the
                                            pure ScratchlistAttachmentGuard
                                            (Fits/Downscale/Reject budget
                                            verdicts) + Endpoints/
                                            ScratchlistEndpoints and the
                                            HapiProtocol wire models
                                            (ScratchlistApi.swift); the
                                            ChatInteractor grows the
                                            scratchlist badge count and the
                                            insertComposerText /
                                            parkComposerDraft seams.
    HapiUI               Rendering foundation (M2e). SwiftUI, no app coupling:
                           Markdown/  MarkdownTransforms (string-level ports of
                                      the web remark plugins: table repair,
                                      indented-code disable, CJK autolink strip,
                                      file-path + bare-URL detection, HrefPolicy)
                                      and MarkdownRenderer (swift-markdown
                                      visitor -> block tree -> SwiftUI views;
                                      links flow through the \.hapiOpenURL
                                      environment action, workspace files use
                                      hapi-file://?path=&line= URLs)
                           Code/      CodeBlockView + SyntaxHighlighting
                                      protocol with the Highlightr engine
                                      (off-main, cached, 400-line cap)
                           Diff/      UnifiedDiffParser + DiffTextView
                                      (hunks, +/- gutters, compact/expand)
                           Theme/     HapiTheme palettes (light/dark/OLED)
                                      via the \.hapiTheme environment
                         Since M2f the app target links HapiUI and renders
                         chat prose/code/diffs through it; RootView injects
                         the palette and the \.hapiOpenURL link handler.
```

The app target stays thin; features live in `HapiKit` so they are testable
with `swift test` and free of UI concerns.

### Fixtures

`HapiProtocolTests` reads the golden fixtures from the repo-root
`shared/fixtures/` directory, resolved from the test file's own `#filePath`
(package root `ios/Packages/HapiKit` -> `../../../shared/fixtures`), so the
suite needs a full repo checkout. Since M1a, `FixtureDecodingTests` decodes
every `chat/*.json` input as `[DecryptedMessage]` (+ `AgentState`), and
`CatalogTests` verifies the ported mode tables against
`catalogs/modes.json`. Since M2b/M2c, `ChatFixtureTests` is the pipeline
gate: for every chat fixture it runs the ported normalize → reduce → group
pipeline over the stored `input`, applies the normative projection, and
compares canonical JSON byte-for-byte against the stored `expected` —
failures are per-fixture and print the first differing line with context.
Since M2d, `HapiClientTests/PaginationFixtureTests` replays every
`pagination/*.json` op script against the real `MessageWindowController`
driven by a scripted `MessagesProviding`: it asserts the exact `GET /messages`
query objects (`expectedRequests`, including the explicit-null
`untilAt`/`untilSeq` of the first catch-up request), the older-load outcomes,
the queued-state reconcile candidates, and the final window projection
(`expectedState`) — all canonical-JSON compares with the same per-op labels
and first-differing-line diffs. Since M2f, `HapiClientTests/ChatPipelineTests`
drives the app-facing `ChatPipeline` runner with fixture-derived window rows:
non-empty unique stable ids, memo-stable recomputes, the queued-row filter,
and group-id stability across an older-page arrival (`previousGroups`).
Since M3ab, `HapiClientTests/Chat/ChatInteractorTests` transcribes the
Android interaction suite against the real client stack (only HTTP is
scripted): canonical approve/deny/send/config wire bodies asserted
byte-for-byte, optimistic send happy/fail/retry, 409 → resume → retry (same
and superseding id), queued cancel invoked-race, steer reconcile, edit
prefill, permission override lifecycle, and config optimistic + rollback.
Since A-M3f, `Attachments/AttachmentPolicyTests` ports the Android policy
matrix, `Attachments/ComposerAttachmentsTests` drives the upload tray over
the real client (exact base64 upload bodies, consume/retry/remove,
mid-upload removal orphan delete, detached discard),
`Voice/DictationControllerTests` transcribes the Android dictation suite
(fake recorder + transport), `EndpointRequestTests` covers the voice
endpoints (multipart shape included), and `ChatInteractorTests` gains the
attachment-send matrix (metadata on the wire byte-for-byte, refuse while
uploading, attachments-only sends, retry with identical attachments,
remove/discard deletes).
Since A-M4a, `HapiProtocolTests/Git/*` transcribes the Android git-parser
suites (expectations produced by running the exact inputs through
`web/src/lib/gitParsers.ts`), and `HapiClientTests/Files/*` transcribes the
files/viewer model suites against a fake gateway (numstat merge + degraded
banners, lazy tree cache, search debounce, staged-toggle reload, the
auto-fallback rules, base64/image/binary classification) plus asserts the
six git/files endpoint URLs against the recording performer.
Since A-M4b, `Stores/ScratchlistStoreTests` transcribes the Android
scratchlist store suite (optimistic CRUD reconcile/rollback, at-cap 409 +
local short-circuit, SSE-invalidation refetch for observed sessions, upload
in-flight progress + typed 413, attachment delete 409/ok mapping, limits
cache/offline defaults — canonical wire bodies asserted) plus the
`SessionListStore` invalidation-seam test; `ScratchlistAttachmentGuardTests`
ports the nine budget-verdict cases; and
`Chat/ChatInteractorScratchlistTests` covers the park/insert/badge seams
against a fake store.

## Pairing (M1d)

How to pair the app with a hub (`docs/api/client-contract/auth.md` is the
contract; the app accepts multiple hubs and keeps one active):

- **Local hub, manual entry** — the everyday dev loop:
  1. Start the stack from the repo root: `bun run dev` (or just the hub). The
     hub prints its URL and the access token (`CLI_API_TOKEN`, auto-generated
     into the hub's `settings.json` on first run).
  2. In the app: *Enter Manually* → hub URL (e.g. `http://192.168.1.20:3006`
     — the phone must reach the hub's LAN address, not `localhost`; a typed
     address without a scheme gets `http://` prefixed) → paste the token →
     *Continue* → *Pair*.
  3. The app checks `GET /health` (reachability + `protocolVersion`), then
     exchanges the token via `POST /api/auth` and stores it in the Keychain.
- **QR scan** — start the hub with `--relay`: the terminal prints two QR
  codes. The scanner accepts **both** — the companion deeplink
  (`hapicompanion://bind?hub=…&code=…`, canonical) and the web direct-access
  URL (`https://<web>/?hub=…&token=…`). The web app's Settings → Companion
  Pairing screen renders the deeplink QR too.
- **Deep link** — opening a `hapicompanion://bind` link routes through the
  same confirm sheet; a link for an already-paired hub just switches to it.
- **Simulator**: camera scanning is unavailable (`DataScannerViewController`
  unsupported) — the scanner screen says so; use manual entry. Plain-HTTP LAN
  hubs work because `NSAllowsLocalNetworking` stays enabled (ATS default
  otherwise).
- **Sign out** (home → hub menu) deletes the stored token for that hub and
  falls back to the next paired hub, or to pairing. A hub that terminally
  rejects its stored token (rotated/revoked → `POST /api/auth` 401) is signed
  out automatically with a banner.

Manual test pass for the app layer (the pairing sequence itself is covered by
`PairingLogicTests` via injected HTTP fakes; `AppModel`/views are UI-bound):
pair via manual entry against a local hub → kill + relaunch (restores paired
state, SSE reconnects) → background/foreground (connection dot pauses and
resumes) → pair a second hub and switch between them → sign out of both →
scan both `--relay` QR forms → open a `hapicompanion://bind` link from Notes
(unpaired: confirm; paired: "already paired" notice) → rotate
`CLI_API_TOKEN` on the hub and watch the auto sign-out banner.

## Push notifications (P3)

End-to-end encrypted APNs push, mirroring the Android FCM stack
(`docs/api/native-companion-contract.md` + the iOS extension below).

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
  carries a ~60-line copy of the HapiKit `PushEnvelope` decrypt, kept honest
  by the shared test vector.
- **Actions.** `permission-request` → Allow / Deny; `ready` and
  `task-notification` → inline Reply. Handlers run in the notification
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

**First build with push (Xcode-side, once):** the project now has two
targets. Signing is `Automatic`, but a personal/team identity is required
for push entitlements:

1. Select your team under *Signing & Capabilities* for **both** the `Hapi`
   app target and the `HapiNotificationService` extension target.
2. The app target ships `Hapi/Hapi.entitlements` (`aps-environment:
   development` — Xcode/App Store flips it to `production` at distribution)
   plus the shared keychain group; the extension ships the keychain group
   only. If Xcode prompts to register the capability, accept — free personal
   teams cannot sign push entitlements, a paid/organization team is needed.
3. Simulators cannot receive APNs: expect `didFailToRegister…` there (the
   Settings row shows the error). Everything else — decrypt, categories,
   actions — can be exercised with `xcrun simctl push` using a payload whose
   `hapi.e` was produced with the device's registered key.

## Milestones (track A of the native-clients plan)

- **M0** — this scaffold: project, HapiKit package, CI, one passing test.
- **M1** — foundations: HapiProtocol wire models + catalogs; APIClient + auth
  (Keychain, single-flight 401 refresh); SSEClient + reconnect state machine +
  versioned patch application (incl. gzip streaming check); pairing flow
  (VisionKit scan + `hapicompanion://bind` deep link + multi-hub).
- **M2** — read-only chat: session list; chat pipeline port
  (normalize/reducer/toolGroups, fixtures green is the gate); message window
  store; Markdown/code/diff renderers; read-only ChatView with paging.
- **M3** — interaction: composer (optimistic send, queue/steer, drafts,
  reopen migration, slash commands); permission UX; new session; attachments.
- **M4** — secondary features: files/git; Scratchlist; dictation;
  usage/storage (Swift Charts); settings.
- **M5** — polish: zh-CN localization, Dynamic Type/VoiceOver, long-session
  memory profiling, App Store material.

## Notes

- The `hapicompanion://` URL scheme is registered via `Hapi/Info.plist`,
  alongside the camera (QR pairing + attachment capture) and microphone
  (dictation) usage strings; everything else is generated through
  `GENERATE_INFOPLIST_FILE` + `INFOPLIST_KEY_*` build settings. The modern
  out-of-process `PhotosPicker` needs **no** photo-library permission, so
  there is no `NSPhotoLibraryUsageDescription`.
- `run.hapi.companion` is the bundle id; signing is `Automatic` and CI builds
  with `CODE_SIGNING_ALLOWED=NO`.
- CI uses the runner's default Xcode; each job prints `xcodebuild -version`
  first so failures are attributable to a toolchain bump.
