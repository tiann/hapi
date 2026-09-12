# hapi-push-relay

The official HAPI push relay forwards end-to-end encrypted notifications
from self-hosted hubs to APNs (iOS) and Firebase Cloud Messaging (Android).

## Why it exists

Official apps belong to the maintainer's Apple team and Firebase project.
The relay holds their **sending credentials** centrally. Users install the
app, pair a current hub, and allow notifications; they do not need an Apple
developer account, a Firebase project, or a service-account key.

Android hubs default to `HAPI_ANDROID_PUSH=auto`: an existing
`FCM_SERVICE_ACCOUNT_PATH` keeps direct FCM; otherwise they use the relay.
iOS defaults to `HAPI_IOS_PUSH=relay`; developers can choose direct `apns`.
Push relay delivery is independent of the hub's `--relay` network tunnel.

## Threat model and privacy

**The relay sees ciphertext only.** The notification content is encrypted by
the hub with AES-256-GCM under a per-device key that only the hub and the
device know. The relay, Apple and Google forward opaque bytes; the iOS
Notification Service Extension decrypts locally on the device
(`mutable-content: 1` with a fixed placeholder alert of "HAPI / New
activity" that the extension rewrites). Android decrypts in its FCM service
before posting a local notification. What the relay *can* observe is
metadata: the platform and device token, the connecting hub/proxy IP, request timing,
and envelope size. It does not persist payloads in a database or log them.
It does retain token/IP rate-limit state in bounded process memory, and log
lines carry a platform-scoped token hash (first 12 hex chars of SHA-256),
the outcome and duration. The hash can correlate events for a device; it is not complete
anonymization. Container/proxy log retention depends on deployment settings,
not this service's in-memory storage policy.

**No client authentication, by design.** Possession of a device token *is*
the capability to submit a push, not to forge its contents. Device tokens
are unguessable. Someone who obtains one can consume its rate-limit budget
and trigger iOS generic alerts, but cannot encrypt valid content without
the AES key. Android drops undecryptable messages; iOS keeps its generic
placeholder. Requiring accounts would force self-hosters to register with
the relay, which is exactly what HAPI avoids. Mitigations instead:

- per-device-token rate limit: 30 pushes/minute (token bucket, burst 30)
- per-client-IP rate limit: 300 pushes/minute (token bucket, burst 300)
- envelope size cap: 3200 bytes (base64 as transmitted), plus a 64 KB cap
  on the whole request body
- rate-limit state is in-memory and bounded (LRU-pruned), no persistence;
  entries have no fixed expiry and may remain until eviction or restart

## API

### `POST /v1/push`

```json
{
    "platform": "ios",
    "token": "<hex APNs device token>",
    "envelope": "<standard base64, ≤ 3200 bytes>",
    "collapseId": "optional, truncated to 64 bytes",
    "priority": 10
}
```

`priority` is optional (`5` or `10`, default `10`). `collapseId` is optional
and becomes `apns-collapse-id` for iOS; it is ignored for Android.

The relay forwards to `POST /3/device/<token>` over HTTP/2 with an ES256
provider-token JWT (cached, re-signed after 45 minutes), `apns-push-type:
alert`, `apns-expiration: 0`, and the body:

```json
{"aps":{"mutable-content":1,"alert":{"title":"HAPI","body":"New activity"},"sound":"default"},"hapi":{"v":1,"e":"<envelope>"}}
```

For Android use `platform: "android"` and an opaque, case-sensitive FCM token
(non-empty printable ASCII, at most 4096 bytes). The envelope and priority
fields have the same format. The relay calls FCM HTTP v1 for its configured
project, using cached OAuth credentials and the following data-only message:

```json
{"message":{"token":"<FCM token>","data":{"hapi_v":"1","hapi_e":"<envelope>"},"android":{"priority":"HIGH","restricted_package_name":"run.hapi.companion"}}}
```

Priority `5` maps to `NORMAL`, `10` to `HIGH`. No `notification` or
`collapse_key` is sent: Android must run the local decrypt/notification code,
and FCM's four-collapse-key limit cannot represent arbitrary session IDs.
The app coalesces displayed notifications locally. FCM's existing default
TTL is retained. The relay does not queue or automatically retry sends.

Responses:

| Status | Body                                  | Meaning                                                                 |
| ------ | ------------------------------------- | ----------------------------------------------------------------------- |
| 200    | `{"ok":true}`                         | accepted by APNs/FCM (not a device delivery receipt)                                                        |
| 400    | `{"ok":false,"code":"bad_request"}`   | malformed request (plus a short `message`)                              |
| 410    | `{"ok":false,"code":"unregistered"}`  | confirmed invalid token (APNs or FCM) — hub should drop this token  |
| 413    | `{"ok":false,"code":"too_large"}`     | envelope over 3200 bytes                                                |
| 429    | `{"ok":false,"code":"rate_limited"}`  | relay or provider rate limit hit — retry later        |
| 501    | `{"ok":false,"code":"unsupported_platform"}` | requested platform has no configured provider |
| 502    | `{"ok":false,"code":"upstream"}`      | provider/auth/network failure, including Firebase project mismatch                      |

### `GET /health`

`{"status":"ok","service":"hapi-push-relay","version":"<version>"}`

## Running

From the repo root:

```sh
bun install
RELAY_APNS_KEY_P8_PATH=/path/AuthKey_XXXXXXXXXX.p8 \
RELAY_APNS_KEY_ID=XXXXXXXXXX \
RELAY_APNS_TEAM_ID=YYYYYYYYYY \
RELAY_APNS_BUNDLE_ID=run.hapi.app \
bun run relay/src/index.ts
```

Android-only startup (the service account must belong to the same Firebase
project as the official app's `google-services.json`):

```sh
RELAY_FCM_SERVICE_ACCOUNT_PATH=/secrets/firebase-service-account.json \
bun run relay/src/index.ts
```

APNs and FCM are independently optional; configure at least one. A partial
APNs configuration or unreadable/malformed configured key fails startup.
Enable the Firebase Cloud Messaging HTTP v1 API and grant the relay's
service account permission to send messages in that project. Never put the
service-account JSON in the APK, repository, or user hub configuration.

### Environment

| Variable                 | Required | Default      | Notes                                                       |
| ------------------------ | -------- | ------------ | ----------------------------------------------------------- |
| `RELAY_APNS_KEY_P8_PATH` | for iOS      | —            | path to the APNs auth key (`.p8`, PKCS#8 PEM)               |
| `RELAY_APNS_KEY_ID`      | for iOS      | —            | key id from the Apple developer portal                      |
| `RELAY_APNS_TEAM_ID`     | for iOS      | —            | Apple developer team id                                     |
| `RELAY_APNS_BUNDLE_ID`   | for iOS      | —            | iOS app bundle id (`apns-topic`)                            |
| `RELAY_APNS_ENV`         | no       | `production` | `production` or `sandbox`                                   |
| `RELAY_FCM_SERVICE_ACCOUNT_PATH` | for Android | — | service-account JSON with `project_id`, `client_email`, `private_key` |
| `RELAY_FCM_PACKAGE_NAME` | no | `run.hapi.companion` | restrict FCM sends to this Android application ID |
| `RELAY_PORT`             | no       | `8790`       | listen port                                                 |
| `RELAY_TRUST_PROXY`      | no       | off          | `1`/`true`: rate-limit by first `x-forwarded-for` hop. Only behind a proxy that overwrites the header. |

## Deploying

Any container host works — the relay is a single stateless process (rate
limits are in-memory, so run one instance, which is plenty: it only moves
~4 KB messages).

Use the prebuilt image `ghcr.io/tiann/hapi-push-relay`, available for Linux
AMD64 and ARM64. The server needs only Docker and the provider keys/configuration;
no HAPI source checkout or Bun installation is required.

```sh
docker pull ghcr.io/tiann/hapi-push-relay:latest
docker run -d --name hapi-push-relay --restart unless-stopped \
    -p 127.0.0.1:8790:8790 \
    -v /secrets/AuthKey_XXXXXXXXXX.p8:/keys/apns.p8:ro \
    -v /secrets/firebase-service-account.json:/keys/fcm.json:ro \
    -e RELAY_FCM_SERVICE_ACCOUNT_PATH=/keys/fcm.json \
    -e RELAY_APNS_KEY_P8_PATH=/keys/apns.p8 \
    -e RELAY_APNS_KEY_ID=XXXXXXXXXX \
    -e RELAY_APNS_TEAM_ID=YYYYYYYYYY \
    -e RELAY_APNS_BUNDLE_ID=run.hapi.app \
    -e RELAY_APNS_ENV=production \
    ghcr.io/tiann/hapi-push-relay:latest
```

The mounted `.p8` and service-account files must be readable by the container's `bun` user (UID 1000).
Use `production` for TestFlight/App Store and `sandbox` for development-signed
apps. For a pinned deployment, replace `latest` with a published
`sha-<full-commit-sha>` tag or image digest from the workflow output.

Terminate TLS in front of it (for example, Caddy on the same host) — hubs POST
envelopes over the public internet. If the proxy overwrites `X-Forwarded-For`
and is the only way in, set `RELAY_TRUST_PROXY=1` so per-IP rate limiting sees
real client IPs. The example exposes HTTP on host loopback only.

For deployment alongside tunwg on the same server, use the
[tunwg + Caddy + Push Compose example](https://github.com/tiann/tunwg/tree/master/examples/push-relay).
It shares public TCP 443 and preserves client IPs for rate limiting.

Check readiness with `curl -fsS http://127.0.0.1:8790/health`. This checks the
service, not provider authorization or device delivery. Verify an iOS and
an Android notification using the official builds before releasing the hub
and app updates. Deploy relay first, then hub, then Android. Watch logs for
`upstream`/`rate-limited` results and monitor FCM quota usage in Google Cloud.
FCM itself is [no-cost](https://firebase.google.com/pricing), subject to
[project/device quotas](https://firebase.google.com/docs/cloud-messaging/throttling-and-quotas);
relay hosting and bandwidth are separate costs.

### Publishing images

The [Push Relay Image workflow](../.github/workflows/push-relay-image.yml)
runs the relay type check and tests, then builds both architectures. Pushes to
`main` affecting `relay/`, the workflow, or its dependency/type-check inputs
publish `latest` and `sha-<full-commit-sha>`. Pull requests build without
publishing. To publish manually, run **Actions → Push Relay Image → Run
workflow** on `main`; dispatches on other branches only validate and build.

Publishing uses the repository's `GITHUB_TOKEN` with `packages: write`; no
registry credential needs to be added. After the first successful run, set
the `hapi-push-relay` package visibility to **Public** in GitHub Packages so
servers can pull without logging in. Forks publish under their own owner.

For local development, building from source remains available from the repo
root:

```sh
docker build -t hapi-push-relay:local relay/
```

## Pointing a hub at the relay

Both platforms default to `https://push.hapi.run`; override with
`HAPI_PUSH_RELAY_URL=https://push.example.com`. The existing persisted key
`iosPushRelayUrl` supplies this shared URL. Select `HAPI_ANDROID_PUSH=relay`
to override local Firebase credentials, `fcm` for direct Android/Wear, or
`off` to disable it. A configured but broken private Firebase account never
falls back to the official project. Select `HAPI_IOS_PUSH=apns` for direct
iOS delivery or `off` to disable iOS push.

The common hub client lives in `hub/src/push-native/`. Android relay delivery
requires an upgraded phone client that registers `pushKey`; old phone and
Wear clients continue to work with direct FCM. A hub selects one Android
project/transport, so private-project builds and official-project builds
cannot be mixed on that hub.

## Implementation notes

- HTTP/2 to APNs uses Bun's `node:http2` client — verified working on Bun
  1.3.14 against a real `node:http2` mock server (the test suite exercises
  the full wire shape, including collapse-id truncation and error mapping).
  The transport sits behind the `ApnsClient` interface in `src/apns.ts` so
  it can be swapped if a Bun upgrade ever regresses.
- The ES256 JWT signing (jose) is deliberately duplicated with the hub's APNs
  client: the relay must stay standalone and never import hub code.
- Run the tests with `bun test` from `relay/`, or `bun run test:relay` from
  the repo root.
