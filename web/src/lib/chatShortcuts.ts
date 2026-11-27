export const CHAT_SHORTCUTS_STORAGE_KEY = 'hapi-chat-shortcuts'

export const DEFAULT_CHAT_SHORTCUTS = {
    send: 'alt+s',
    permission: 'shift+Tab',
    planMode: null,
    model: 'mod+m',
    effort: null,
    effortDecrease: null,
    effortIncrease: null,
    dictation: 'mod+shift+d',
    scratchlist: 'mod+shift+s',
} satisfies Record<string, string | null>

export type ChatShortcutAction = keyof typeof DEFAULT_CHAT_SHORTCUTS
export type ChatShortcuts = Record<ChatShortcutAction, string | null>
export const CHAT_SHORTCUT_ACTIONS = Object.keys(DEFAULT_CHAT_SHORTCUTS) as ChatShortcutAction[]

type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

export function getChatShortcut(event: ShortcutKeyEvent): string {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    return [
        event.ctrlKey || event.metaKey ? 'mod' : '',
        event.altKey ? 'alt' : '',
        event.shiftKey ? 'shift' : '',
        key,
    ].filter(Boolean).join('+')
}

export function isComposerOnlyChatShortcut(shortcut: string): boolean {
    return /^shift\+(?:Tab|Arrow(?:Up|Down|Left|Right))$/.test(shortcut)
}

export function isAssignableChatShortcut(shortcut: string): boolean {
    if (isComposerOnlyChatShortcut(shortcut)) return true
    if (/^mod\+(?:[acvxyz0-9=\-]|shift\+z)$/.test(shortcut)) return false
    return /^(?:mod\+(?:alt\+)?|alt\+)(?:shift\+)?(?:[a-z0-9,.;'\/\[\]\\\x60\-=]|Arrow(?:Up|Down|Left|Right))$/.test(shortcut)
}

export function matchesChatShortcut(event: ShortcutKeyEvent, shortcut: string | null): boolean {
    return shortcut !== null && getChatShortcut(event) === shortcut
}

export function isChatShortcutEvent(event: KeyboardEvent): boolean {
    return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
        && !event.repeat && !event.getModifierState('AltGraph')
}

export function isGlobalChatShortcutInScope(event: KeyboardEvent): boolean {
    // Preserve native focus navigation and selection outside the composer.
    return !isComposerOnlyChatShortcut(getChatShortcut(event))
        || (event.target instanceof HTMLElement && event.target.closest('[data-composer-shortcut-input]') !== null)
}

export function formatChatShortcut(shortcut: string): string {
    const names: Record<string, string> = {
        mod: 'Ctrl/Cmd', alt: 'Alt', shift: 'Shift',
        ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    }
    return shortcut.split('+').map((key) => names[key] ?? (key.length === 1 ? key.toUpperCase() : key)).join(' + ')
}

export function parseChatShortcuts(raw: string | null): ChatShortcuts {
    if (!raw) return DEFAULT_CHAT_SHORTCUTS
    try {
        const stored: unknown = JSON.parse(raw)
        if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return DEFAULT_CHAT_SHORTCUTS
        const next: ChatShortcuts = { ...DEFAULT_CHAT_SHORTCUTS }
        for (const action of CHAT_SHORTCUT_ACTIONS) {
            const binding = (stored as Record<string, unknown>)[action]
            if (binding === null || (typeof binding === 'string' && isAssignableChatShortcut(binding))) next[action] = binding
        }
        const bindings = Object.values(next).filter((binding) => binding !== null)
        return new Set(bindings).size === bindings.length ? next : DEFAULT_CHAT_SHORTCUTS
    } catch {
        return DEFAULT_CHAT_SHORTCUTS
    }
}
