import { describe, expect, it } from 'vitest'
import {
    isDictateHotkeyBlockedTarget,
    isDictateToggleHotkey,
    shouldInvokeComposerDictateShortcut,
} from './composerDictateShortcut'

describe('isDictateToggleHotkey', () => {
    function k(over: Partial<{
        metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string
    }>): { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string } {
        return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...over }
    }

    it('matches Ctrl+Shift+D and Cmd+Shift+D', () => {
        expect(isDictateToggleHotkey(k({ ctrlKey: true, shiftKey: true, key: 'D' }))).toBe(true)
        expect(isDictateToggleHotkey(k({ metaKey: true, shiftKey: true, key: 'd' }))).toBe(true)
    })

    it('rejects bare D and Ctrl+D without shift', () => {
        expect(isDictateToggleHotkey(k({ key: 'd' }))).toBe(false)
        expect(isDictateToggleHotkey(k({ ctrlKey: true, key: 'd' }))).toBe(false)
    })

    it('rejects unrelated keys with the modifier chord', () => {
        expect(isDictateToggleHotkey(k({ ctrlKey: true, shiftKey: true, key: 'S' }))).toBe(false)
    })
})

describe('isDictateHotkeyBlockedTarget', () => {
    it('blocks single-line inputs and dialogs like scratchlist', () => {
        const input = document.createElement('input')
        expect(isDictateHotkeyBlockedTarget(input)).toBe(true)
    })

    it('allows the rich composer contentEditable host', () => {
        const shell = document.createElement('div')
        shell.setAttribute('data-testid', 'rich-composer-input')
        const editor = document.createElement('div')
        editor.setAttribute('contenteditable', 'plaintext-only')
        shell.appendChild(editor)
        document.body.appendChild(shell)
        expect(isDictateHotkeyBlockedTarget(editor)).toBe(false)
        document.body.removeChild(shell)
    })

    it('allows the fallback composer textarea', () => {
        const textarea = document.createElement('textarea')
        expect(isDictateHotkeyBlockedTarget(textarea)).toBe(false)
    })
})

describe('shouldInvokeComposerDictateShortcut', () => {
    const base = {
        controlsDisabled: false,
        voiceEnabled: true,
        dictationActive: false,
        voiceStatus: 'disconnected' as const,
        canSend: false,
        routesToScratchlist: false,
    }

    it('stops an active voice session', () => {
        expect(shouldInvokeComposerDictateShortcut({
            ...base,
            voiceStatus: 'connected',
        })).toBe(true)
    })

    it('starts assistant voice on an empty composer', () => {
        expect(shouldInvokeComposerDictateShortcut(base)).toBe(true)
    })

    it('does not start assistant voice when UnifiedButton is in send mode', () => {
        expect(shouldInvokeComposerDictateShortcut({ ...base, canSend: true })).toBe(false)
    })

    it('starts dictation on an empty composer when scratchlist routing is off', () => {
        expect(shouldInvokeComposerDictateShortcut({
            ...base,
            dictationActive: true,
        })).toBe(true)
    })

    it('allows dictation when a draft makes canSend true', () => {
        expect(shouldInvokeComposerDictateShortcut({
            ...base,
            dictationActive: true,
            canSend: true,
        })).toBe(true)
    })

    it('suppresses scratchlist-routed empty composer starts', () => {
        expect(shouldInvokeComposerDictateShortcut({
            ...base,
            routesToScratchlist: true,
        })).toBe(false)
    })
})
