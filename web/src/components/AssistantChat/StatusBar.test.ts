import { describe, expect, it } from 'vitest'
import { shouldShowCodexFastBadge, shouldShowComposerStatusBar } from './StatusBar'

describe('shouldShowComposerStatusBar', () => {
    it('hides the composer status bar for Cursor sessions', () => {
        expect(shouldShowComposerStatusBar('cursor')).toBe(false)
    })

    it('shows the composer status bar for other agents', () => {
        expect(shouldShowComposerStatusBar('claude')).toBe(true)
        expect(shouldShowComposerStatusBar('codex')).toBe(true)
        expect(shouldShowComposerStatusBar(null)).toBe(true)
    })
})

describe('shouldShowCodexFastBadge', () => {
    it('uses only the effective service tier', () => {
        expect(shouldShowCodexFastBadge('codex', undefined)).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'standard')).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'fast')).toBe(true)
        expect(shouldShowCodexFastBadge('codex', 'priority')).toBe(true)
        expect(shouldShowCodexFastBadge('claude', 'fast')).toBe(false)
    })
})
