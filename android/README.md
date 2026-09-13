# HAPI Android Companion

Native Android client (Kotlin + Jetpack Compose) for the HAPI hub. Fully
independent from the web app; shares only the protocol contract
(`docs/api/`) and the golden fixtures (`shared/fixtures/`).

- **applicationId**: `run.hapi.companion` · **minSdk** 26 · **target/compileSdk** 36
- **Toolchain**: Gradle 8.14.2 (wrapper) · AGP 8.11.1 · Kotlin 2.1.21 · Compose BOM 2025.05.00 · JDK 17+ (CI uses 21)

## Modules

| Module | Type | Responsibility |
|---|---|---|
| `:core:protocol` | **pure Kotlin/JVM** (no Android) | Hub wire types, chat pipeline, message pagination, versioned patches, agent/mode catalogs, git parsers, pairing links, and golden-fixture conformance tests. |
| `:core:data` | Android library | OkHttp API/SSE transport, per-hub authentication, secure credentials, StateFlow stores and disk snapshots, encrypted push registration/decoding, and background notification actions. |
| `:app` | Android application | Compose screens for pairing, sessions/chat, approvals, new sessions, files, Scratchlist, dictation, usage/storage, and settings; navigation, localization, FCM service, and WorkManager wiring. |

Dependency direction: `:app` → `:core:data` → `:core:protocol`.

## Protocol conformance fixtures

`:core:protocol` is the porting target for `web/src/chat/` and is verified
against golden fixtures generated from the web implementation (track K).
The test task already passes the fixtures location as a system property:

```kotlin
// core/protocol/build.gradle.kts
tasks.test {
    systemProperty("hapi.fixtures.dir", rootDir.parentFile.resolve("shared/fixtures").absolutePath)
}
```

Fixture-driven tests read `System.getProperty("hapi.fixtures.dir")` from the
checked-in golden fixture set. CI re-runs this suite whenever `android/**`
or `shared/fixtures/**` change.

## Building

Native chat scrolling architecture and acceptance checklist:
[Native transcript scrolling](../docs/native-chat-scrolling.md).

Requires an Android SDK for `:app`/`:core:data` (set `ANDROID_HOME` or
`android/local.properties` with `sdk.dir=...`). `:core:protocol` alone needs
only a JDK.

```sh
cd android
./gradlew :core:protocol:test        # pure JVM protocol tests (fast)
./gradlew :app:assembleDebug         # debug APK
./gradlew :app:installDebug          # install on a connected device
```

Without an Android SDK you can still run the protocol suite by configuring
only the needed projects:

```sh
./gradlew --no-configuration-cache --configure-on-demand :core:protocol:test
```

CI (`.github/workflows/android.yml`) runs protocol/data/app unit tests,
`:app:assembleDebug`, `:app:lintDebug`, and Compose instrumentation on API 29
and API 36 for PRs touching `android/**` or `shared/fixtures/**`.

## Tool previews

Ordinary chat tools stay compact summaries. Tap a tool or tool group to open a native
Navigation Compose page; Back returns one level, Close returns to the chat.
Groups start at their latest tool, retain their position when returning from
details, and never follow streaming updates automatically. The **Latest tool**
toolbar action scrolls explicitly. Agent processes have their own page with
lazy child rows. Approvals remain in the conversation or a live process page;
ordinary tool detail pages are read-only.

Plan proposals (`ExitPlanMode` / `exit_plan_mode`) start fully expanded in the
conversation, rendering the complete `input.plan` Markdown before approval
controls. Tapping the header folds the card. Plan documents are prewarmed in the
chat Markdown cache and do not use the ordinary tool-output paging budget; raw
input/result remains under Source.

Details recognize namespaced command/script/patch calls, unwrap common
nested result envelopes, and keep command exit/status metadata visible. File
reads use source-language highlighting; web/agent prose uses Markdown. **Source**
reveals the original input/result, including fields omitted from the preview.
Mixed text/media results stay JSON instead of dropping non-text blocks.

Question details show recorded selections, custom answers and notes with
Markdown questions/options. `request_user_input` also restores answers from
historical results; live permission answers take precedence. Answered cards
avoid duplicate results, but retain errors and the full input/result/answers
under **Source**. The pending answer form remains unchanged.

Tool inputs/outputs display one part at a time, up to 20,000 Unicode graphemes
or 400 source lines. Previous/Next replace the mounted part; visited parts do
not accumulate. Large diffs/Markdown use paged source. JSON formatting and
output preparation run off the UI thread. File mutation details also offer
**View current file**, distinct from the recorded tool input/result.

Inspectors share the conversation's pipeline and SSE subscription. Opening one
freezes tail following, cancels hidden history loading and recording, and hides
the keyboard. Returning retains the transcript anchor. Trimmed selections remain
readable as labeled snapshots; an epoch reset closes obsolete inspectors.

## Long messages and reading layout

User prompts remain inline through 8,000 graphemes and 120 source lines. Larger
prompts show a 2,000-grapheme / 24-line preview and **View full message** opens a
reader with one 4,000-grapheme / 80-line part mounted. Pagination preserves
whitespace, CRLF, emoji and combining sequences exactly; character counts refer
to Unicode graphemes, not UTF-16 offsets.

**Copy full content** uses the clipboard up to 64 Ki UTF-16 code units. Larger
content, or a failed clipboard operation, offers UTF-8 file export through
FileProvider and Android's sharesheet; Binder receives a URI, not the text.
Exports older than 24 hours are cleaned on the next export.

Body/composer/user text uses 16sp/24sp, code/diff/terminal 14sp/20sp, captions
12sp/16sp. Content and composer share a centered 720dp reading column with
16dp minimum side margins. Bubble widths use actual container constraints,
including split-screen; Android font scaling remains enabled.

## Connection status and home filters

The chat subtitle reserves its height. **Reconnecting · Tap to retry** appears
after four continuous foreground seconds of outage; retry/backoff transitions
do not restart that grace period. Transport state is separate from message
events. Default-network/interface/route changes wake reconnect immediately,
preserving replay cursors; background retries defer until foreground. A local
hub route does not need Android's internet-validation capability.

Home centers the Sessions title between a **Hubs and settings** icon and a
**Filters** icon, keeping the new-session FAB. The hub menu is the only entry
for switching/adding hubs, app settings and sign-out; the active hub is checked.
The filter icon marks an applied filter and opens a Material 3 single-selection
sheet. Choices come from all sessions, including historical
machines; names/IDs determine ordering, never counts. Duplicate names include
IDs; unnamed and unknown machines are labeled. The applied filter has a Clear
action, is transient per home/hub, and is cleared when no longer valid.
The home holder follows the active connection instance, releasing the previous
store and filter even when switching back to a previously used hub URL.

Pairing and Settings both link to the [privacy policy](https://hapi.run/docs/privacy).
These controls and notices ship in English and Simplified Chinese.

### Validation status (2026-09-12)

Protocol/data/app JVM suites: 722 tests passed. Debug APK, instrumentation APK
and lint passed. Pixel 6 (Android 17/API 37): installed and visually checked the
home toolbar, hub/settings menu, applying/clearing filters, English/Chinese
switching and code-copy feedback. Code headers keep an 18dp action icon inside
a 48dp touch target, at the trailing edge even with short language labels.

API 36 ARM64 emulator (macOS Hypervisor.Framework): 8 targeted instrumentation
tests passed, including 5 new toolbar/code-layout regressions (320dp width,
English/Chinese, 2× font scaling), exact clipboard/file export and question
details. The full 30-test run was **not all green**: 3 transcript group-anchor
checks and the tool-browser initial-position check also fail with the pre-fix
APK. One question-details timeout passed on targeted rerun; the opt-in frame
probe was skipped. API 37 instrumentation is blocked by the current Espresso
dependency calling the removed `InputManager.getInstance()` method.

Earlier API 29 checks passed 19 chat/reader regressions. No 60/120 Hz device
frame-time, memory, or predictive-back measurements are claimed by these checks.

## Pairing

HAPI is self-hosted: the app talks to a hub **you** run. Pairing = giving the
app a hub URL plus that hub's access token; the app verifies the hub
(`GET /health`, protocol version), exchanges the token for a JWT
(`POST /api/auth`), stores the credentials in `EncryptedSharedPreferences`
(keyed per hub — multiple hubs can be paired, one active at a time), and
lands on the session UI. Three entry points:

1. **QR scan** — the hub prints two QR codes when started with `--relay`
   (also under web Settings → Companion pairing). The in-app scanner accepts
   both: the companion deeplink (`hapicompanion://bind?hub=…&code=…`) and the
   web direct-access URL (`…?hub=…&token=…`).
2. **Deep link** — scanning the companion QR with the system camera opens the
   app directly with a confirm screen (`hapicompanion://bind` intent filter).
3. **Manual entry** — hub URL + access token, for hubs started without
   `--relay`.

### Pairing against a development hub

```sh
# Start a hub with the built-in HTTPS relay (prints the access token + QR codes).
hapi hub --relay

# Use the printed https:// URL. For a source-tree `bun run dev` hub, put an
# HTTPS reverse proxy or tunnel in front of localhost:3006 first.
adb shell am start -a android.intent.action.VIEW \
  -d "hapicompanion://bind?hub=https%3A%2F%2Fhub.example.com&code=<accessToken>"  # optional: exercises the deep link
```

The app rejects plain-`http` hub URLs in manual entry, deep links, QR codes,
and restored hub state. The manifest also sets
`android:usesCleartextTraffic="false"`; there is no debug or LAN exemption.
Sign-out (home → Sign out) deletes the stored credentials for that hub and
drops it from the roster.

## Milestone history (track B of the native-clients plan)

- **M0** — initial scaffold: modules, version catalog, CI, placeholder screen.
- **M1** — foundations: wire types + modes catalog; auth + `HapiApi` (MockWebServer-tested); `SseEngine` reconnect state machine + versioned patches (gzip streaming verified); pairing UI + `hapicompanion://bind` deep link.
- **M2** — read-only chat: chat pipeline port gated on fixtures all-green; session list; `MessageWindowStore` port; Markdown renderer; read-only chat screen (`LazyColumn` with chronological stable keys).
- **M3** — interaction: composer (optimistic send/queue/steer/drafts), permission approvals UX, session controls (mode/model/abort/resume/rename/archive), new session, dictation.
  - **B-M3ce landed** — voice dictation: mic button in the composer (`RECORD_AUDIO` requested at first use), `MediaRecorder` → m4a/AAC, provider discovery via `GET /api/voice/transcription/providers` on chat entry (first `standard`-capable provider; mic hidden until available, including unconfigured/unreachable hubs), upload through the multipart `POST /api/voice/transcription`, transcript appended at the composer text with a space separator; `DictationController` is a plain seam over recorder + API, JVM-tested with fakes. Slash commands: typing a lone `/token` opens a dropdown merging the session's `metadata.slashCommands` names with the `GET /slash-commands` RPC list (RPC entries win dedupe; exact → prefix → contains filtering), tap inserts `/name ` (the skills `$` trigger is deferred). Session ops: list long-press sheet and chat top-bar overflow gain Rename (`PATCH /sessions/:id`, optimistic name with roll-forward on failure), Delete (confirm; 409-while-active surfaced), and Reopen for inactive sessions (`POST /reopen`; a superseding id reuses the supersede path — window seed + draft move + navigate-replace; 422 missing-metadata formatted); chat shows an inactive-session bar ("send to resume, or Reopen").
- **M4** — FCM push (register → notification actions via expedited WorkManager) + files/git viewer, Scratchlist, usage/storage stats.
  - **B-M4a landed** — FCM push + notification actions. `:core:data` `push/`: `PushPayload` (data-only contract v1 decoding: type/severity/`notifySummary` parsing, channel routing, `type-<sessionId>` coalescing tags, unknown type/contractVersion degrade to plain title/body), `DeviceRegistrar` (registers the FCM token with **every** paired hub on start/pairing/`onNewToken`, Keystore-encrypted install identity (`deviceId` UUID + `pushKey`), WorkManager retry seam, best-effort unregister on sign-out before credentials are wiped), `PushHubAccess` + `PushActionRunner` (workers build a `HubSession` on demand from stored credentials — no `HubGraph` needed in background — and resolve the owning hub: active hub first, other paired hubs on 404 session-miss). `:app`: `push/PushBinding` (Firebase availability gate — no `google-services.json` → all push paths no-op), `fcm/` (`HapiFirebaseMessagingService`, `NotificationChannels` — `permission_requests` HIGH / `ready` / `task_notifications`, `PushNotifications` builder with severity accents + suppress-when-open rule, `NotificationActionReceiver` → expedited `PermissionActionWorker` (Allow/Deny → approve/deny `{}`) and `SendMessageWorker` (RemoteInput reply → `{text, localId}`) with pending → done/"Already handled"/failed notification states), WorkManager on-demand init + `HapiWorkerFactory`, notification tap → internal `MainActivity` intent route → chat.
- **M5** — polish: zh-CN i18n, OLED/Material You theming, predictive back, LeakCanary pass, Play listing + self-build docs.
  - **B-M5a landed** — zh-CN localization + in-app language switching (see "Internationalization" below).

## Internationalization (B-M5a)

The app ships English (default) and Simplified Chinese
(`app/src/main/res/values-zh-rCN/strings.xml`). Every user-visible string
lives in resources; both files carry the **same key set** (lint
`MissingTranslation` is the gate).

**Adding a string**

1. Add it to `app/src/main/res/values/strings.xml` with a feature-prefixed
   key matching the existing convention (`chat_`, `sessions_`, `files_`,
   `scratchlist_`, `pairing_`, `settings_`, `new_session_`, `notif_`,
   `tool_` for tool-card titles). Dynamic values use positional format args
   (`%1$s`, `%2$d`); count-dependent copy uses explicit `_one`/`_many` keys
   (the deliberate house style — no `<plurals>`).
2. Add the zh-CN twin to `values-zh-rCN/strings.xml`. **Terminology source of
   truth is the web corpus** `web/src/lib/locales/zh-CN.ts` — reuse its
   product terms (会话 session, 机器 machine, 权限模式 permission mode,
   工作树 worktree, 草稿夹 scratchlist, 语音输入 dictation, 用量 usage,
   智能体/代理 agent). Technical identifiers (model ids, flavor names like
   Claude/Codex, permission-mode catalog labels, CLI flags) stay
   untranslated, matching the web's choices.
3. Reference it: composables via `stringResource(R.string...)`. ViewModels
   stay string-free — transient notices are **semantic sealed types**
   (`ChatNotice`, `ScratchlistNotice`, `PairingError`, `DictationErrorKind`)
   resolved at the UI layer; where a ViewModel genuinely composes display
   text it takes a small Strings seam (`FilesStrings`, `FileViewerStrings`,
   `NewSessionStrings`) whose defaults are the English values (JVM tests
   construct without arguments) and whose production instance is
   resource-resolved in the Navigation holders. Server-provided error text
   passes through verbatim.

**Language switching**

`Settings → App language` offers Follow system (default) / English /
简体中文. The choice persists in `LanguagePrefs` (DataStore) and applies
immediately via `AppCompatDelegate.setApplicationLocales`:

- `MainActivity` extends `AppCompatActivity` (theme parent
  `Theme.AppCompat.DayNight.NoActionBar`) so per-app locales work back to
  API 26; on API 33+ the framework `LocaleManager` takes over (the app also
  declares `android:localeConfig` for the system App-languages screen).
- The manifest opts into appcompat's `autoStoreLocales`
  (`AppLocalesMetadataHolderService` meta-data), which re-applies the stored
  choice synchronously on cold start.
- Surfaces that resolve strings from the **application** context — FCM
  notifications, WorkManager result updates, notification-action receivers —
  wrap their context with `localizedForAppLanguage(AppGraph.appLanguage)`
  (`di/LocaleContexts.kt`), since per-app locales only retarget activity
  contexts below API 33.

Out of scope on purpose: `:core:protocol` presentation strings
(`getEventPresentation`, tool-group activity titles) stay English — the web
does not translate them either, and terminology parity with the web wins.

## Firebase / push

**Official app users:** install the app, pair an updated hub, and allow
notifications. The official Firebase client configuration is bundled in the
app. Hubs without a private `FCM_SERVICE_ACCOUNT_PATH` use the official push
relay automatically; users do not create Firebase projects or configure
service-account keys. Google Play services and FCM connectivity are needed.
The push relay also works with hubs accessed through Tailscale or other HTTPS
setups; it is independent of `hapi hub --relay`.

**Private builds:** create a Firebase project for your application ID,
download `google-services.json` into `android/app/`, and configure the hub's
`FCM_SERVICE_ACCOUNT_PATH` for that same project. Existing configured hubs
keep direct delivery under the default `HAPI_ANDROID_PUSH=auto`. Use
`relay`, `fcm`, or `off` to select explicitly. `HAPI_PUSH_RELAY_URL` overrides
the shared Android/iOS relay URL. One hub cannot mix private-project builds
and official-project builds.

**Builds without Firebase:** the Google services plugin stays conditional.
Without `app/google-services.json`, Firebase does not initialize and push
paths no-op; ordinary PR builds require no credentials. Official builds use
a separate mandatory configuration check (below).

**Encrypted relay:** the app registers its FCM token, install ID and random
32-byte `pushKey` with every paired hub. The ID/key are persisted together in
Keystore-encrypted preferences excluded from cloud backup and device
transfer. First upgrade replaces the old DataStore identity through the
hub's token deduplication; later token rotations reuse the ID/key. On start,
pairing, token rotation and worker retries, registrations refresh
automatically. Sign-out unregisters before wiping that hub's credentials.

Relay messages carry only `hapi_v`/`hapi_e`. AES-256-GCM decryption uses the
same golden vector as iOS; notification content is unavailable to the relay
and Google. Failed decrypts are dropped. Direct private FCM retains its
existing unwrapped data payload. Rendering, foreground-chat suppression,
Allow/Deny and Reply workers use the same decoded `PushPayload` in both paths.
The notification contract still does not name the sending hub: action
workers try the active hub first, then other paired hubs on session miss;
tapping opens the session against the active hub.

See [native companion contract](../docs/api/native-companion-contract.md)
for wire details and [relay deployment](../relay/README.md) for maintainer setup.

### Official APK/AAB builds

The **Android Official Build** workflow is manually dispatched on `main`.
It tests and uploads signed APK/AAB artifacts; it does not publish to Play.
Provide a new positive `version_code` and the desired `version_name`.

Repository configuration, set once by the maintainer:

| Setting | Value |
|---|---|
| Variable `ANDROID_FIREBASE_PROJECT_ID` | Project used by the deployed relay's FCM service account |
| Secret `ANDROID_GOOGLE_SERVICES_JSON` | Firebase **client** config for `run.hapi.companion` in that project |
| Secret `HAPI_UPLOAD_KEYSTORE_BASE64` | Base64-encoded release keystore |
| Secret `HAPI_UPLOAD_KEYSTORE_PASSWORD` | Keystore password |
| Secret `HAPI_UPLOAD_KEY_ALIAS` | Optional, defaults to `upload` |
| Secret `HAPI_UPLOAD_KEY_PASSWORD` | Optional, defaults to store password |

`-PhapiOfficialBuild=true -PhapiFirebaseProjectId=<project>` requires a
matching Firebase project/package and release signing configuration.
Missing or mismatched settings fail the build instead of shipping a package
without working push. `hapiVersionCode` and `hapiVersionName` override the
normal version defaults. The Firebase service-account private key belongs
only on the relay and must never enter Android build artifacts.

Roll out relay support/credentials first, then the hub, then the app. Verify
real background, lock-screen and cold-process notifications using a hub with
no Firebase settings; test Allow/Deny/Reply and an iOS push before publishing.

## Release signing

Same philosophy as Firebase: the repo carries no secrets and builds green
without them. `:app:bundleRelease` produces an **unsigned** AAB unless an
upload key is configured via gradle properties (user-global
`~/.gradle/gradle.properties`), environment variables (CI secrets), or
`android/local.properties` (gitignored; same property names — the
conventional machine-local home, loaded explicitly since it is not part
of gradle's own property chain):

| gradle property | env | meaning |
|---|---|---|
| `hapiUploadKeystore` | `HAPI_UPLOAD_KEYSTORE` | keystore path (`~` ok) |
| `hapiUploadKeystorePassword` | `HAPI_UPLOAD_KEYSTORE_PASSWORD` | store password |
| `hapiUploadKeyAlias` | `HAPI_UPLOAD_KEY_ALIAS` | default `upload` |
| `hapiUploadKeyPassword` | `HAPI_UPLOAD_KEY_PASSWORD` | default: store password |

This is an **upload key** for Play App Signing (Google holds the actual
distribution key, so a lost upload key is resettable in Play Console).
Generate one with:

```bash
keytool -genkeypair -v -keystore ~/.hapi/upload.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10950
```

Keystores never live in the repo (`*.keystore` / `*.jks` are gitignored).
