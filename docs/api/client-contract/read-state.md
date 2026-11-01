# Session read state

Sources: `shared/src/sessionReadState.ts`, `shared/src/messages.ts`,
`hub/src/store/sessionReadState.ts`, `hub/src/sync/messageService.ts`.

Read state is shared by Web, iOS and Android within one Hub and JWT namespace.
CLI terminal activity does not acknowledge reading. `updatedAt`, message `seq`,
permission state and transport heartbeat are independent of unread status.

## Revisions and unread

Session, SessionSummary and session SSE patches carry:

```ts
contentRevision: number
readState: { readRevision: number; manualUnread: boolean; version: number }
```

The hub increments `contentRevision` atomically with a new readable assistant
message: answer text, rendered media or an error. User prompts, reasoning, tool
traffic, usage, metadata and heartbeats do not advance it. Imported/copied
history starts at zero; live delayed output counts. A replay with the same
`localId` keeps its original revision. Meaningful message rows carry their
`contentRevision` in REST and SSE.

Unread is `manualUnread || (!(active && thinking) && contentRevision > readRevision)`.
Running suppresses the ordinary dot without discarding unseen content. Input and
permission attention remain independent. Selecting a session does not make it read.
Clients merge revisions monotonically and use the highest read-state `version`
for the manual flag, including when REST and SSE arrive out of order.

## Read acknowledgement

`PUT /api/sessions/:id/read-state` accepts one of:

```json
{"type":"read","readRevision":12,"expectedVersion":4}
```

```json
{"type":"unread","expectedVersion":4}
```

The response includes `{status, contentRevision, readState}`. Counters must be
nonnegative safe integers. An invalid/future revision returns 400. Manual unread
uses compare-and-set: a mismatched version returns 409 with authoritative state.
Read requests advance by maximum; they clear manual unread only when
`expectedVersion` matches. Thus an older automatic read cannot erase a newer
manual choice, and an acknowledgement of revision 12 cannot consume revision 13.
An old session ID resolving to a replacement returns 409: revisions cannot be
replayed against a different session. Namespace access is checked before mutation.
Read writes emit `session-updated` patches without advancing `updatedAt`.

Automatic reads require a visible foreground chat, successful message loading,
and the latest tail laid out on screen. Background, history browsing, hidden
inspectors/terminals, failed loads and list navigation cannot acknowledge reading.
A read-state-only update is not a new viewing action. Explicit “mark all read”
uses the content revisions observed in that list action.

Latest message pages carry `page.readThroughRevision`. A completed forward
catch-up carries it only if its snapshot still reaches the current head. Before
pages and partial/bounded catch-ups cannot certify a later head. Clients retain
the receipt with the corresponding message window; they can advance it with
rendered incoming message revisions after initial tail synchronization. Never
substitute the summary’s head revision for a rendered window receipt.

## Offline and lifecycle

Persist the exact observed revision and expected version in a durable outbox
before presenting a successful local read. Retry transient failures, including
after restart/foregrounding. Each operation has an ID so an old response cannot
remove a newer queued operation. Authoritative 400/403/404/409 rejection rolls
back the optimistic mark; do not blindly rebase onto a newer manual choice.
Storage keys include Hub origin and JWT namespace; never derive namespace by
splitting the pairing access token. Switching Hub must finish pending disk writes.

## Upgrade and history changes

Database v30 adds persistent read fields with zero defaults. Existing history
becomes a read baseline once; old client timestamp/manual-marker files are ignored.
This clears old unread dots on upgrade, while pending approvals/input remain.
Update Hub and clients together; clients do not fall back to timestamp-based reads.

Fork/import copies are baseline history. A session merge translates unread source
revisions above the destination head, transfers manual unread, and retires the
source state. Client windows seeded across IDs discard old message revisions and
fetch a fresh tail. Rewind never reuses revisions; if all unread output is removed,
it retires that output while preserving an explicit manual-unread choice.
