# Contract Tests

This folder defines the canonical contract surface for Hub compatibility.

- `http-contracts.ts`: HTTP endpoints, methods, and minimal response shapes.
- `socket-contracts.ts`: Socket.IO events and ACK shapes.
- `sse-contracts.ts`: SSE event types and fields.
- `http-recordings.ts`: Recorded Bun Hub HTTP responses (full fields).
- `sse-recordings.ts`: Recorded Bun Hub SSE events (full fields).
- `sse-samples.ts`: Synthetic SSE samples for event types not recorded at runtime.

Recording workflow (manual):
1. Start Bun Hub and capture real responses/events.
2. Update contract files to match actual payloads.
3. Use these contracts as the baseline for Go Hub parity tests.

Recordings are stored under `hub_go/test/recordings/*` and mirrored into
`http-recordings.ts` / `sse-recordings.ts` for easy diffing.

If runtime recording is blocked (e.g. missing live CLI/Socket.IO),
`sse-samples.ts` provides source-derived examples to complete the contract.
