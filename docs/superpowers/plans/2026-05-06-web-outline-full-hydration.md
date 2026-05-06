# Web Outline Full Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web-only conversation outline pipeline that hydrates full outline history in the background and can locate unloaded old items by paging the thread on demand.

**Architecture:** Keep the chat thread on the existing message window store. Add a separate outline store keyed by session id, hydrate it from the existing paginated `/messages` endpoint, and expose it through a React hook. When the user selects an old outline item, load older thread pages until the target message enters the thread DOM, then scroll to it.

**Tech Stack:** React 19, TypeScript strict, custom external-store pattern, existing `ApiClient.getMessages`, Vitest.

---

### Task 1: Add low-level outline extraction helpers

**Files:**
- Modify: `web/src/chat/outline.ts`
- Test: `web/src/chat/outline.test.ts`

- [ ] Add pure helpers that can derive a `ConversationOutlineItem` from `NormalizedMessage` / `DecryptedMessage`-derived user text without going through full chat block reduction.
- [ ] Preserve current truncation, whitespace collapsing, and target anchor conventions.
- [ ] Add tests for user-text extraction, non-user filtering, and duplicate-safe stable ids.

### Task 2: Build outline store

**Files:**
- Create: `web/src/lib/outline-store.ts`
- Test: `web/src/lib/outline-store.test.ts`

- [ ] Implement per-session outline state with subscribe/get/reset semantics similar to `message-window-store`.
- [ ] Implement `hydrateOutline(api, sessionId, seedItems?)` using existing `ApiClient.getMessages(... byPosition ...)` paging until `hasMore=false`, with single-flight protection and duplicate filtering.
- [ ] Implement incremental append for newly received user messages and invalidation/reset for `messages-invalidated`.
- [ ] Implement locating flags (`isLocating`, `locatingTargetMessageId`) and exported setters for UI.
- [ ] Cover success, pagination, duplicate pages, invalidation, and single-flight behavior in tests.

### Task 3: Add React hook for outline state

**Files:**
- Create: `web/src/hooks/queries/useConversationOutline.ts`
- Test: `web/src/hooks/queries/useConversationOutline.test.ts` (or fold into component tests if lighter)

- [ ] Wrap the outline store with `useSyncExternalStore`.
- [ ] Expose `items`, `status`, `complete`, `error`, `isLocating`, `startHydrating`, `retryHydrating`, `markInvalidated`, `ingestIncomingMessage`.
- [ ] Accept seed outline items from current thread blocks so the panel can render immediately before background hydration completes.

### Task 4: Wire SSE events into outline cache

**Files:**
- Modify: `web/src/hooks/useSSE.ts`
- Possibly Modify: `web/src/App.tsx` (only if event ownership fits better there)
- Test: existing SSE-adjacent tests if any; otherwise store-level tests only

- [ ] On `message-received`, incrementally append user outline items to a complete outline cache.
- [ ] On `messages-invalidated` / session removal, reset the matching outline cache.
- [ ] Keep this logic side-effect-light so it does not disturb existing message window flow.

### Task 5: Use outline hook in SessionChat

**Files:**
- Modify: `web/src/components/SessionChat.tsx`
- Test: `web/src/components/AssistantChat/HappyThread.test.tsx` or a new `SessionChat` test if needed

- [ ] Seed immediate outline items from current `reconciled.blocks`.
- [ ] Replace direct `buildConversationOutline(reconciled.blocks)` consumption with `useConversationOutline(...)`.
- [ ] When outline opens, trigger background hydration if needed.
- [ ] Provide async selection handler that can load older thread pages until the target message is present before asking `HappyThread` to scroll.

### Task 6: Extend HappyThread outline UI states

**Files:**
- Modify: `web/src/components/AssistantChat/HappyThread.tsx`
- Test: `web/src/components/AssistantChat/HappyThread.test.tsx`

- [ ] Extend `ConversationOutlinePanel` props for loading/complete/error/locating states.
- [ ] Show “正在补全大纲… / 已完整 / 重试补全 / 正在定位…” style states without cluttering the panel.
- [ ] Allow async `onSelect`; disable repeated actions while locating.
- [ ] Preserve existing in-thread scroll behavior for already-loaded targets.

### Task 7: Verify locate-old-item flow end to end

**Files:**
- Modify tests only as needed
- Test: `web/src/lib/outline-store.test.ts`, `web/src/components/AssistantChat/HappyThread.test.tsx`, possible `SessionChat` test

- [ ] Add a regression test for selecting a target outside the current thread window and repeatedly calling `onLoadMore` until found.
- [ ] Add a regression test for keeping cached outline items across session page unmount/remount.
- [ ] Run targeted tests, then full `web` test suite and `typecheck`.

### Task 8: Final verification

**Files:**
- No source changes unless fixes are needed

- [ ] Run: `cd web && bun run test`
- [ ] Run: `cd web && bun run typecheck`
- [ ] Manually sanity check long-session UX if a local environment is available.
- [ ] Summarize behavior changes and any remaining trade-offs.
