# HAPI Android Companion

Native Android client (Kotlin + Jetpack Compose) for the HAPI hub. Fully
independent from the web app; shares only the protocol contract
(`docs/api/`) and the golden fixtures (`shared/fixtures/`).

- **applicationId**: `run.hapi.companion` · **minSdk** 26 · **target/compileSdk** 36
- **Toolchain**: Gradle 8.14.2 (wrapper) · AGP 8.11.1 · Kotlin 2.1.21 · Compose BOM 2025.05.00 · JDK 17+ (CI uses 21)

## Modules

| Module | Type | Responsibility |
|---|---|---|
| `:core:protocol` | **pure Kotlin/JVM** (no Android) | Hub wire types (kotlinx.serialization), chat pipeline port (normalize → reduce → tool groups), message-window/pagination logic, versioned patch application, modes catalog, git output parsers, `BindLink` pairing-link parsing. **M1a landed**: `wire/` (`HapiJson`, `Session`/`SessionPatch`/`SessionSummary`, `DecryptedMessage`, `AgentState`, `Machine`, 13-type `SyncEvent` union via `SyncEvents.parse`, `MessagesResponse`), `catalog/` (flavors + permission/collaboration modes), `patch/SessionPatching.kt` (exact port of `web/src/lib/sessionPatch.ts`), all fixture-verified. |
| `:core:data` | Android library | Transport + persistence. **M1b landed** — `auth/` (`JwtPeek`, `CredentialStore` interface + `EncryptedPrefsCredentialStore`/in-memory, `HubUrls` origin normalization, `HubRegistry` roster behind a storage seam, `AuthInterceptor` + single-flight `TokenAuthenticator` with `ensureFreshToken()` and terminal `AuthEvents`), `api/` (`HapiApi` — plain OkHttp + kotlinx.serialization, one suspend fun per v1 endpoint incl. generated-image bytes via a 256 MB OkHttp cache and the multipart transcription helper; `ApiError` with `(status, code)`), `HubSession` per-hub factory; MockWebServer-tested. **M1c landed** — `sse/`: `SseEngine` (per-key `global`/`session:<id>` loops, `connection-changed` handshake gate with `ok`/`gap` resume verdict, per-key `Last-Event-ID` cursors advanced only after downstream hand-off (at-least-once), 10 s connect deadline, 90 s watchdog, 1 s→30 s→300 s backoff + jitter, background retry deferral + 45 s foreground stale check, one silent 401 re-auth per cycle), `OkHttpSseTransport` (dedicated client, `readTimeout=0`, incremental gzip decoding pinned by test, `acceptEncodingIdentity` fallback), `SyncEventRouter` → `SyncTargets` seam; virtual-time tested. Still to come: StateFlow stores + AtomicFile JSON snapshots (M2), FCM registration + WorkManager workers (M4). |
| `:app` | Android application | Compose UI, navigation, deep links (`hapicompanion://bind`), FCM service (M4), hand-rolled DI (`AppGraph`, no Hilt). **M1d landed** — `di/` (`AppGraph` process singletons: Preferences DataStore-backed `HubRegistryStorage`, `EncryptedPrefsCredentialStore`, `HubRegistry`, auth-terminal fan-out; `HubGraph` per active hub: `HubSession` + `SseEngine` wired to `ensureFreshToken`, recreated on hub switch; `LocalAppGraph` CompositionLocal + `viewModelFactory` helper), `feature/pairing/` (landing / zxing `ScanContract` QR scan / manual entry sharing one `PairingViewModel`: health + protocol check → `POST /api/auth` → persist + activate), `feature/home/` placeholder (hub switcher + sign-out), `Navigation.kt` (pairing ⇄ home, auth-terminal → pairing with banner), bind deep-link handling in `MainActivity`. |

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

Fixture-driven tests (M2) read `System.getProperty("hapi.fixtures.dir")` —
no further build changes are needed when `shared/fixtures/**` lands. CI
re-runs this suite whenever `android/**` or `shared/fixtures/**` change.

## Building

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

CI (`.github/workflows/android.yml`) runs the protocol tests and
`:app:assembleDebug` on every PR touching `android/**` or `shared/fixtures/**`.

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

## Milestones (track B of the native-clients plan)

- **M0** — this scaffold: modules, version catalog, CI, placeholder screen.
- **M1** — foundations: wire types + modes catalog; auth + `HapiApi` (MockWebServer-tested); `SseEngine` reconnect state machine + versioned patches (gzip streaming verified); pairing UI + `hapicompanion://bind` deep link.
- **M2** — read-only chat: chat pipeline port gated on fixtures all-green; session list; `MessageWindowStore` port; Markdown renderer; read-only chat screen (`LazyColumn(reverseLayout = true)`).
- **M3** — interaction: composer (optimistic send/queue/steer/drafts), permission approvals UX, session controls (mode/model/abort/resume/rename/archive), new session, dictation.
  - **B-M3ce landed** — voice dictation: mic button in the composer (`RECORD_AUDIO` requested at first use), `MediaRecorder` → m4a/AAC, provider discovery via `GET /api/voice/transcription/providers` (first `standard`-capable provider; a hub without one shows a notice), upload through the multipart `POST /api/voice/transcription`, transcript appended at the composer text with a space separator; `DictationController` is a plain seam over recorder + API, JVM-tested with fakes. Slash commands: typing a lone `/token` opens a dropdown merging the session's `metadata.slashCommands` names with the `GET /slash-commands` RPC list (RPC entries win dedupe; exact → prefix → contains filtering), tap inserts `/name ` (the skills `$` trigger is deferred). Session ops: list long-press sheet and chat top-bar overflow gain Rename (`PATCH /sessions/:id`, optimistic name with roll-forward on failure), Delete (confirm; 409-while-active surfaced), and Reopen for inactive sessions (`POST /reopen`; a superseding id reuses the supersede path — window seed + draft move + navigate-replace; 422 missing-metadata formatted); chat shows an inactive-session bar ("send to resume, or Reopen").
- **M4** — FCM push (register → notification actions via expedited WorkManager) + files/git viewer, Scratchlist, usage/storage stats.
  - **B-M4a landed** — FCM push + notification actions. `:core:data` `push/`: `PushPayload` (data-only contract v1 decoding: type/severity/`notifySummary` parsing, channel routing, `type-<sessionId>` coalescing tags, unknown type/contractVersion degrade to plain title/body), `DeviceRegistrar` (registers the FCM token with **every** paired hub on start/pairing/`onNewToken`, DataStore-persisted `deviceId` UUID, WorkManager retry seam, best-effort unregister on sign-out before credentials are wiped), `PushHubAccess` + `PushActionRunner` (workers build a `HubSession` on demand from stored credentials — no `HubGraph` needed in background — and resolve the owning hub: active hub first, other paired hubs on 404 session-miss). `:app`: `push/PushBinding` (Firebase availability gate — no `google-services.json` → all push paths no-op), `fcm/` (`HapiFirebaseMessagingService`, `NotificationChannels` — `permission_requests` HIGH / `ready` / `task_notifications`, `PushNotifications` builder with severity accents + suppress-when-open rule, `NotificationActionReceiver` → expedited `PermissionActionWorker` (Allow/Deny → approve/deny `{}`) and `SendMessageWorker` (RemoteInput reply → `{text, localId}`) with pending → done/"Already handled"/failed notification states), WorkManager on-demand init + `HapiWorkerFactory`, notification tap → internal `MainActivity` intent route → chat.
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

FCM needs a Firebase project binding, which is deliberately **optional**:
the `com.google.gms.google-services` plugin is applied *conditionally*
(only when `app/google-services.json` exists — see `app/build.gradle.kts`),
so the repo always builds green without any Firebase config. Without one,
`FirebaseApp` never initializes, `PushBinding.isAvailable` reports false,
and every push code path (registration, FCM service, workers, the
notification-permission prompt) no-ops — the app behaves like pre-M4a.

To enable push:

1. **Official builds**: CI injects the default Firebase project's
   `google-services.json` before assembling (the file is gitignored;
   `app/google-services.json.example` documents the expected shape).
2. **Self-builds**: create your own Firebase project, add an Android app
   with your `applicationId` (default `run.hapi.companion`), download
   `google-services.json` into `android/app/`, and rebuild.
3. **Hub side**: point the hub at the *same* Firebase project —
   `FCM_SERVICE_ACCOUNT_PATH` (or `fcmServiceAccountPath` in
   `~/.hapi/settings.json`; the project id comes from the JSON itself, see
   `docs/api/native-companion-contract.md`). The device registers itself
   with every paired hub (`POST /api/devices/register`) on pairing, app
   start, and token rotation, and unregisters on sign-out.

Multi-hub note: the FCM payload does not name the sending hub (contract v1),
so notification actions resolve it — the workers try the **active** hub
first, then the other paired hubs when a hub answers 404 for the session.
Single-hub setups always hit on the first try. Tapping a notification opens
the session against the active hub.

Planned for v1.x: runtime `FirebaseOptions` handed out by the hub, so
self-builds get push without baking a config into the APK. That lands
entirely behind the existing `app/.../push/PushBinding.kt` seam.

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
