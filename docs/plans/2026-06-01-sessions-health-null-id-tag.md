# Plan: hapi-sessions-health --json returns null id/tag for WORKING entries

**Status:** open, low priority
**Filed:** 2026-06-01 22:00 UTC
**Found by:** patient-restart wiring (commit pending)

## Symptom

```bash
$ scripts/hapi-sessions-health.sh --json \
    | jq '.sessions[] | select(.status == "WORKING")'
{ "id": null, "tag": null, "status": "WORKING", "last_seen_ms_ago": null }
{ "id": null, "tag": null, "status": "WORKING", "last_seen_ms_ago": null }
```

Count is correct (2 WORKING sessions exist), but every `WORKING` entry comes
back with `id: null`, `tag: null`, `last_seen_ms_ago: null`. Non-WORKING
entries presumably (untested) come back populated.

## Why it matters

`hapi-restart-hub` and `hapi-use-worktree` patient-drain block on the count
which is correct, so functionality is intact. But when the drain timeout
fires, they want to log *who* is still WORKING — that log line is currently
useless ("still WORKING: id=? tag=?"). Same with `hapi-driver-status`'s
WORKING summary.

## Where to look

- `scripts/hapi-sessions-health.sh` (51KB bash) — see whatever JSON-shaping
  block emits the `.sessions[]` array. The status branch likely strips
  identifying fields for the WORKING case (cargo-culted ETag privacy?
  short-circuit on hub poll timeout?).
- Hub API: confirm `GET /api/sessions` actually returns id+tag for sessions
  it considers WORKING. If hub omits them server-side that's the real bug.

## Fix sketch (not yet)

1. Decide: are id/tag deliberately omitted (privacy/auth-token leakage
   risk) or accidentally dropped? If deliberate, surface a redacted hash
   instead so operators still know *who* (matched against `hapi-driver-status`).
2. If accidental: probably one missing field assignment in the WORKING
   branch of the JSON shaper.
3. Test by triggering a patient drain timeout and confirming the log line
   names the offenders.

## Workaround until then

Cross-reference `hapi-driver-status` WORKING count against the hub UI at
`https://hapi.tail9944ee.ts.net/sessions` — anything marked WORKING in the
UI matches the count from the health script.
