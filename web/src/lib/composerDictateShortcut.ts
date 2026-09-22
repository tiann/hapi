import type { ConversationStatus } from '@/realtime/types'

/**
 * True if the keystroke matches the composer dictation / voice toggle shortcut
 * (Ctrl/Cmd + Shift + D, no Alt). Pure for unit tests.
 *
 * Modifier shape matches scratchlist (Ctrl/Cmd+Shift+S) and model cycle
 * (Ctrl/Cmd+M). Shift+D avoids browser bookmark / devtools clashes on bare D.
 */
export function isDictateToggleHotkey(e: {
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    key: string
}): boolean {
    if (!(e.metaKey || e.ctrlKey)) return false
    if (!e.shiftKey) return false
    if (e.altKey) return false
    return e.key === 'D' || e.key === 'd'
}

/**
 * True when the global dictate hotkey should be SKIPPED for the event target.
 *
 * Same dialog / single-line input guards as scratchlist
 * (`isScratchlistHotkeyBlockedTarget`), but the rich composer (contentEditable)
 * is allowed so the shortcut works while typing in the main input.
 */
export function isDictateHotkeyBlockedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.closest('[data-testid="rich-composer-input"]') !== null) return false
    if (target.closest('[role="dialog"]') !== null) return true
    if (target instanceof HTMLInputElement) return true
    if (target instanceof HTMLSelectElement) return true
    if (target.isContentEditable === true) return true
    return target.getAttribute('contenteditable') === 'true'
}

/**
 * Mirrors DictationButton + UnifiedButton voice-start/stop rules so the hotkey
 * does not send chat text or start voice when the mic UI would not.
 */
export function shouldInvokeComposerDictateShortcut(args: {
    controlsDisabled: boolean
    voiceEnabled: boolean
    dictationActive: boolean
    voiceStatus: ConversationStatus
    canSend: boolean
    routesToScratchlist: boolean
}): boolean {
    if (args.controlsDisabled || !args.voiceEnabled) return false
    const isVoiceActive = args.voiceStatus === 'connecting' || args.voiceStatus === 'connected'
    if (isVoiceActive) return true
    if (args.dictationActive) {
        if (args.canSend) return true
        return !args.routesToScratchlist
    }
    // UnifiedButton treats canSend (text or attachments) as Send mode for assistant voice.
    if (args.canSend) return false
    return !args.routesToScratchlist
}
