# Web Enter Behavior Setting Design

**Date:** 2026-05-06  
**Issue:** [#570](https://github.com/tiann/hapi/issues/570)

## Goal

Add a Web setting that controls what Enter does in the chat composer. Default stays **send**. Users can switch to **newline** mode. In newline mode, plain Enter inserts a newline and Ctrl/Cmd+Enter sends.

## Scope

- Add a persisted Web preference for composer enter behavior
- Expose the preference in the Web settings page
- Apply the preference in `HappyComposer`
- Add i18n strings in English and Simplified Chinese
- Add focused regression tests for preference helpers and settings rendering

## Non-Goals

- No per-session override
- No mobile-only special case
- No backend / shared protocol change

## Behavior

### Mode: `send` (default)
- Enter: send
- Shift+Enter: newline
- Ctrl/Cmd+Enter: keep current non-send behavior; plain Enter remains the only send shortcut

### Mode: `newline`
- Enter: newline
- Ctrl/Cmd+Enter: send
- Shift+Enter: newline

### Shared rules
- IME composition must remain untouched
- When autocomplete suggestions are open, Enter should still select the highlighted suggestion first
- Existing send button remains available in all modes

## Storage

Use localStorage key:

- `hapi-composer-enter-behavior`

Allowed values:

- `send`
- `newline`

Fallback:

- invalid / missing value => `send`

## UI

Add a new settings section item in Web settings:

- Section: Chat
- Label: Enter Key
- Options:
  - Send message
  - Insert newline

This should follow the existing dropdown interaction pattern already used in settings.

## Files

- New: `web/src/hooks/useComposerEnterBehavior.ts`
- New: `web/src/hooks/useComposerEnterBehavior.test.ts`
- Modify: `web/src/routes/settings/index.tsx`
- Modify: `web/src/routes/settings/index.test.tsx`
- Modify: `web/src/components/AssistantChat/HappyComposer.tsx`
- Modify: `web/src/lib/locales/en.ts`
- Modify: `web/src/lib/locales/zh-CN.ts`

## Testing

- Verify helper options + storage fallback logic
- Verify settings page shows the new translated setting and selected label
- Run targeted web tests
- Run `web` typecheck
