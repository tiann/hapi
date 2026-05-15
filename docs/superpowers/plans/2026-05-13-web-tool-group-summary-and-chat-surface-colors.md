# Web Tool Group Summary and Chat Surface Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make grouped tool-use cards read like friendly one-line activity summaries instead of raw paths / shell commands, and add local Web settings to customize grouped-card and user-message backgrounds with preset colors or the native color picker.

**Architecture:** Keep all changes Web-only. Add a grouped-summary helper dedicated to `ToolGroupCard` so standalone `ToolCard` behavior remains untouched. Add a local-storage-backed `useChatSurfaceColors` hook that resolves `default` / `preset:*` / `custom:#RRGGBB` preferences into CSS variable overrides for `--app-tool-group-bg` and `--app-chat-user-surface-bg`. Follow repo preference: no proactive TDD; implement directly, then add durable focused regression tests.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, existing i18n dictionaries, localStorage-backed preference hooks, Vitest, Testing Library.

---

## File Structure

- New: `web/src/components/ToolCard/groupedPresentation.ts` — grouped-only semantic summary helper for header and row labels
- New: `web/src/components/ToolCard/groupedPresentation.test.ts` — localized summary and command-heuristic regressions
- New: `web/src/hooks/useChatSurfaceColors.ts` — local-storage-backed grouped/user surface color preferences + CSS variable application
- New: `web/src/hooks/useChatSurfaceColors.test.ts` — parsing, fallback, preset, custom, and style-application regressions
- Modify: `web/src/App.tsx` — initialize chat surface colors once at app startup
- Modify: `web/src/components/ToolCard/ToolGroupCard.tsx` — switch grouped header / row rendering to grouped semantic summaries and grouped background variable
- Modify: `web/src/components/ToolCard/ToolGroupCard.test.tsx` — verify friendly header / row labels and grouped background usage
- Modify: `web/src/components/AssistantChat/messages/user-bubble.tsx` — use dedicated user-surface background variable
- Modify: `web/src/routes/settings/index.tsx` — add grouped-card and user-message background controls under Chat settings
- Modify: `web/src/routes/settings/index.test.tsx` — verify new settings labels and selected values render
- Modify: `web/src/index.css` — define default grouped / user-surface CSS variables
- Modify: `web/src/lib/locales/en.ts` — grouped summary and settings color copy
- Modify: `web/src/lib/locales/zh-CN.ts` — grouped summary and settings color copy

## Task 1: Add grouped-only semantic summary helper

**Files:**
- Create: `web/src/components/ToolCard/groupedPresentation.ts`
- Create: `web/src/components/ToolCard/groupedPresentation.test.ts`
- Modify: `web/src/components/ToolCard/ToolGroupCard.tsx`

- [ ] **Step 1: Create grouped-only summary types and command heuristic buckets**

Create `web/src/components/ToolCard/groupedPresentation.ts` with grouped-only helpers so standalone tool presentation remains unchanged.

```ts
export type GroupedSummaryIntent =
    | 'inspect-files'
    | 'search-content'
    | 'run-project-command'
    | 'modify-files'
    | 'open-web'
    | 'generic-command'
    | 'generic-tool'

export function inferGroupedSummaryIntent(tool: ToolCallBlock): GroupedSummaryIntent {
    const toolName = tool.tool.name
    const command = getInputStringAny(tool.tool.input, ['command', 'cmd'])?.toLowerCase() ?? ''

    if (toolName === 'Read' || toolName === 'LS' || /\b(get-childitem|ls|dir|get-content|cat|type)\b/.test(command)) return 'inspect-files'
    if (toolName === 'Grep' || toolName === 'Glob' || /\b(rg|grep|select-string|findstr)\b/.test(command)) return 'search-content'
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit') return 'modify-files'
    if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'open-web'
    if (toolName === 'Bash' || toolName === 'CodexBash' || toolName === 'shell_command') return 'run-project-command'
    return 'generic-tool'
}
```

- [ ] **Step 2: Add localized header / subtitle / row formatter helpers**

In the same file, add three helpers used only by grouped cards.

```ts
export function formatGroupedHeaderTitle(
    block: ToolGroupBlock,
    t: Translator,
): string {
    const primaryTool = block.tools[0]
    const primaryLabel = intentToFriendlyLabel(inferGroupedSummaryIntent(primaryTool), t)
    const extraCount = block.tools.length - 1
    return extraCount > 0 ? `${primaryLabel} +${extraCount}` : primaryLabel
}

export function formatGroupedHeaderSubtitle(
    block: ToolGroupBlock,
    t: Translator,
): string | null {
    const parts: string[] = []
    if (block.summary.countsByKind.command > 0) parts.push(t('toolGroup.summary.command', { n: block.summary.countsByKind.command }))
    if (block.summary.countsByKind.search > 0) parts.push(t('toolGroup.summary.search', { n: block.summary.countsByKind.search }))
    if (block.summary.countsByKind.read > 0) parts.push(t('toolGroup.summary.read', { n: block.summary.countsByKind.read }))
    if (block.summary.countsByKind.mutation > 0) parts.push(t('toolGroup.summary.mutation', { n: block.summary.countsByKind.mutation }))
    if (block.summary.countsByKind.web > 0) parts.push(t('toolGroup.summary.web', { n: block.summary.countsByKind.web }))
    return parts.length > 0 ? parts.join(' · ') : t('toolGroup.summary.other', { n: block.tools.length })
}

export function formatGroupedRowLabel(
    tool: ToolCallBlock,
    t: Translator,
): string {
    return intentToFriendlyLabel(inferGroupedSummaryIntent(tool), t)
}
```

Use existing `block.summary.countsByKind` for aggregate counters. Keep `+n` logic in the header title only.

- [ ] **Step 3: Cover grouped summary heuristics with durable tests**

Create `web/src/components/ToolCard/groupedPresentation.test.ts`.

```ts
it('formats file inspection shell commands as friendly grouped labels', () => {
    const tool = makeTool('shell_command', { command: 'Get-ChildItem src -Recurse' })
    expect(formatGroupedRowLabel(tool, t)).toBe('Inspect project files')
})

it('does not leak raw shell command text into grouped labels', () => {
    const tool = makeTool('Bash', { command: 'bun run build --filter web' })
    expect(formatGroupedRowLabel(tool, t)).not.toContain('bun run build')
})

it('formats grouped header title with +n suffix', () => {
    expect(formatGroupedHeaderTitle(groupOfFiveTools, t)).toBe('Inspect project files +4')
})
```

- [ ] **Step 4: Replace grouped-card raw summary rendering with the helper**

Update `web/src/components/ToolCard/ToolGroupCard.tsx`.

```ts
const headerTitle = formatGroupedHeaderTitle(props.block, t)
const subtitle = formatGroupedHeaderSubtitle(props.block, t)

// In RowLabel:
<div className="min-w-0 truncate text-sm font-medium text-[var(--app-fg)]">
    {formatGroupedRowLabel(props.block, t)}
</div>
```

Remove row-level raw subtitle rendering for grouped rows. Keep detail dialogs unchanged.

## Task 2: Add local grouped/user chat surface color hook

**Files:**
- Create: `web/src/hooks/useChatSurfaceColors.ts`
- Create: `web/src/hooks/useChatSurfaceColors.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`
- Modify: `web/src/components/AssistantChat/messages/user-bubble.tsx`
- Modify: `web/src/components/ToolCard/ToolGroupCard.tsx`

- [ ] **Step 1: Create preference types, storage keys, presets, and parsers**

Create `web/src/hooks/useChatSurfaceColors.ts`.

```ts
export type ChatSurfaceColorPreset = 'default' | 'soft-blue' | 'soft-green' | 'soft-yellow'
export type ChatSurfaceColorPreference = 'default' | `preset:${Exclude<ChatSurfaceColorPreset, 'default'>}` | `custom:#${string}`

export const DEFAULT_CHAT_SURFACE_COLOR_PREFERENCE: ChatSurfaceColorPreference = 'default'

export function getChatSurfaceColorPresetOptions() {
    return [
        { value: 'default', labelKey: 'settings.chat.surfaceColor.default' },
        { value: 'soft-blue', labelKey: 'settings.chat.surfaceColor.softBlue' },
        { value: 'soft-green', labelKey: 'settings.chat.surfaceColor.softGreen' },
        { value: 'soft-yellow', labelKey: 'settings.chat.surfaceColor.softYellow' },
    ] as const
}
```

Use separate storage keys:

```ts
const TOOL_GROUP_BG_KEY = 'hapi-tool-group-bg'
const USER_MESSAGE_BG_KEY = 'hapi-user-message-bg'
```

- [ ] **Step 2: Resolve preferences into softened CSS colors and apply root variables**

In the same hook file, add a tiny hex-color utility and CSS variable applier.

```ts
function mixHex(base: string, accent: string, ratio: number): string {
    const [br, bg, bb] = hexToRgb(base)
    const [ar, ag, ab] = hexToRgb(accent)
    return rgbToHex(
        Math.round(br + (ar - br) * ratio),
        Math.round(bg + (ag - bg) * ratio),
        Math.round(bb + (ab - bb) * ratio),
    )
}

function resolveSurfaceColor(pref: ChatSurfaceColorPreference, theme: 'light' | 'dark', surface: 'tool-group' | 'user-message'): string | null {
    if (pref === 'default') return null
    const base = surface === 'tool-group'
        ? (theme === 'dark' ? '#2b2f34' : '#f2f4f6')
        : (theme === 'dark' ? '#2b2f34' : '#f2f4f6')
    const preset = pref.startsWith('preset:') ? pref.slice(7) : null
    const customHex = pref.startsWith('custom:') ? pref.slice(7) : null
    const accent = preset === 'soft-blue' ? '#7db7ff'
        : preset === 'soft-green' ? '#8fd19e'
        : preset === 'soft-yellow' ? '#f0d77a'
        : customHex
    return accent ? mixHex(base, accent, theme === 'dark' ? 0.2 : 0.32) : null
}

function applyChatSurfaceVariables(resolved: {
    toolGroupBg: string | null
    userMessageBg: string | null
}) {
    const rootStyle = document.documentElement.style
    resolved.toolGroupBg ? rootStyle.setProperty('--app-tool-group-bg', resolved.toolGroupBg) : rootStyle.removeProperty('--app-tool-group-bg')
    resolved.userMessageBg ? rootStyle.setProperty('--app-chat-user-surface-bg', resolved.userMessageBg) : rootStyle.removeProperty('--app-chat-user-surface-bg')
}
```

Return a hook API like:

```ts
export function initializeChatSurfaceColors(): void {
    applyStoredChatSurfaceVariables()
    window.addEventListener('storage', handleStorageSync)
}

export function useChatSurfaceColors(): {
    toolGroupBackground: ChatSurfaceColorPreference
    userMessageBackground: ChatSurfaceColorPreference
    setToolGroupBackground: (value: ChatSurfaceColorPreference) => void
    setUserMessageBackground: (value: ChatSurfaceColorPreference) => void
}
```

- [ ] **Step 3: Define default CSS variables and switch grouped/user surfaces to them**

Update `web/src/index.css`.

```css
:root {
    --app-tool-group-bg: var(--app-tool-card-bg);
    --app-chat-user-surface-bg: var(--app-chat-user-bg);
}

[data-theme="dark"] {
    --app-tool-group-bg: var(--app-tool-card-bg);
    --app-chat-user-surface-bg: var(--app-chat-user-bg);
}
```

Update `web/src/components/AssistantChat/messages/user-bubble.tsx`:

```ts
'happy-user-bubble happy-chat-text ml-auto w-fit min-w-0 max-w-[92%] rounded-2xl bg-[var(--app-chat-user-surface-bg)] px-4 py-2.5 text-[var(--app-chat-user-fg)] shadow-none'
```

Update `web/src/components/ToolCard/ToolGroupCard.tsx`:

```ts
<Card className="overflow-hidden rounded-[20px] bg-[var(--app-tool-group-bg)] shadow-none">
```

Update `web/src/App.tsx`:

```ts
import { initializeChatSurfaceColors } from '@/hooks/useChatSurfaceColors'

useEffect(() => {
    const tg = getTelegramWebApp()
    tg?.ready()
    tg?.expand()
    initializeTheme()
    initializeChatSurfaceColors()
}, [])
```

- [ ] **Step 4: Add durable hook tests for fallback and CSS variable application**

Create `web/src/hooks/useChatSurfaceColors.test.ts`.

```ts
it('falls back to default when storage is missing or invalid', () => {
    expect(getInitialToolGroupBackground()).toBe('default')
    expect(getInitialUserMessageBackground()).toBe('default')
})

it('stores preset and custom preferences using stable string values', () => {
    setToolGroupBackground('preset:soft-blue')
    setUserMessageBackground('custom:#88cc44')
})

it('applies root CSS variables only for non-default preferences', () => {
    expect(document.documentElement.style.getPropertyValue('--app-tool-group-bg')).toBe('')
    // after setting preset/custom => variable is written
}
```

## Task 3: Add Settings > Chat controls for grouped/user surface colors

**Files:**
- Modify: `web/src/routes/settings/index.tsx`
- Modify: `web/src/routes/settings/index.test.tsx`
- Modify: `web/src/lib/locales/en.ts`
- Modify: `web/src/lib/locales/zh-CN.ts`

- [ ] **Step 1: Add i18n copy for grouped summaries and color settings**

Update locale files with grouped-friendly labels and settings copy.

```ts
// tool group friendly summaries
'toolGroup.friendly.inspectFiles': 'Inspect project files',
'toolGroup.friendly.searchContent': 'Search project content',
'toolGroup.friendly.runCommands': 'Run project commands',
'toolGroup.friendly.editFiles': 'Edit project files',
'toolGroup.friendly.genericCommand': 'Run command',

// settings
'settings.chat.groupedToolBackground': 'Grouped Tool Use Background',
'settings.chat.userMessageBackground': 'User Message Background',
'settings.chat.surfaceColor.default': 'Default color',
'settings.chat.surfaceColor.softBlue': 'Soft blue',
'settings.chat.surfaceColor.softGreen': 'Soft green',
'settings.chat.surfaceColor.softYellow': 'Soft yellow',
'settings.chat.surfaceColor.custom': 'Custom color',
```

Mirror the same keys in `zh-CN.ts`.

- [ ] **Step 2: Wire the settings page to the new hook**

Update `web/src/routes/settings/index.tsx` to consume `useChatSurfaceColors()` and render two new controls under the existing Chat section.

```ts
const {
    toolGroupBackground,
    userMessageBackground,
    setToolGroupBackground,
    setUserMessageBackground,
} = useChatSurfaceColors()
```

Render each surface as:

```tsx
<div className="px-3 py-3">
    <div className="mb-2 text-[var(--app-fg)]">{t('settings.chat.groupedToolBackground')}</div>
    <div className="flex flex-wrap gap-2">
        {presetOptions.map((opt) => (
            <button key={opt.value} onClick={() => setToolGroupBackground(toPreference(opt.value))}>
                {t(opt.labelKey)}
            </button>
        ))}
    </div>
    <input
        type="color"
        value={toolGroupPickerValue}
        onChange={(event) => setToolGroupBackground(`custom:${event.target.value}`)}
    />
</div>
```

Do the same for user-message background. Keep the current settings page visual language; no new modal or restore button.

- [ ] **Step 3: Extend settings-page regression coverage**

Update `web/src/routes/settings/index.test.tsx`.

```ts
vi.mock('@/hooks/useChatSurfaceColors', () => ({
    useChatSurfaceColors: () => ({
        toolGroupBackground: 'default',
        userMessageBackground: 'preset:soft-blue',
        setToolGroupBackground: vi.fn(),
        setUserMessageBackground: vi.fn(),
    }),
    getChatSurfaceColorPresetOptions: () => [
        { value: 'default', labelKey: 'settings.chat.surfaceColor.default' },
        { value: 'soft-blue', labelKey: 'settings.chat.surfaceColor.softBlue' },
        { value: 'soft-green', labelKey: 'settings.chat.surfaceColor.softGreen' },
        { value: 'soft-yellow', labelKey: 'settings.chat.surfaceColor.softYellow' },
    ],
}))

it('renders grouped tool and user message background settings', () => {
    expect(screen.getAllByText('Grouped Tool Use Background').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('User Message Background').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Default color').length).toBeGreaterThanOrEqual(1)
})
```

## Task 4: Refresh grouped-card regressions and verify end-to-end behavior

**Files:**
- Modify: `web/src/components/ToolCard/ToolGroupCard.test.tsx`
- Modify: `web/src/components/ToolCard/groupedPresentation.test.ts`
- Modify: `web/src/hooks/useChatSurfaceColors.test.ts`
- Modify: `web/src/routes/settings/index.test.tsx`

- [ ] **Step 1: Update grouped-card tests to assert friendly labels instead of raw commands/paths**

Revise `web/src/components/ToolCard/ToolGroupCard.test.tsx` expectations.

```ts
expect(screen.getByRole('button', { name: /Inspect project files/i })).toBeInTheDocument()
expect(screen.getByText('Read 1 · Run 1')).toBeInTheDocument()
expect(screen.queryByText('bun test')).not.toBeInTheDocument()
```

Also add one row assertion after expand:

```ts
expect(screen.getByText('Run project commands')).toBeInTheDocument()
expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument()
```

Keep dialog assertions that confirm raw detail is still accessible after clicking a row.

- [ ] **Step 2: Run focused verification commands**

Run from repo root:

```bash
cd web
bun run test -- src/components/ToolCard/groupedPresentation.test.ts src/hooks/useChatSurfaceColors.test.ts src/components/ToolCard/ToolGroupCard.test.tsx src/routes/settings/index.test.tsx
bun run typecheck
```

Expected:

- test command exits `0`
- typecheck exits `0`

- [ ] **Step 3: Manual smoke in the browser**

Verify:

```text
1. A grouped shell/file activity card now reads like “检查项目文件 +4” instead of a raw path or full command.
2. Expanded grouped rows stay one-line and semantic.
3. Clicking a row still opens raw tool details.
4. Settings > Chat shows two new color controls.
5. Default color leaves current visuals unchanged.
6. Soft blue / soft green / soft yellow and custom color update immediately and persist after reload.
```

## Notes

- Do not add temporary bug-repro tests that lack long-term regression value.
- Do not change standalone `getToolPresentation` behavior unless a small shared utility extraction is truly required.
- Do not introduce server-backed settings or theme-schema changes outside `web`.
