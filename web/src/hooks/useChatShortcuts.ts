import { useSyncExternalStore } from 'react'
import { CHAT_SHORTCUTS_STORAGE_KEY, DEFAULT_CHAT_SHORTCUTS, parseChatShortcuts, type ChatShortcuts } from '@/lib/chatShortcuts'

const CHANGE_EVENT = 'hapi-chat-shortcuts-change'
let snapshot = { raw: null as string | null, shortcuts: DEFAULT_CHAT_SHORTCUTS as ChatShortcuts }
let unsaved: ChatShortcuts | null = null

function getSnapshot(): ChatShortcuts {
    if (unsaved) return unsaved
    try {
        const raw = localStorage.getItem(CHAT_SHORTCUTS_STORAGE_KEY)
        if (raw !== snapshot.raw) snapshot = { raw, shortcuts: parseChatShortcuts(raw) }
    } catch {
        return DEFAULT_CHAT_SHORTCUTS
    }
    return snapshot.shortcuts
}

function subscribe(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === CHAT_SHORTCUTS_STORAGE_KEY || event.key === null) onChange()
    }
    window.addEventListener(CHANGE_EVENT, onChange)
    window.addEventListener('storage', onStorage)
    return () => {
        window.removeEventListener(CHANGE_EVENT, onChange)
        window.removeEventListener('storage', onStorage)
    }
}

export function setChatShortcuts(shortcuts: ChatShortcuts): void {
    try {
        if (shortcuts === DEFAULT_CHAT_SHORTCUTS) localStorage.removeItem(CHAT_SHORTCUTS_STORAGE_KEY)
        else localStorage.setItem(CHAT_SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts))
        unsaved = null
    } catch {
        unsaved = shortcuts
    }
    window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useChatShortcuts(): ChatShortcuts {
    return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_CHAT_SHORTCUTS)
}
