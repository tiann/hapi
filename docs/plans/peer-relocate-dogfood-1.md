# Peer relocate — dogfood test #1 (manual)

**Date:** 2026-05-30  
**Operator intent:** Mermaid/lightbox thread landed in the **peer-agent spec** session by mistake; relocate to dedicated peer and expunge from parent with summary.

| Role | HAPI session ID | Title |
|------|-----------------|-------|
| **Parent** | `8d4f8729-90b2-438c-9b01-63c1e9037a7e` | peer agent product \| from upstream issue/pr discovery |
| **Peer (child)** | `cf9e7674-5c3e-42b8-ae03-d430c0cd9b12` | Peer: #737 Mermaid diagram lightbox |

**Diversion slice:** `fromSeq=231` (user paste: upstream mermaid search) through `toSeq=264` (last agent turn before relocate request).  
**Pre-diversion:** seq 1–230 (imported peer-agent backlog + spec work).

---

## What we did (procedure)

Script: `scripts/peer-relocate-dogfood.sh [parentId] [fromSeq] [toSeq] [peerTitle] [issue]`

| Step | Mechanism | Product analogue |
|------|-----------|------------------|
| 1 | `POST /api/machines/:machineId/spawn` (cursor, yolo, hapi dir) | `spawn-peer` |
| 2 | `PATCH /api/sessions/:peerId` `{name}` | title template |
| 3 | `cp` hub sqlite backup; `UPDATE messages SET session_id=peer WHERE … seq BETWEEN` | `relocateSessionMessages` |
| 4 | `POST /api/sessions/:parentId/messages` tombstone text | `insertHubTombstone` |
| 5 | `POST …/messages` `/summarize …` + recap instructions on parent | `parentContext.policy=compact` (Cursor strategy) |
| 6 | `POST …/messages` bootstrap digest on peer | `relocatedContextDigest` |

**Not done (no API / no wiring):**

- No `metadata.parentSessionId` / `spawnKind: peer` on child (metadata patch not exposed on spawn).
- No `conversation-relocated` event type (tombstone is plain user message prefixed `[HAPI relocation]`).
- No SSE `messages-invalidated` after raw SQL (operator refreshes web).
- **Cursor IDE transcript** for parent not rewritten — only hub DB + queued `/summarize`.

---

## Outcomes to verify (operator)

- [ ] Parent web thread: mermaid block gone; tombstone + summarize message visible.
- [ ] Peer web thread: moved tool trace + bootstrap at top.
- [ ] Parent Cursor agent: context drops after `/summarize` runs (may fail if headless ignores slash).
- [ ] This Cursor chat (IDE): **unchanged** — dogfood did not edit IDE transcript.

---

## Findings for peer-agent spec

1. **Relocate without SQL/API is cosmetic** — confirmed; only step 3 changes hub history.
2. **Tombstone as user message works** for dogfood; product should use typed event + link component.
3. **Parent `/summarize` is the right Cursor compact hook** until `parseSpecialCommand` parity exists.
4. **Pre-diversion recap belongs inside summarize prompt** — operator-validated wording in script.
5. **`parentCompactTargetPct: 40`** — not measured this run; need `token-count` before/after on parent.
6. **Child cold start** — bootstrap message required; moved rows alone do not seed Cursor native thread.
7. **Implement next:** `POST /api/sessions/:id/spawn-peer` wrapping steps 1–6; never raw SQL in product.
8. **Follow-up issue:** [#738](https://github.com/tiann/hapi/issues/738) — wire Cursor `/summarize`; peer `309ebaf8-c19c-4cc4-83eb-698f50c948d9`.

---

## Run log

```text
parent=8d4f8729-90b2-438c-9b01-63c1e9037a7e  from_seq=231  to_seq=264
peer spawned=cf9e7674-5c3e-42b8-ae03-d430c0cd9b12
messages moved=34
db backup=/home/heavygee/.hapi/hapi.db.bak.peer-relocate-20260530115732
parent url=https://hapi.tail9944ee.ts.net/sessions/8d4f8729-90b2-438c-9b01-63c1e9037a7e
peer url=https://hapi.tail9944ee.ts.net/sessions/cf9e7674-5c3e-42b8-ae03-d430c0cd9b12
```
