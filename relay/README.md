# hapi-push-relay

The official HAPI push relay: a tiny standalone service that forwards
end-to-end-encrypted push envelopes from self-hosted HAPI hubs to Apple's
Push Notification service (APNs).

## Why it exists

HAPI hubs are self-hosted, but the iOS app is signed by the project owner —
only the owner's APNs auth key can push to it. This relay holds that key
centrally. A hub that does not configure its own APNs credentials POSTs its
(already encrypted) notification payloads here, and the relay forwards them
to Apple.

Hubs that *do* provision their own Apple developer account + APNs key talk
to APNs directly (see `hub/src/apns/`, work package P1) and never touch this
service.

## Threat model and privacy

**The relay sees ciphertext only.** The notification content is encrypted by
the hub with AES-256-GCM under a per-device key that only the hub and the
device know. The relay (and Apple) forward opaque bytes; the iOS
Notification Service Extension decrypts locally on the device
(`mutable-content: 1` with a fixed placeholder alert of "HAPI / New
activity" that the extension rewrites). What the relay *can* observe is
metadata: the APNs device token, request timing, and envelope size. It
stores nothing and logs no payloads — log lines carry only a hashed token
prefix (first 12 hex chars of SHA-256) and the outcome.

**No client authentication, by design.** Possession of a device token *is*
the capability, the same trust model FCM uses: APNs device tokens are
unguessable, and anyone who somehow obtains one can at worst trigger generic
"New activity" banners on that one device (they cannot forge decryptable
content without the AES key; the device drops envelopes that fail
decryption). Requiring accounts would force self-hosters to register with
the relay, which is exactly what HAPI avoids. Mitigations instead:

- per-device-token rate limit: 30 pushes/minute (token bucket, burst 30)
- per-client-IP rate limit: 300 pushes/minute (token bucket, burst 300)
- envelope size cap: 3200 bytes (base64 as transmitted), plus a 64 KB cap
  on the whole request body
- rate-limit state is in-memory and bounded (LRU-pruned), no persistence

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
and becomes `apns-collapse-id`.

The relay forwards to `POST /3/device/<token>` over HTTP/2 with an ES256
provider-token JWT (cached, re-signed after 45 minutes), `apns-push-type:
alert`, `apns-expiration: 0`, and the body:

```json
{"aps":{"mutable-content":1,"alert":{"title":"HAPI","body":"New activity"},"sound":"default"},"hapi":{"v":1,"e":"<envelope>"}}
```

Responses:

| Status | Body                                  | Meaning                                                                 |
| ------ | ------------------------------------- | ----------------------------------------------------------------------- |
| 200    | `{"ok":true}`                         | accepted by APNs                                                        |
| 400    | `{"ok":false,"code":"bad_request"}`   | malformed request (plus a short `message`)                              |
| 410    | `{"ok":false,"code":"unregistered"}`  | APNs said `Unregistered`/`BadDeviceToken` — hub should drop this token  |
| 413    | `{"ok":false,"code":"too_large"}`     | envelope over 3200 bytes                                                |
| 429    | `{"ok":false,"code":"rate_limited"}`  | relay rate limit hit (or APNs throttled the token) — retry later        |
| 501    | `{"ok":false,"code":"unsupported_platform"}` | `platform:"android"` (shape reserved; Android uses FCM directly today) |
| 502    | `{"ok":false,"code":"upstream"}`      | APNs 5xx, other APNs rejection, or network failure                      |

### `GET /health`

`{"status":"ok","service":"hapi-push-relay","version":"<version>"}`

## Running

From the repo root:

```sh
bun install
RELAY_APNS_KEY_P8_PATH=/path/AuthKey_XXXXXXXXXX.p8 \
RELAY_APNS_KEY_ID=XXXXXXXXXX \
RELAY_APNS_TEAM_ID=YYYYYYYYYY \
RELAY_APNS_BUNDLE_ID=app.hapi.ios \
bun run relay/src/index.ts
```

### Environment

| Variable                 | Required | Default      | Notes                                                       |
| ------------------------ | -------- | ------------ | ----------------------------------------------------------- |
| `RELAY_APNS_KEY_P8_PATH` | yes      | —            | path to the APNs auth key (`.p8`, PKCS#8 PEM)               |
| `RELAY_APNS_KEY_ID`      | yes      | —            | key id from the Apple developer portal                      |
| `RELAY_APNS_TEAM_ID`     | yes      | —            | Apple developer team id                                     |
| `RELAY_APNS_BUNDLE_ID`   | yes      | —            | iOS app bundle id (`apns-topic`)                            |
| `RELAY_APNS_ENV`         | no       | `production` | `production` or `sandbox`                                   |
| `RELAY_PORT`             | no       | `8790`       | listen port                                                 |
| `RELAY_TRUST_PROXY`      | no       | off          | `1`/`true`: rate-limit by first `x-forwarded-for` hop. Only behind a proxy that overwrites the header. |

## Deploying

Any container host works — the relay is a single stateless process (rate
limits are in-memory, so run one instance, which is plenty: it only moves
~4 KB messages).

```sh
docker build -t hapi-push-relay relay/
docker run -d --name hapi-push-relay \
    -p 8790:8790 \
    -v /secrets/AuthKey_XXXXXXXXXX.p8:/keys/apns.p8:ro \
    -e RELAY_APNS_KEY_P8_PATH=/keys/apns.p8 \
    -e RELAY_APNS_KEY_ID=XXXXXXXXXX \
    -e RELAY_APNS_TEAM_ID=YYYYYYYYYY \
    -e RELAY_APNS_BUNDLE_ID=app.hapi.ios \
    hapi-push-relay
```

Terminate TLS in front of it (Caddy, nginx, or your platform's ingress) —
hubs POST envelopes over the public internet. If the proxy is the only way
in, set `RELAY_TRUST_PROXY=1` so per-IP rate limiting sees real client IPs.

## Pointing a hub at the relay

A hub without its own APNs credentials sends iOS pushes through the relay
configured by `HAPI_PUSH_RELAY_URL` (e.g.
`HAPI_PUSH_RELAY_URL=https://push.example.com`). Hubs with
self-configured APNs keys ignore the relay entirely. See `hub/src/apns/`
(P1) for the hub-side client that speaks the `POST /v1/push` contract above.

## Implementation notes

- HTTP/2 to APNs uses Bun's `node:http2` client — verified working on Bun
  1.3.14 against a real `node:http2` mock server (the test suite exercises
  the full wire shape, including collapse-id truncation and error mapping).
  The transport sits behind the `ApnsClient` interface in `src/apns.ts` so
  it can be swapped if a Bun upgrade ever regresses.
- The ES256 JWT signing (jose) is deliberately duplicated with the hub's P1
  client: the relay must stay standalone and never import hub code.
- Run the tests with `bun test` from `relay/`, or `bun run test:relay` from
  the repo root.
