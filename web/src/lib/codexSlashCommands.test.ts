import { describe, expect, it } from 'vitest'
import { getPermissionModesForFlavor } from '@hapi/protocol/modes'
import {
    getBuiltinSlashCommands,
    mergeSlashCommands
} from './codexSlashCommands'

describe('getBuiltinSlashCommands', () => {
    it('exposes HAPI-supported codex built-ins in remote web mode', () => {
        expect(getBuiltinSlashCommands('codex').map((command) => command.name)).toEqual(expect.arrayContaining([
            'clear',
            'compact',
            'goal',
            'plan',
            'status',
            'execute',
            'effort',
            'permission',
        ]))
    })

    it('exposes Cursor pass-through builtins', () => {
        expect(getBuiltinSlashCommands('cursor').map((command) => command.name)).toEqual(
            ['compress']
        )
    })

    it('keeps pi builtins as its own list (no Claude fallback)', () => {
        const commands = getBuiltinSlashCommands('pi')
        expect(commands.length).toBeGreaterThan(0)
        expect(commands.map((command) => command.name)).not.toContain('clear')
        expect(commands.map((command) => command.name)).toContain('compact')
    })

    it('does not fall back to Claude commands for kimi', () => {
        expect(getBuiltinSlashCommands('kimi')).toEqual([])
    })

    it('includes debug only in Cursor permission modes', () => {
        expect(getPermissionModesForFlavor('cursor')).toContain('debug')
        expect(getPermissionModesForFlavor('claude')).not.toContain('debug')
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

    it('keeps API-provided built-ins while de-duplicating by name', () => {
        const commands = mergeSlashCommands([
            { name: 'clear', source: 'builtin' },
            { name: 'status', source: 'builtin' },
            { name: 'help', source: 'builtin' },
            { name: 'status', source: 'builtin', description: 'Captured status' },
            { name: 'project-only', source: 'project', content: 'Project prompt' }
        ])

        expect(commands).toEqual([
            { name: 'clear', source: 'builtin' },
            { name: 'help', source: 'builtin' },
            { name: 'status', source: 'builtin', description: 'Captured status' },
            { name: 'project-only', source: 'project', content: 'Project prompt' }
        ])
    })

})
