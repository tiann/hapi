import { describe, expect, it } from 'vitest'
import {
    findCodexCustomPromptExpansion,
    findUnsupportedCodexBuiltinSlashCommand,
    getBuiltinSlashCommands,
    mergeSlashCommands
} from './codexSlashCommands'

describe('getBuiltinSlashCommands', () => {
    it('exposes HAPI-supported codex built-ins in remote web mode', () => {
        expect(getBuiltinSlashCommands('codex').map((command) => command.name)).toEqual(expect.arrayContaining([
            'clear',
            'compact',
            'plan',
            'status',
            'execute',
            'effort',
            'permission',
        ]))
    })
})

describe('mergeSlashCommands', () => {
    it('lets custom commands override same-name built-ins', () => {
        const commands = mergeSlashCommands([
            { name: 'clear', source: 'builtin' },
            { name: 'compact', source: 'builtin' },
            { name: 'clear', source: 'project', content: 'project clear prompt' }
        ])

        expect(commands).toEqual([
            { name: 'compact', source: 'builtin' },
            { name: 'clear', source: 'project', content: 'project clear prompt' }
        ])
    })
})

describe('findCodexCustomPromptExpansion', () => {
    it('expands exact custom codex prompt commands', () => {
        expect(findCodexCustomPromptExpansion('  /clear  ', [
            { name: 'clear', source: 'builtin' },
            { name: 'clear', source: 'project', content: 'custom clear prompt' }
        ])).toBe('custom clear prompt')
    })

    it('ignores built-ins and commands with arguments', () => {
        const commands = [
            { name: 'compact', source: 'project', content: 'custom compact prompt' }
        ] as const

        expect(findCodexCustomPromptExpansion('/compact now', commands)).toBeNull()
        expect(findCodexCustomPromptExpansion('/clear', [
            { name: 'clear', source: 'builtin' }
        ])).toBeNull()
    })
})

describe('findUnsupportedCodexBuiltinSlashCommand', () => {
    it('detects unsupported codex built-ins', () => {
        expect(findUnsupportedCodexBuiltinSlashCommand('  /diff ', [])).toBe('diff')
    })

    it('ignores regular messages and unknown commands', () => {
        expect(findUnsupportedCodexBuiltinSlashCommand('show me status', [])).toBeNull()
        expect(findUnsupportedCodexBuiltinSlashCommand('/custom-status', [])).toBeNull()
    })

    it('does not block custom commands that override the same name', () => {
        expect(findUnsupportedCodexBuiltinSlashCommand('/status', [
            { name: 'status', source: 'project', content: 'project status prompt' }
        ])).toBeNull()
    })
})
