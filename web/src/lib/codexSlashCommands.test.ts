import { describe, expect, it } from 'vitest'
import { findUnsupportedCodexBuiltinSlashCommand, getBuiltinSlashCommands } from './codexSlashCommands'

describe('getBuiltinSlashCommands', () => {
    it('does not expose codex built-ins in remote web mode', () => {
        expect(getBuiltinSlashCommands('codex')).toEqual([])
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
