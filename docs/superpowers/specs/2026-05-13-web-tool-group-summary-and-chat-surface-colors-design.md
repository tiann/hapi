# Web Tool Group Summary and Chat Surface Colors Design

**Date:** 2026-05-13

## Goal

Improve grouped tool-use readability in `web` and add lightweight appearance controls for two chat surfaces:

1. grouped tool-use cards should show friendly one-line multilingual summaries instead of raw paths / shell commands in collapsed and row-list states
2. users should be able to customize the background colors for grouped tool-use cards and user message bubbles from Settings using presets or the native color picker

## Scope

- Change grouped tool-use summary generation used by `ToolGroupCard`
- Keep grouped card detail dialogs unchanged so raw paths / commands remain inspectable on demand
- Add local persisted appearance settings for:
  - grouped tool-use background
  - user message background
- Expose both settings in `Settings > Chat`
- Add i18n copy in English and Simplified Chinese
- Add focused Web regression tests for grouped summaries and appearance preference helpers / rendering

## Non-Goals

- No backend / hub / shared protocol changes
- No change to single `ToolCard` background or summary behavior
- No change to assistant message background
- No server-side synced theme settings
- No separate light / dark mode color palettes
- No restore-default action button; `Default color` preset covers reset behavior

## Agreed Product Decisions

- Background customization applies only to:
  - grouped tool-use cards
  - user message bubbles
- Single `ToolCard` stays visually unchanged
- Default built-in colors stay unchanged unless the user explicitly picks another preset or custom color
- Storage is local only (`localStorage`)
- Preset list is fixed to:
  - Default color
  - Soft blue
  - Soft green
  - Soft yellow
- Native color picker remains available for both settings
- Preset selection and custom color selection should apply immediately
- Grouped summaries should be single-line, friendly, and multilingual
- Grouped summaries should avoid directly exposing raw absolute paths / full shell commands in collapsed group UI
- Detailed raw information remains available in the existing detail dialog for each grouped row

## Grouped Summary Behavior

### Summary surfaces

Apply the new friendly summary logic only to grouped-tool UI surfaces:

- grouped card header title
- grouped card expanded row labels

Do not apply this logic to:

- single standalone `ToolCard`
- tool detail dialogs
- trace sections inside tool dialogs

### Header summary rules

Collapsed grouped-card title should prefer a semantic activity label over raw target text.

Priority:

1. friendly semantic description inferred from grouped tool category and known command pattern
2. localized fallback activity label by tool kind
3. `+n` suffix when the grouped card contains more than one summarized item

Examples:

- `Get-ChildItem ...`, `ls`, `dir`, `Get-Content ...` -> `检查项目文件 +4` / `Inspect project files +4`
- `rg ...`, `Select-String ...` -> `搜索项目内容 +2` / `Search project content +2`
- `bun test`, `npm run build` -> `执行项目命令 +1` / `Run project commands +1`
- mixed file edits -> `修改项目文件 +3` / `Edit project files +3`

The header subtitle should remain a short localized aggregate counter line, e.g.:

- `执行 5` / `Run 5`
- `搜索 3 · 读取 2`

All grouped header lines must remain one-line truncating text.

### Expanded row rules

Each grouped row should display a one-line friendly label using the same grouped-summary helper style:

- semantic, localized, concise
- no raw full path / raw shell command preview in the row itself
- status badge behavior unchanged
- click row -> existing detail dialog with full raw input / result

### Command heuristics

For command-like grouped tools, use lightweight heuristics only; no heavy parser or backend change.

Recommended buckets:

- file inspection commands
- content search commands
- project command execution
- file modification commands
- generic command fallback

If the heuristic is uncertain, prefer a safe generic localized label rather than leaking the full command.

## Appearance Settings Behavior

### Settings location

Add two new items under `Settings > Chat`:

- Grouped Tool Use Background
- User Message Background

Each item should expose:

- preset chips / options
- native color picker
- current selected state

### Storage model

Use two independent local preferences. Each preference represents a selection mode rather than only a raw hex value.

Suggested shape:

- `default`
- `preset:<key>`
- `custom:#RRGGBB`

This keeps `Default color` as a first-class option and avoids special reset UI.

### Presets

Fixed preset list for both settings:

- `default`
- `soft-blue`
- `soft-green`
- `soft-yellow`

The preset list is shared across light and dark themes.

### Visual application

Default state:

- grouped cards use current `--app-tool-card-bg`-derived grouped background behavior
- user bubbles use current `--app-chat-user-bg`

Configured state:

- grouped card background uses a dedicated grouped-surface CSS variable override
- user bubble background uses a dedicated user-surface CSS variable override

To avoid overly loud colors, the chosen preset / custom color should be softened before final render so the result is slightly eye-catching but still aligned with the current chat palette.

## Files

### Grouped summary work

- Modify: `web/src/chat/toolGroups.ts`
- Modify: `web/src/components/ToolCard/ToolGroupCard.tsx`
- New or Modify helper: grouped summary / presentation helper near `ToolCard` grouped UI
- Modify: `web/src/lib/locales/en.ts`
- Modify: `web/src/lib/locales/zh-CN.ts`

### Appearance settings work

- Modify: `web/src/index.css`
- New: `web/src/hooks/useChatSurfaceColors.ts`
- Modify: `web/src/routes/settings/index.tsx`
- Modify: `web/src/components/AssistantChat/messages/user-bubble.tsx`
- Modify: `web/src/components/AssistantChat/messages/ToolMessage.tsx` only if grouped wrapper styling needs variable plumb-through
- Modify: `web/src/components/ToolCard/ToolGroupCard.tsx`
- Modify: `web/src/lib/locales/en.ts`
- Modify: `web/src/lib/locales/zh-CN.ts`

## Testing

- Add grouped-summary regression coverage:
  - localized friendly label generation
  - no raw path / full command in grouped header / row summaries
  - `+n` suffix behavior
  - single-line truncation-safe rendering expectations
- Add appearance preference helper coverage:
  - storage parsing
  - invalid value fallback to `default`
  - preset selection
  - custom hex selection
- Add settings-page rendering coverage for the two new appearance options
- Add component coverage for grouped-card and user-bubble variable application where practical
- Run focused `web` tests and `web` typecheck

## Notes

- Keep implementation pragmatic; no new cross-package schema needed
- Reuse current Settings interaction patterns where possible
- Prefer isolated Web-only helpers over changing existing single-tool presentation logic
