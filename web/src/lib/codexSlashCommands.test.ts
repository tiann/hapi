import { describe, expect, it, vi } from 'vitest'
import {
    findUnsupportedCodexBuiltinSlashCommand,
    findUnsupportedCodexBuiltinSlashCommandAfterDeferredLoad,
    getBuiltinSlashCommands
} from './codexSlashCommands'

describe('getBuiltinSlashCommands', () => {
    it('exposes only Codex built-ins that HAPI remote mode handles end-to-end', () => {
        expect(getBuiltinSlashCommands('codex')).toEqual([
            { name: 'compact', description: 'Compact conversation context', source: 'builtin' },
            { name: 'goal', description: 'Set, view, or clear the conversation goal', source: 'builtin' },
        ])
    })
})

describe('findUnsupportedCodexBuiltinSlashCommand', () => {
    it('detects unsupported codex built-ins', () => {
        expect(findUnsupportedCodexBuiltinSlashCommand('/status', [])).toBe('status')
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

describe('findUnsupportedCodexBuiltinSlashCommandAfterDeferredLoad', () => {
    it('loads deferred commands before blocking an unsupported Codex builtin name', async () => {
        const loadCommands = vi.fn(async () => [
            { name: 'status', source: 'project' as const, content: 'project status prompt' }
        ])

        await expect(findUnsupportedCodexBuiltinSlashCommandAfterDeferredLoad(
            '/status',
            getBuiltinSlashCommands('codex'),
            loadCommands
        )).resolves.toBeNull()
        expect(loadCommands).toHaveBeenCalledTimes(1)
    })

    it('does not load deferred commands for normal messages', async () => {
        const loadCommands = vi.fn(async () => [])

        await expect(findUnsupportedCodexBuiltinSlashCommandAfterDeferredLoad(
            'show me status',
            getBuiltinSlashCommands('codex'),
            loadCommands
        )).resolves.toBeNull()
        expect(loadCommands).not.toHaveBeenCalled()
    })
})
