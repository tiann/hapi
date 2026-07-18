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
    test('grok supports dynamic model and effort changes', () => {
        expect(isKnownFlavor('grok')).toBe(true)
        expect(getFlavorLabel('grok')).toBe('Grok')
        expect(supportsModelChange('grok')).toBe(true)
        expect(supportsEffort('grok')).toBe(true)
    })

    test('claude supports model-change', () => {
        expect(hasCapability('claude', Capabilities.ModelChange)).toBe(true)
    })

    test('claude supports effort', () => {
        expect(hasCapability('claude', Capabilities.Effort)).toBe(true)
    })

    test('claude-deepseek supports model-change and effort', () => {
        expect(hasCapability('claude-deepseek', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('claude-deepseek', Capabilities.Effort)).toBe(true)
    })

    test('claude-ark supports model-change and effort', () => {
        expect(hasCapability('claude-ark', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('claude-ark', Capabilities.Effort)).toBe(true)
    })


    test('cc-api supports model-change and effort', () => {
        expect(hasCapability('cc-api', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('cc-api', Capabilities.Effort)).toBe(true)
    })

    test('agy supports model-change but not effort', () => {
        expect(hasCapability('agy', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('agy', Capabilities.Effort)).toBe(false)
    })

    test('codex supports model-change but not effort', () => {
        expect(hasCapability('codex', Capabilities.ModelChange)).toBe(true)
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

    test('hermes-moa supports model-change but not Claude effort', () => {
        expect(hasCapability('hermes-moa', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('hermes-moa', Capabilities.Effort)).toBe(false)
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
        expect(getFlavorLabel('claude-deepseek')).toBe('CC-deepseek')
        expect(getFlavorLabel('claude-ark')).toBe('CC-ark')
        expect(getFlavorLabel('cc-api')).toBe('CC-api')
        expect(getFlavorLabel('agy')).toBe('Antigravity agy')
        expect(getFlavorLabel('codex')).toBe('Codex')
        expect(getFlavorLabel('cursor')).toBe('Cursor')
        expect(getFlavorLabel('opencode')).toBe('OpenCode')
        expect(getFlavorLabel('hermes-moa')).toBe('Hermes MoA')
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
        expect(isKnownFlavor('claude-deepseek')).toBe(true)
        expect(isKnownFlavor('claude-ark')).toBe(true)
        expect(isKnownFlavor('cc-api')).toBe(true)
        expect(isKnownFlavor('agy')).toBe(true)
        expect(isKnownFlavor('codex')).toBe(true)
        expect(isKnownFlavor('cursor')).toBe(true)
        expect(isKnownFlavor('opencode')).toBe(true)
        expect(isKnownFlavor('hermes-moa')).toBe(true)
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
        expect(supportsModelChange('claude-deepseek')).toBe(true)
        expect(supportsModelChange('claude-ark')).toBe(true)
        expect(supportsModelChange('cc-api')).toBe(true)
        expect(supportsModelChange('agy')).toBe(true)
        expect(supportsModelChange('codex')).toBe(true)
        expect(supportsModelChange('hermes-moa')).toBe(true)
        expect(supportsModelChange('cursor')).toBe(false)
        expect(supportsModelChange(null)).toBe(false)
    })

    test('supportsEffort matches hasCapability', () => {
        expect(supportsEffort('claude')).toBe(true)
        expect(supportsEffort('claude-deepseek')).toBe(true)
        expect(supportsEffort('claude-ark')).toBe(true)
        expect(supportsEffort('cc-api')).toBe(true)
        expect(supportsEffort('codex')).toBe(false)
        expect(supportsEffort('agy')).toBe(false)
        expect(supportsEffort('hermes-moa')).toBe(false)
        expect(supportsEffort(null)).toBe(false)
    })
})
