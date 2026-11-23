import { describe, expect, test } from 'vitest'
import { AGENT_FLAVORS, isCodexFamilyFlavor } from '@hapi/protocol'
import {
    CODEX_FAMILY_PERMISSION_AGENTS,
    LEGACY_YOLO_BRIDGE_AGENTS,
    usesCodexFamilyPermissionModes,
    usesNativePermissionSelect,
    usesSharedPermissionModeState,
} from './codexFamilyPermissionAgents'

type Expected = {
    family: boolean
    codexModes: boolean
    nativeSelect: boolean
    sharedMode: boolean
    legacyYolo: boolean
}

/**
 * Pins every exported membership predicate for every known flavor. The values
 * below were recorded from the pre-refactor implementation; changing any
 * membership list in shared/ or web/ must update this table deliberately.
 */
const EXPECTED = {
    agy: { family: false, codexModes: false, nativeSelect: true, sharedMode: true, legacyYolo: true },
    claude: { family: false, codexModes: false, nativeSelect: true, sharedMode: true, legacyYolo: true },
    codex: { family: true, codexModes: true, nativeSelect: true, sharedMode: true, legacyYolo: true },
    dsh: { family: false, codexModes: false, nativeSelect: false, sharedMode: false, legacyYolo: false },
    copilot: { family: true, codexModes: true, nativeSelect: true, sharedMode: true, legacyYolo: false },
    cursor: { family: false, codexModes: false, nativeSelect: true, sharedMode: true, legacyYolo: true },
    gemini: { family: true, codexModes: true, nativeSelect: true, sharedMode: true, legacyYolo: false },
    grok: { family: true, codexModes: false, nativeSelect: true, sharedMode: false, legacyYolo: false },
    kimi: { family: true, codexModes: true, nativeSelect: true, sharedMode: true, legacyYolo: false },
    opencode: { family: true, codexModes: true, nativeSelect: true, sharedMode: true, legacyYolo: false },
    pi: { family: false, codexModes: false, nativeSelect: false, sharedMode: false, legacyYolo: false },
} as const satisfies Record<(typeof AGENT_FLAVORS)[number], Expected>

describe('codex-family membership predicates', () => {
    test('the pin table covers exactly AGENT_FLAVORS', () => {
        expect(Object.keys(EXPECTED).sort()).toEqual([...AGENT_FLAVORS].sort())
    })

    for (const flavor of AGENT_FLAVORS) {
        test(`${flavor}: every predicate matches its pinned value`, () => {
            const expected = EXPECTED[flavor]

            expect(isCodexFamilyFlavor(flavor)).toBe(expected.family)
            expect(usesCodexFamilyPermissionModes(flavor)).toBe(expected.codexModes)
            expect((CODEX_FAMILY_PERMISSION_AGENTS as readonly string[]).includes(flavor)).toBe(expected.codexModes)
            expect(usesNativePermissionSelect(flavor)).toBe(expected.nativeSelect)
            expect(usesSharedPermissionModeState(flavor)).toBe(expected.sharedMode)
            expect(LEGACY_YOLO_BRIDGE_AGENTS.includes(flavor)).toBe(expected.legacyYolo)
        })
    }
})
