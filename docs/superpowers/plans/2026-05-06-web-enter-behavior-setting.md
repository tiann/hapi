# Web Enter Behavior Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted Web setting that switches composer Enter behavior between send and newline modes.

**Architecture:** Store the preference in a dedicated Web hook backed by localStorage, surface it through the existing settings dropdown UI, and branch the composer Enter handling based on the selected mode while preserving IME and autocomplete behavior.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, localStorage-backed hooks, project i18n dictionaries.

---

## File Structure

- New: `web/src/hooks/useComposerEnterBehavior.ts` — composer enter behavior type, options, storage helpers, React hook
- New: `web/src/hooks/useComposerEnterBehavior.test.ts` — helper-level regression tests
- Modify: `web/src/routes/settings/index.tsx` — add settings dropdown and wire hook
- Modify: `web/src/routes/settings/index.test.tsx` — assert new setting renders and uses i18n key
- Modify: `web/src/components/AssistantChat/HappyComposer.tsx` — apply behavior to Enter handling
- Modify: `web/src/lib/locales/en.ts` — English labels
- Modify: `web/src/lib/locales/zh-CN.ts` — Chinese labels

### Task 1: Preference hook

**Files:**
- Create: `web/src/hooks/useComposerEnterBehavior.ts`
- Test: `web/src/hooks/useComposerEnterBehavior.test.ts`

- [ ] Define `ComposerEnterBehavior = 'send' | 'newline'`
- [ ] Add helper `getComposerEnterBehaviorOptions()` returning the two values with translation keys
- [ ] Add localStorage-backed parser with default fallback to `send`
- [ ] Add `useComposerEnterBehavior()` hook consistent with existing hook patterns
- [ ] Add helper tests for options, default fallback, invalid fallback, valid stored value

### Task 2: Settings integration + i18n

**Files:**
- Modify: `web/src/routes/settings/index.tsx`
- Modify: `web/src/routes/settings/index.test.tsx`
- Modify: `web/src/lib/locales/en.ts`
- Modify: `web/src/lib/locales/zh-CN.ts`

- [ ] Add i18n keys for chat section, enter key label, send option, newline option
- [ ] Add dropdown open/close state and refs in settings page
- [ ] Render the new Chat section using the existing settings dropdown UI pattern
- [ ] Show translated current label from selected behavior option
- [ ] Extend settings page tests to assert the new setting renders and translation key is used

### Task 3: Composer behavior

**Files:**
- Modify: `web/src/components/AssistantChat/HappyComposer.tsx`

- [ ] Read composer enter behavior from the new hook
- [ ] Keep IME guard unchanged
- [ ] Keep suggestion selection precedence on Enter unchanged
- [ ] In `send` mode keep plain Enter send behavior
- [ ] In `newline` mode allow plain Enter default newline behavior, but send on Ctrl/Cmd+Enter
- [ ] Keep Shift+Enter newline behavior in both modes

### Task 4: Verification

**Files:**
- No source change required unless verification exposes defects

- [ ] Run: `cd web && bun run test -- src/hooks/useComposerEnterBehavior.test.ts src/routes/settings/index.test.tsx`
- [ ] Run: `cd web && bun run typecheck`
- [ ] Review diff to confirm scope is limited to Web setting + i18n + composer logic
