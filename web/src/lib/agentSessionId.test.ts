import { describe, expect, it } from 'vitest'
import type { Metadata } from '@/types/api'
import { getAgentResumeCommand, getAgentSessionId, getResumeCommand } from '@/lib/agentSessionId'

function metadata(overrides: Partial<Metadata>): Metadata {
    return { path: '/work', host: 'host', ...overrides }
}

describe('getAgentSessionId', () => {
    it.each([
        ['claude', 'claudeSessionId', 'claude-id'],
        ['codex', 'codexSessionId', 'codex-id'],
        ['gemini', 'geminiSessionId', 'gemini-id'],
        ['opencode', 'opencodeSessionId', 'opencode-id'],
        ['grok', 'grokSessionId', 'grok-id'],
        ['cursor', 'cursorSessionId', 'cursor-id'],
        ['kimi', 'kimiSessionId', 'kimi-id'],
        ['pi', 'piSessionId', 'pi-id']
    ] as const)('returns the %s session id', (flavor, field, id) => {
        expect(getAgentSessionId(metadata({ flavor, [field]: ` ${id} ` }))).toBe(id)
    })

    it('prefers the id matching the current flavor over stale ids from another agent', () => {
        expect(getAgentSessionId(metadata({
            flavor: 'cursor',
            codexSessionId: 'stale-codex-id',
            cursorSessionId: 'cursor-id'
        }))).toBe('cursor-id')
    })

    it('falls back to the available native id for unknown or missing flavors', () => {
        expect(getAgentSessionId(metadata({ flavor: 'custom', piSessionId: 'pi-id' }))).toBe('pi-id')
    })

    it('returns null when no native agent session id is available', () => {
        expect(getAgentSessionId(metadata({ flavor: 'codex' }))).toBeNull()
        expect(getAgentSessionId(null)).toBeNull()
    })
})

describe('getAgentResumeCommand', () => {
    it.each([
        ['claude', 'claudeSessionId', 'claude --resume claude-id'],
        ['codex', 'codexSessionId', 'codex resume codex-id'],
        ['opencode', 'opencodeSessionId', 'opencode -s opencode-id'],
        ['grok', 'grokSessionId', 'grok --resume grok-id'],
        ['cursor', 'cursorSessionId', 'agent resume cursor-id'],
        ['kimi', 'kimiSessionId', 'kimi --session kimi-id'],
        ['pi', 'piSessionId', 'pi --session-id pi-id']
    ] as const)('builds the %s native resume command', (flavor, field, command) => {
        expect(getAgentResumeCommand(metadata({ flavor, [field]: `${flavor}-id` }))).toBe(command)
    })

    it('does not build a command for an unknown flavor or a mismatched stale id', () => {
        expect(getAgentResumeCommand(metadata({ flavor: 'custom', codexSessionId: 'codex-id' }))).toBeNull()
        expect(getAgentResumeCommand(metadata({ flavor: 'cursor', codexSessionId: 'codex-id' }))).toBeNull()
    })

    it('does not build a command for retired Gemini sessions', () => {
        expect(getAgentResumeCommand(metadata({
            flavor: 'gemini',
            geminiSessionId: 'gemini-id'
        }))).toBeNull()
        expect(getResumeCommand('gemini', 'gemini-id')).toBeNull()
    })

    it.each([
        'thread-id; rm -rf /',
        'thread-id && whoami',
        '$(whoami)',
        '`whoami`',
        'thread id',
        "thread'id",
        'thread"id'
    ])('rejects an unsafe native session id: %s', (sessionId) => {
        expect(getResumeCommand('codex', sessionId)).toBeNull()
    })

    it('builds the same command from flattened session-summary metadata', () => {
        expect(getResumeCommand(' codex ', ' thread-id ')).toBe('codex resume thread-id')
        expect(getResumeCommand('custom', 'thread-id')).toBeNull()
    })
})
