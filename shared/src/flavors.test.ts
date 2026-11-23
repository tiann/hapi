import { describe, expect, test } from 'bun:test'
import {
    Capabilities,
    getFlavorLabel,
    hasCapability,
    isKnownFlavor,
    supportsEffort,
    supportsModelChange,
    getPermissionReplyStyle,
    getYoloToggleMigrationMode,
    resolveHapiYoloPermissionMode,
    usesNativePermissionSelect,
    usesSharedPermissionModeState,
} from './flavors'
import { AGENT_FLAVORS, type AgentFlavor, type PermissionMode } from './modes'

describe('hasCapability', () => {
    test('agy supports model-change and effort', () => {
        expect(hasCapability('agy', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('agy', Capabilities.Effort)).toBe(true)
    })

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

    test('dsh supports model-change but not effort (ACP config options)', () => {
        expect(hasCapability('dsh', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('dsh', Capabilities.Effort)).toBe(false)
    })

    test('codex supports model-change but not effort', () => {
        expect(hasCapability('codex', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('codex', Capabilities.Effort)).toBe(false)
    })

    test('cursor supports model-change but not effort', () => {
        expect(hasCapability('cursor', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('cursor', Capabilities.Effort)).toBe(false)
    })

    test('opencode supports model-change but not effort', () => {
        expect(hasCapability('opencode', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('opencode', Capabilities.Effort)).toBe(false)
    })

    test('pi supports model-change and effort', () => {
        expect(hasCapability('pi', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('pi', Capabilities.Effort)).toBe(true)
    })

    test('kimi supports model-change and effort', () => {
        expect(hasCapability('kimi', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('kimi', Capabilities.Effort)).toBe(true)
    })

    test('copilot supports model-change and effort', () => {
        expect(hasCapability('copilot', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('copilot', Capabilities.Effort)).toBe(true)
    })

    test('grok supports runtime model and effort switching through ACP', () => {
        expect(hasCapability('grok', Capabilities.ModelChange)).toBe(true)
        expect(hasCapability('grok', Capabilities.Effort)).toBe(true)
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
        expect(getFlavorLabel('agy')).toBe('Antigravity')
        expect(getFlavorLabel('claude')).toBe('Claude')
        expect(getFlavorLabel('gemini')).toBe('Gemini')
        expect(getFlavorLabel('codex')).toBe('Codex')
        expect(getFlavorLabel('dsh')).toBe('DeepSeek Harness')
        expect(getFlavorLabel('cursor')).toBe('Cursor')
        expect(getFlavorLabel('opencode')).toBe('OpenCode')
        expect(getFlavorLabel('pi')).toBe('Pi')
        expect(getFlavorLabel('kimi')).toBe('Kimi')
        expect(getFlavorLabel('copilot')).toBe('Copilot')
        expect(getFlavorLabel('grok')).toBe('Grok Build')
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
        expect(isKnownFlavor('agy')).toBe(true)
        expect(isKnownFlavor('claude')).toBe(true)
        expect(isKnownFlavor('gemini')).toBe(true)
        expect(isKnownFlavor('codex')).toBe(true)
        expect(isKnownFlavor('dsh')).toBe(true)
        expect(isKnownFlavor('cursor')).toBe(true)
        expect(isKnownFlavor('opencode')).toBe(true)
        expect(isKnownFlavor('pi')).toBe(true)
        expect(isKnownFlavor('kimi')).toBe(true)
        expect(isKnownFlavor('copilot')).toBe(true)
        expect(isKnownFlavor('grok')).toBe(true)
    })

    test('returns false for unknown/null/undefined', () => {
        expect(isKnownFlavor('foo')).toBe(false)
        expect(isKnownFlavor(null)).toBe(false)
        expect(isKnownFlavor(undefined)).toBe(false)
    })
})

describe('convenience functions', () => {
    test('supportsModelChange matches hasCapability', () => {
        expect(supportsModelChange('agy')).toBe(true)
        expect(supportsModelChange('claude')).toBe(true)
        expect(supportsModelChange('gemini')).toBe(true)
        expect(supportsModelChange('codex')).toBe(true)
        expect(supportsModelChange('opencode')).toBe(true)
        expect(supportsModelChange('cursor')).toBe(true)
        expect(supportsModelChange('pi')).toBe(true)
        expect(supportsModelChange('kimi')).toBe(true)
        expect(supportsModelChange(null)).toBe(false)
    })

    test('supportsEffort matches hasCapability', () => {
        expect(supportsEffort('agy')).toBe(true)
        expect(supportsEffort('claude')).toBe(true)
        expect(supportsEffort('codex')).toBe(false)
        expect(supportsEffort('gemini')).toBe(false)
        expect(supportsEffort('pi')).toBe(true)
        expect(supportsEffort('grok')).toBe(true)
        expect(supportsEffort('kimi')).toBe(true)
        expect(supportsEffort(null)).toBe(false)
    })
})

type PermissionTraits = {
    replyStyle: 'decision' | 'allowTools' | 'generic'
    nativeSelect: boolean
    sharedState: boolean
    yoloToggleMigration: PermissionMode | null
    yolo: PermissionMode | null
}

const PERMISSION_TRAITS = {
    agy: { replyStyle: 'generic', nativeSelect: true, sharedState: true, yoloToggleMigration: 'always-proceed', yolo: 'always-proceed' },
    claude: { replyStyle: 'allowTools', nativeSelect: true, sharedState: true, yoloToggleMigration: 'bypassPermissions', yolo: 'bypassPermissions' },
    codex: { replyStyle: 'decision', nativeSelect: true, sharedState: true, yoloToggleMigration: 'yolo', yolo: 'yolo' },
    dsh: { replyStyle: 'generic', nativeSelect: false, sharedState: false, yoloToggleMigration: null, yolo: null },
    copilot: { replyStyle: 'decision', nativeSelect: true, sharedState: true, yoloToggleMigration: null, yolo: 'yolo' },
    cursor: { replyStyle: 'decision', nativeSelect: true, sharedState: true, yoloToggleMigration: 'yolo', yolo: 'yolo' },
    gemini: { replyStyle: 'decision', nativeSelect: true, sharedState: true, yoloToggleMigration: null, yolo: 'yolo' },
    grok: { replyStyle: 'decision', nativeSelect: true, sharedState: false, yoloToggleMigration: null, yolo: 'bypassPermissions' },
    kimi: { replyStyle: 'decision', nativeSelect: true, sharedState: true, yoloToggleMigration: null, yolo: 'yolo' },
    opencode: { replyStyle: 'decision', nativeSelect: true, sharedState: true, yoloToggleMigration: null, yolo: 'yolo' },
    pi: { replyStyle: 'generic', nativeSelect: false, sharedState: false, yoloToggleMigration: null, yolo: null },
} as const satisfies Record<AgentFlavor, PermissionTraits>

describe('permission traits', () => {
    test('the expectations cover exactly the known flavors', () => {
        expect(Object.keys(PERMISSION_TRAITS).sort()).toEqual([...AGENT_FLAVORS].sort())
    })

    test.each(AGENT_FLAVORS)('%s declares its permission reply style', (flavor) => {
        expect(getPermissionReplyStyle(flavor)).toBe(PERMISSION_TRAITS[flavor].replyStyle)
    })

    test.each(AGENT_FLAVORS)('%s declares whether the new-session form offers a native permission select', (flavor) => {
        expect(usesNativePermissionSelect(flavor)).toBe(PERMISSION_TRAITS[flavor].nativeSelect)
    })

    test.each(AGENT_FLAVORS)('%s declares whether the new-session form keeps its mode in the shared state', (flavor) => {
        expect(usesSharedPermissionModeState(flavor)).toBe(PERMISSION_TRAITS[flavor].sharedState)
    })

    test.each(AGENT_FLAVORS)('%s declares the mode a saved YOLO toggle migrates to', (flavor) => {
        expect(getYoloToggleMigrationMode(flavor)).toBe(PERMISSION_TRAITS[flavor].yoloToggleMigration)
    })

    test.each(AGENT_FLAVORS)('%s declares its auto-approve mode', (flavor) => {
        expect(resolveHapiYoloPermissionMode(flavor)).toBe(PERMISSION_TRAITS[flavor].yolo)
    })

    test.each([null, undefined, 'unknown-flavor'])('%p gets generic replies and no permission-mode controls', (flavor) => {
        expect(getPermissionReplyStyle(flavor)).toBe('generic')
        expect(usesNativePermissionSelect(flavor)).toBe(false)
        expect(usesSharedPermissionModeState(flavor)).toBe(false)
        expect(getYoloToggleMigrationMode(flavor)).toBeNull()
        expect(resolveHapiYoloPermissionMode(flavor)).toBeNull()
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
        expect(getPermissionReplyStyle('claude', 'Bash')).toBe('allowTools')
        expect(getPermissionReplyStyle('codex', 'Bash')).toBe('decision')
        expect(getPermissionReplyStyle('agy', 'Edit')).toBe('generic')
    })

    test('the prefix match is case-sensitive and anchored at the start', () => {
        expect(getPermissionReplyStyle('claude', 'codexSearch')).toBe('allowTools')
        expect(getPermissionReplyStyle('claude', 'MyCodexTool')).toBe('allowTools')
    })
})
