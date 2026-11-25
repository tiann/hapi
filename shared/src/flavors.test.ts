import { describe, expect, test } from 'bun:test'
import {
    Capabilities,
    Flavors,
    getFlavorLabel,
    getPermissionModesForFlavor,
    getPermissionReplyStyle,
    getYoloToggleMigrationMode,
    hasCapability,
    isKnownFlavor,
    isPermissionModeAllowedForFlavor,
    isSteeringSupportedForFlavor,
    isSteeringSupportedForSession,
    resolveHapiYoloPermissionMode,
    supportsEffort,
    supportsModelChange,
    usesNativePermissionSelect,
    usesSharedPermissionModeState,
} from './flavors'
import {
    AGENT_FLAVORS,
    getPermissionModeLabel,
    getPermissionModeOptionsForFlavor,
    getPermissionModeTone,
    PERMISSION_MODES
} from './modes'

// Values that are not a registered flavor, including names an object lookup would inherit.
const UNREGISTERED = [null, undefined, '', 'unknown-flavor', 'Claude', 'Pi', '__proto__', 'constructor'] as const

describe('flavor registry', () => {
    // The agent selectors list flavors in this order.
    test('AGENT_FLAVORS keeps its order', () => {
        expect([...AGENT_FLAVORS]).toEqual([
            'agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'gemini', 'grok', 'kimi', 'opencode', 'pi'
        ])
    })

    test.each(AGENT_FLAVORS)('%s is a known flavor', (flavor) => {
        expect(isKnownFlavor(flavor)).toBe(true)
    })

    test.each(UNREGISTERED)('%p is not a known flavor', (value) => {
        expect(isKnownFlavor(value)).toBe(false)
    })
})

describe('capability queries', () => {
    test.each(AGENT_FLAVORS)('%s: the convenience queries agree with hasCapability', (flavor) => {
        expect(supportsModelChange(flavor)).toBe(hasCapability(flavor, Capabilities.ModelChange))
        expect(supportsEffort(flavor)).toBe(hasCapability(flavor, Capabilities.Effort))
    })
})

describe('auto-approve mode', () => {
    test.each([
        ['agy', 'always-proceed'],
        ['claude', 'bypassPermissions'],
        ['codex', 'yolo'],
    ] as const)('%s uses %s, the only auto-approve mode in its list', (flavor, mode) => {
        expect(resolveHapiYoloPermissionMode(flavor)).toBe(mode)
    })

    test('a flavor with modes but no auto-approve mode has none, and a flavor without modes has none', () => {
        expect(getPermissionModesForFlavor('claude')).not.toContain('yolo')
        expect(resolveHapiYoloPermissionMode('dsh')).toBeNull()
        expect(resolveHapiYoloPermissionMode('pi')).toBeNull()
    })

    test.each(AGENT_FLAVORS)('%s: the auto-approve mode is one of its own modes', (flavor) => {
        const mode = resolveHapiYoloPermissionMode(flavor)
        if (mode !== null) expect(getPermissionModesForFlavor(flavor)).toContain(mode)
    })
})

describe('new-session form mode source', () => {
    test('a flavor without modes is managed: no native select and no shared state', () => {
        for (const flavor of ['dsh', 'pi'] as const) {
            expect(usesNativePermissionSelect(flavor)).toBe(false)
            expect(usesSharedPermissionModeState(flavor)).toBe(false)
        }
    })

    test('a flavor with its own form state has a native select outside the shared state', () => {
        expect(usesNativePermissionSelect('grok')).toBe(true)
        expect(usesSharedPermissionModeState('grok')).toBe(false)
    })

    test('other flavors with modes use the native select and the shared state', () => {
        expect(usesNativePermissionSelect('codex')).toBe(true)
        expect(usesSharedPermissionModeState('codex')).toBe(true)
    })
})

describe('YOLO toggle migration', () => {
    test('a flavor that migrates the saved toggle maps it to its auto-approve mode', () => {
        for (const flavor of ['agy', 'claude', 'codex', 'cursor'] as const) {
            expect(getYoloToggleMigrationMode(flavor)).toBe(resolveHapiYoloPermissionMode(flavor))
        }
    })

    test('a flavor that does not migrate has no migration mode even with an auto-approve mode', () => {
        expect(resolveHapiYoloPermissionMode('copilot')).not.toBeNull()
        expect(getYoloToggleMigrationMode('copilot')).toBeNull()
    })
})

describe('unregistered flavors', () => {
    test.each(UNREGISTERED)('%p falls back to the neutral record', (flavor) => {
        expect(hasCapability(flavor, Capabilities.ModelChange)).toBe(false)
        expect(supportsModelChange(flavor)).toBe(false)
        expect(supportsEffort(flavor)).toBe(false)
        expect(getFlavorLabel(flavor)).toBe('Unknown')
        expect(getPermissionReplyStyle(flavor)).toBe('generic')
        expect(usesNativePermissionSelect(flavor)).toBe(false)
        expect(usesSharedPermissionModeState(flavor)).toBe(false)
        expect(getYoloToggleMigrationMode(flavor)).toBeNull()
        expect(resolveHapiYoloPermissionMode(flavor)).toBeNull()
        expect(isSteeringSupportedForFlavor(flavor)).toBe(false)
        expect(isSteeringSupportedForSession({ flavor })).toBe(false)
    })

    test.each(UNREGISTERED)('%p keeps the Claude permission mode list', (flavor) => {
        expect(getPermissionModesForFlavor(flavor)).toEqual(getPermissionModesForFlavor('claude'))
        expect(getPermissionModeOptionsForFlavor(flavor)).toEqual(getPermissionModeOptionsForFlavor('claude'))
        for (const mode of PERMISSION_MODES) {
            expect(isPermissionModeAllowedForFlavor(mode, flavor)).toBe(isPermissionModeAllowedForFlavor(mode, 'claude'))
        }
    })
})

describe('getPermissionReplyStyle with a tool name', () => {
    test.each(['CodexSearch', 'GeminiAsk', 'OpenCodeRead', 'CopilotChat', 'CursorList'])(
        'a %s tool is answered with decisions in any flavor',
        (toolName) => {
            for (const flavor of [...AGENT_FLAVORS, null, 'unknown-flavor']) {
                expect(getPermissionReplyStyle(flavor, toolName)).toBe('decision')
            }
        }
    )

    test('other tool names keep the flavor style', () => {
        expect(getPermissionReplyStyle('claude', 'Bash')).toBe(getPermissionReplyStyle('claude'))
        expect(getPermissionReplyStyle('agy', 'Edit')).toBe(getPermissionReplyStyle('agy'))
    })

    test('the prefix match is case-sensitive and anchored at the start', () => {
        expect(getPermissionReplyStyle('claude', 'codexSearch')).toBe(getPermissionReplyStyle('claude'))
        expect(getPermissionReplyStyle('claude', 'MyCodexTool')).toBe(getPermissionReplyStyle('claude'))
    })
})

describe('permission mode membership', () => {
    test.each([...AGENT_FLAVORS, ...UNREGISTERED])('%p: every query agrees on which modes are allowed', (flavor) => {
        const modes: readonly string[] = getPermissionModesForFlavor(flavor)
        for (const mode of PERMISSION_MODES) {
            expect(isPermissionModeAllowedForFlavor(mode, flavor)).toBe(modes.includes(mode))
            if (isKnownFlavor(flavor)) {
                expect(Flavors[flavor].allowsPermissionMode(mode)).toBe(modes.includes(mode))
            }
        }
        if (isKnownFlavor(flavor)) {
            expect(Flavors[flavor].allowsPermissionMode('not-a-mode')).toBe(false)
        }
    })

    test('a flavor without modes allows none', () => {
        for (const mode of PERMISSION_MODES) {
            expect(isPermissionModeAllowedForFlavor(mode, 'pi')).toBe(false)
        }
    })
})

describe('getPermissionModeOptionsForFlavor', () => {
    test('maps each mode to its label and tone', () => {
        expect(getPermissionModeOptionsForFlavor('codex')).toEqual(
            getPermissionModesForFlavor('codex').map((mode) => ({
                mode,
                label: getPermissionModeLabel(mode),
                tone: getPermissionModeTone(mode)
            }))
        )
    })

    test('is empty for a flavor without modes', () => {
        expect(getPermissionModeOptionsForFlavor('pi')).toEqual([])
    })
})
