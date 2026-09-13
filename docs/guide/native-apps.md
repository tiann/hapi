# Native apps (iOS / Android)

HAPI includes native iOS and Android clients for controlling sessions on a hub
you run. Agents execute on your CLI/Runner machines; the hub stores the session
history. The apps connect directly to that hub and share the same conversations
as the [Web/PWA](./pwa.md).

## Build and install

The repository provides these build paths:

| Platform | Device requirement | Build instructions |
|---|---|---|
| iOS | iOS 17 or newer | [iOS README](https://github.com/tiann/hapi/blob/main/ios/README.md): Xcode 16 or newer, shared `Hapi` scheme; device builds require signing. |
| Android | Android 8.0 (API 26) or newer | [Android README](https://github.com/tiann/hapi/blob/main/android/README.md): JDK 17+, Android SDK, Gradle wrapper; build/install a debug APK or configure release signing. |

Maintainers can use the [Android Official Build workflow](https://github.com/tiann/hapi/blob/main/.github/workflows/android-release.yml)
to produce signed APK/AAB artifacts with the official Firebase configuration.
That workflow does not publish to Google Play. Push setup depends on the build
you install; see [Notifications](#notifications).

## Pair with your hub

1. Start your hub, or use an existing HTTPS hub endpoint:

   ```bash
   hapi hub --relay
   ```

2. Open the native app and choose a pairing method:

   - **Scan QR:** use the in-app scanner with either QR code printed by the
     hub. Web **Settings → Companion pairing** also shows the companion QR.
   - **Open a pairing link:** `hapicompanion://bind` opens the app's pairing
     flow. Confirm the hub before pairing.
   - **Enter manually:** supply the hub URL and access token printed by the
     hub. Use the hub address, not the web frontend address `app.hapi.run`.
3. The app checks reachability and protocol compatibility, then authenticates
   and stores credentials for that hub. A namespaced token such as
   `your-token:team` opens that namespace's sessions.

Use an **HTTPS hub origin**, for example `https://hub.example.com`. Both apps
identify hubs by origin; path prefixes are not retained. Your phone must be
able to reach the hub. `localhost` on a physical phone refers to the phone.
The network relay, an HTTPS reverse proxy, or Tailscale Serve can provide an
endpoint; see [Deployment](./deployment.md).

Android rejects HTTP URLs in manual entry, QR codes, deep links and saved hub
state, including debug builds. iOS accepts HTTP input and prefixes a manually
entered address without a scheme with `http://`; connection success still
depends on system network policy. The iOS project declares no ATS exceptions,
so HTTP input acceptance does not guarantee a working connection. Prefer an
explicit HTTPS URL on both platforms.

Camera pairing is optional. Use manual entry on an iOS Simulator or any device
without a usable scanner.

## Sessions and everyday use

Start an agent on your computer with `hapi` and choose an installed agent, or
run a [specific agent command](./agents.md). The session appears in the app.

To create sessions from your phone, start a [Runner](./installation.md#runner-setup)
on the machine that will execute the agent:

```bash
hapi runner start
```

In the app, select **New Session**, choose an online machine, directory and
available agent, then create the session. Model and permission controls depend
on the agent and session capabilities. Configured workspace roots constrain
directory browsing and session creation.

| Capability | Current native behavior |
|---|---|
| Chat and permissions | Streaming messages, history, tool inspection, approvals and question answering on both platforms. |
| Composer | Text, photos/camera/files, drafts, queued-message actions and steering when supported by the session. |
| Session controls | Both support pin/archive, stopping a turn and sending to resume an inactive session. Android also exposes Rename, Delete and explicit Reopen actions; iOS currently has no corresponding UI for those three actions. |
| Files and Git | Open **Session files** from the chat menu to browse/search files, inspect Git status and read diffs. |
| Scratchlist | Open **Scratchlist** from the chat menu to park text and attachments for later use in a session. |
| Dictation | Record audio, transcribe through a configured hub provider, then edit the inserted text before sending. |
| Usage and storage | Available only to the hub owner (`default` namespace). |
| Display | English/Simplified Chinese, theme preferences, system text scaling and machine filtering on the session list. |

Selecting an attachment starts its upload after preparation, before you send
the message or save the Scratchlist entry. Removing it requests cleanup of
unused uploads on a best-effort basis. See the [Privacy Policy](../privacy.md)
for storage and provider data flows.

Dictation uses the first configured provider that supports standard
transcription. The microphone stays hidden until provider discovery succeeds;
grant microphone permission when first using it. Configure providers on the hub
or through **Web Settings → Voice**. Native dictation inserts text and does not
send it automatically. See [Voice input and assistant](./voice-assistant.md).

### Features available through the web

Use the web app for the remote terminal, Work Graph, realtime dictation and
voice assistant, session fork/rewind/export, and the skills picker. These have
no native UI. Session history actions also depend on the agent's capabilities.
Native apps display existing scheduled messages but do not provide a form to
create scheduled sends. Android's full-text file export is a reader action,
separate from exporting an entire session.

## Multiple hubs and sign-out

The home screen's hub menu lets you add or switch hubs, open Settings, and
sign out. You can keep several hubs paired, with one active at a time; session
lists and drafts belong to their hub. Signing out removes that hub's stored
credentials and attempts to unregister its push token.

Both apps refresh authentication automatically. Temporary network or server
failures retain paired credentials. A rejected access token or a freshly
issued token that is rejected again requires re-pairing with valid credentials.

## Notifications

Allow system notifications after pairing. Native notifications support
permission approval/denial and replies; a notification for the foreground chat
is suppressed locally because the conversation is already visible.

| App build | Push requirements |
|---|---|
| Official Android Firebase configuration | A current hub uses the encrypted push relay by default when no private FCM credentials are configured. Google Play services and FCM connectivity are required. |
| Official iOS signing | A current hub uses the encrypted push relay by default. No Apple developer credentials are needed on the user's hub. |
| Private Android Firebase project | Bundle that project's client configuration and configure matching Firebase service-account credentials on the hub for direct FCM. |
| Android without Firebase configuration | Session features work; FCM push is unavailable. |
| Self-signed iOS build | Configure direct APNs or a self-hosted push relay with credentials matching the app's developer account, bundle ID and APNs environment. Follow the iOS README's signing instructions. |

The official push relay carries encrypted notification content and routing
metadata. It is separate from the network tunnel enabled by `hapi hub --relay`,
so it also works with hubs reached through another HTTPS setup. Private direct
FCM delivery uses an unencrypted notification data payload; direct APNs remains
encrypted. See [Notifications](./notifications.md#native-app-notifications)
and the [push contract](../api/native-companion-contract.md) for configuration.

Push registration covers every paired hub. Notification taps currently open
the session against the active hub; if the session cannot be found, switch to
its owning hub. Background notification actions try paired hubs to resolve
the session.

## Troubleshooting

| Symptom | Check |
|---|---|
| Pairing cannot reach the hub | Use the HTTPS hub origin, verify phone network access and certificate trust, and check the hub's listening address or reverse proxy. |
| Protocol mismatch | Update the app/hub to compatible builds; both apps require the hub protocol version to equal their supported version. |
| Re-pairing requested | Use the current access token, including the intended namespace suffix. |
| No machines for New Session | Start the Runner, verify its connection and namespace, and check agent availability on that machine. |
| Microphone missing | Configure a standard transcription provider and ensure the hub is reachable. |
| Notifications missing | Check OS permission, the build's Firebase/APNs configuration, provider connectivity and hub push settings. |

For development and conformance checks, use the platform READMEs and the
[client contract](../api/client-contract/index.md). Protocol fixture conformance
does not imply identical native and web UI features.
