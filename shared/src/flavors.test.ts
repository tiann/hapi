import { describe, expect, test } from 'bun:test'
import {
    Capabilities,
    getFlavorLabel,
    hasCapability,
    isKnownFlavor,
    supportsEffort,
    supportsModelChange,
} from './flavors'

describe('hasCapability', () => {
    test('claude supports model-change', () => {
        expect(hasCapability('claude', Capabilities.ModelChange)).toBe(true)
    })

    test('claude supports effort', () => {
        expect(hasCapability('claude', Capabilities.Effort)).toBe(true)
    })

    test('gemini supports model-change but not effort', () => {
        expect(hasCapability('gemini', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('gemini', Capabilities.Effort)).toBe(false)
    })

    test('codex has no capabilities', () => {
        expect(hasCapability('codex', Capabilities.ModelChange)).toBe(false)
        expect(hasCapability('codex', Capabilities.Effort)).toBe(false)
    })

    test('cursor has no capabilities', () => {
        expect(hasCapability('cursor', Capabilities.ModelChange)).toBe(false)
        expect(hasCapability('cursor', Capabilities.Effort)).toBe(false)
    })

    test('opencode has no capabilities', () => {
        expect(hasCapability('opencode', Capabilities.ModelChange)).toBe(false)
        expect(hasCapability('opencode', Capabilities.Effort)).toBe(false)
    })

    test('unknown flavor returns false', () => {
        expect(hasCapability('unknown-flavor', Capabilities.ModelChange)).toBe(false)
    })

    test('null/undefined flavor returns false', () => {
        expect(hasCapability(null, Capabilities.ModelChange)).toBe(false)
        expect(hasCapability(undefined, Capabilities.ModelChange)).toBe(false)
    })
})

describe('getFlavorLabel', () => {
    test('known flavors return display names', () => {
        expect(getFlavorLabel('claude')).toBe('Claude')
        expect(getFlavorLabel('gemini')).toBe('Gemini')
        expect(getFlavorLabel('codex')).toBe('Codex')
        expect(getFlavorLabel('cursor')).toBe('Cursor')
        expect(getFlavorLabel('opencode')).toBe('OpenCode')
    })

    test('unknown flavor returns Unknown', () => {
        expect(getFlavorLabel('some-new-cli')).toBe('Unknown')
    })

    test('null/undefined returns Unknown', () => {
        expect(getFlavorLabel(null)).toBe('Unknown')
        expect(getFlavorLabel(undefined)).toBe('Unknown')
    })
})

describe('isKnownFlavor', () => {
    test('returns true for registered flavors', () => {
        expect(isKnownFlavor('claude')).toBe(true)
        expect(isKnownFlavor('gemini')).toBe(true)
        expect(isKnownFlavor('codex')).toBe(true)
        expect(isKnownFlavor('cursor')).toBe(true)
        expect(isKnownFlavor('opencode')).toBe(true)
    })

    test('returns false for unknown/null/undefined', () => {
        expect(isKnownFlavor('foo')).toBe(false)
        expect(isKnownFlavor(null)).toBe(false)
        expect(isKnownFlavor(undefined)).toBe(false)
    })
})

describe('convenience functions', () => {
    test('supportsModelChange matches hasCapability', () => {
        expect(supportsModelChange('claude')).toBe(true)
        expect(supportsModelChange('gemini')).toBe(true)
        expect(supportsModelChange('cursor')).toBe(false)
        expect(supportsModelChange(null)).toBe(false)
    })

    test('supportsEffort matches hasCapability', () => {
        expect(supportsEffort('claude')).toBe(true)
        expect(supportsEffort('codex')).toBe(false)
        expect(supportsEffort('gemini')).toBe(false)
        expect(supportsEffort(null)).toBe(false)
    })
})
