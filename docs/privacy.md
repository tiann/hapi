---
title: Privacy Policy
aside: false
---

# Privacy Policy

**Effective date: August 25, 2026** · Applies to the HAPI mobile companion apps (Android and iOS) and the self-hosted HAPI hub.

::: tip The short version
HAPI is self-hosted software. Your app connects to a hub **you** operate; the HAPI project does not run a central account or application backend that receives your conversations or source code. Optional features can send data to services you or the app enable — notably Firebase Cloud Messaging, Apple Push Notification service, voice-transcription providers, and the coding-agent/model providers configured on your machine. HAPI contains no advertising or tracking SDKs and no product analytics.
:::

In this policy, “we” means the maintainers and publisher of the HAPI project. The person or organization operating a hub controls the data stored on that hub and the external services configured for it.

## Data stored on your device

- Paired hub addresses and access credentials. Credentials are kept in platform-protected app storage.
- Preferences and app state, such as theme, language, notification choices, drafts, recent paths, and a random device identifier used for push registration.
- Cached hub data, including session/message snapshots and generated images, for performance and limited offline display.
- Files, photos, and audio you explicitly select or record while preparing an attachment or dictation request. Camera and dictation scratch files use temporary cache storage and are normally deleted after ingestion or cancellation; selected content is transmitted only when you invoke the corresponding send, save, or transcription action.

The mobile operating system and app-store software may separately create device backups or diagnostics according to your device settings and their own policies.

## How data is used and where it travels

The app uses your data to authenticate to your hub, display and update sessions, send commands and attachments, perform notification actions, and provide features you request. Core app traffic travels between the app and your self-hosted hub. The Android app accepts only HTTPS hub URLs and disables cleartext network traffic.

Your hub, coding agents, plugins, and command-line tools may send prompts, source code, files, audio, or other content to services you configure, such as AI model or transcription providers. Those services process data under their own terms and privacy policies. HAPI does not choose or control your self-hosted configuration.

## Push notifications

**Android:** notifications use Google Firebase Cloud Messaging (FCM). When push is enabled, Firebase creates and manages a device token; the app registers that token and a random app device identifier with each paired hub. Your hub sends notification content and routing metadata — for example a session identifier, title, status, and action type — through FCM. HAPI does not end-to-end encrypt the Android notification payload, so Google processes this data under [Firebase's privacy terms](https://firebase.google.com/support/privacy). Builds without Firebase configuration do not register for or receive FCM push.

**iOS:** notifications are end-to-end encrypted. Your hub encrypts the content with a key that exists only on your device and your hub; Apple's push service — and the optional HAPI relay, if you use it instead of your own APNs credentials — carry ciphertext and routing metadata only, and cannot read the notification. Self-hosters can bypass the relay entirely with their own Apple developer credentials.

## Camera

Camera access is used to scan pairing QR codes and, when you choose it, to take a photo attachment. QR frames are processed on the device and are not retained or uploaded by HAPI. A captured photo is held temporarily and is sent to your hub only if you submit it as an attachment. Pairing is also available through manual entry.

## Microphone

Microphone access is used only when you start voice dictation. The app records a temporary audio file until you stop or cancel. On transcription, the audio is sent to your hub, which forwards it to the transcription provider configured by the hub operator (for example OpenAI, ElevenLabs, Deepgram, Groq, or an OpenAI-compatible/local service). The provider's policy applies to that processing. The app deletes its temporary recording after reading it; the returned text is placed in the composer.

## What the HAPI project collects

The HAPI project does not receive app telemetry, advertising identifiers, conversations, source code, or hub credentials through a central HAPI backend. The apps contain no advertising, tracking, product-analytics, or third-party crash-reporting SDKs. If you contact us by email or GitHub, we receive the information you voluntarily include in that communication.

Google Play, the Apple App Store, operating-system vendors, Firebase, and other services you enable may collect installation, device, diagnostic, notification, or service-usage data independently under their own policies.

## Retention and deletion

Unpairing a hub removes that hub's credentials from the app and attempts to unregister push delivery; cached content may remain until the operating system clears the cache, you clear the app's storage, or you uninstall the app. Uninstalling removes app-controlled local data, subject to any operating-system backup you enabled.

Data stored on a hub remains under the hub operator's control and retention settings. Delete it from the hub, its underlying storage, and any configured provider as appropriate. HAPI has no central user account to delete.

## Security

The Android app requires HTTPS for hub connections. Mobile credentials use platform-protected app storage, and normal operating-system app sandboxing limits access by other apps. No transmission or storage system is perfectly secure; hub operators are responsible for securing their hub, TLS endpoint, host machine, backups, credentials, and configured third-party services.

## Children

HAPI is a developer tool and is not directed at children under 13.

## Open source

The complete source code of the apps and the hub is available at [github.com/tiann/hapi](https://github.com/tiann/hapi) — the claims above can be verified in the code.

## Changes & contact

If this policy changes, the updated version will be published at this address with a new effective date. Questions and concerns: open an issue on [GitHub](https://github.com/tiann/hapi/issues) or email [twsxtd@gmail.com](mailto:twsxtd@gmail.com).
