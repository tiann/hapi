---
title: Privacy Policy
aside: false
---

# Privacy Policy

**Effective date: September 12, 2026** · Applies to the HAPI mobile companion apps (Android and iOS) and the self-hosted HAPI hub.

::: tip The short version
HAPI is self-hosted software. Your app connects to a hub **you** operate; the HAPI project does not run a central account or application backend that receives your conversations or source code. Optional features can send data to services you or the app enable — notably the HAPI push relay, Firebase Cloud Messaging, Apple Push Notification service, voice-transcription providers, and the coding-agent/model providers configured on your machine. The HAPI push relay processes device and connection metadata to deliver encrypted notifications, prevent abuse, and diagnose delivery failures. HAPI contains no advertising or tracking SDKs and no product analytics.
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

**Android:** notifications use Google Firebase Cloud Messaging (FCM). When push is enabled, the app registers its FCM token, random app device identifier, and device-generated encryption key with each paired hub. Official app delivery through the HAPI push relay is end-to-end encrypted: the relay and Google carry ciphertext and routing metadata, but cannot read notification content. Private builds using a hub configured for direct FCM retain an unencrypted notification payload, including session identifiers, title, status, and action type; Google processes that data under [Firebase's privacy terms](https://firebase.google.com/support/privacy). Builds without Firebase configuration do not register for or receive FCM push.

**iOS:** notifications are end-to-end encrypted. Your hub encrypts the content with a key that exists only on your device and your hub; Apple's push service and the HAPI push relay carry ciphertext and routing metadata only, and cannot read the notification content. Self-hosters using a separately signed app build with matching APNs credentials can bypass the relay; a different developer account's credentials alone cannot send notifications to the official App Store build.

### HAPI native push relay

The default hub configuration uses the official relay at `https://push.hapi.run` for iOS push and for Android push when no private Firebase credentials are configured. This service is separate from the optional network tunnel enabled by `hapi hub --relay`. Encryption protects notification content, **not all metadata**:

- **Data received:** the target platform, an APNs or FCM device token, the encrypted notification envelope, and optional delivery settings such as priority and a notification-grouping identifier. The relay can observe request timing, envelope size, and the source IP of the connecting hub or proxy; that IP is not necessarily the phone's IP.
- **Uses:** forwarding notifications to Apple or Google, limiting abusive requests, and diagnosing delivery failures. This information is not used for advertising, cross-app tracking, marketing, or product analytics.
- **Rate-limit state:** device tokens and source IPs are kept in bounded process-memory maps with counters and refill times. There is no fixed expiration timer: entries may remain until capacity-based eviction or process restart. These maps are not written to a database by the relay.
- **Operational logs:** the relay writes a stable, platform-scoped, truncated SHA-256 hash of the device token and a delivery, error, or rate-limit outcome to its log output. Hashing avoids logging the usable token, but still allows events for a device to be correlated; it is not a claim of complete anonymity. The relay does not deliberately log notification envelopes, decrypted content, or raw device tokens.
- **Hosting logs:** container logging and any reverse proxy may retain operational or connection logs according to their deployment configuration. The relay source code does not impose a retention period or automatically delete those external logs. Its lack of a database does not mean that the hosting environment retains no data.

Only the device and its paired hubs hold the notification decryption key. Each hub stores its device registration, including the random app device identifier, APNs or FCM token, and encryption key; the random app device identifier and encryption key are not included in the relay push request. Apple or Google receives the device token, encrypted envelope, and delivery settings needed to route the notification.

## Camera

Camera access is used to scan pairing QR codes and, when you choose it, to take a photo attachment. QR frames are processed on the device and are not retained or uploaded by HAPI. A captured photo is held temporarily and is sent to your hub only if you submit it as an attachment. Pairing is also available through manual entry.

## Microphone

Microphone access is used only when you start voice dictation. The app records a temporary audio file until you stop or cancel. On transcription, the audio is sent to your hub, which forwards it to the transcription provider configured by the hub operator (for example OpenAI, ElevenLabs, Deepgram, Groq, or an OpenAI-compatible/local service). The provider's policy applies to that processing. The app deletes its temporary recording after reading it; the returned text is placed in the composer.

## What the HAPI project collects

The HAPI project does not receive product-analytics events, advertising identifiers, conversations, source code, or hub access credentials through a central HAPI backend. The official native push relay does process the device and operational metadata described above; push device tokens are different from advertising identifiers. The apps contain no advertising, tracking, product-analytics, or third-party crash-reporting SDKs. If you contact us by email or GitHub, we receive the information you voluntarily include in that communication.

Google Play, the Apple App Store, operating-system vendors, Firebase, and other services you enable may collect installation, device, diagnostic, notification, or service-usage data independently under their own policies.

## Retention and deletion

Unpairing a hub removes that hub's credentials from the app and attempts to unregister push delivery; cached content may remain until the operating system clears the cache, you clear the app's storage, or you uninstall the app. Uninstalling removes app-controlled local data, subject to any operating-system backup you enabled.

Data stored on a hub remains under the hub operator's control and retention settings. Delete it from the hub, its underlying storage, and any configured provider as appropriate. HAPI has no central user account to delete.

For native relay data, stopping delivery does not erase earlier operational logs. Hub operators can disable push with `HAPI_IOS_PUSH=off` or `HAPI_ANDROID_PUSH=off` for the corresponding platform; unpairing also attempts to remove that hub's device registration. Rate-limit entries are removed through the eviction/restart behavior described above, not by an app-side account-deletion action. External log deletion and rotation are controlled separately by the hosting operator.

To ask about the official relay's deployed log retention or request deletion of relay-related personal data, email [twsxtd@gmail.com](mailto:twsxtd@gmail.com). We will determine what records we can identify and the applicable deletion or retention requirements. We cannot identify a device from an email address alone and do not promise that all records can be located or that data on independently operated hubs or providers can be deleted by HAPI. Do not post device tokens, hub access credentials, or encryption keys in public issues or include them in an initial email; contact us privately to establish a safe way to handle your request.

## Security

The Android app requires HTTPS for hub connections. Mobile credentials use platform-protected app storage, and normal operating-system app sandboxing limits access by other apps. No transmission or storage system is perfectly secure; hub operators are responsible for securing their hub, TLS endpoint, host machine, backups, credentials, and configured third-party services.

## Children

HAPI is a developer tool and is not directed at children under 13.

## Open source

The complete source code of the apps and the hub is available at [github.com/tiann/hapi](https://github.com/tiann/hapi) — the claims above can be verified in the code.

## Changes & contact

If this policy changes, the updated version will be published at this address with a new effective date. Questions and concerns: open an issue on [GitHub](https://github.com/tiann/hapi/issues) or email [twsxtd@gmail.com](mailto:twsxtd@gmail.com).
