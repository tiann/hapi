import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    claudeConversationHistoryCapabilities,
    parseClaudeVersion,
    readCompletedNativeTurn,
    readNativeTurns,
    resolveForkAtMessagePlan,
    resolveRewindPlan,
    supportsNativeRewind
} from './conversationHistory'

const CWD = '/tmp/rewind-fixture-project'

function line(entry: Record<string, unknown>): string {
    return JSON.stringify(entry)
}

function prompt(uuid: string, text: string): string {
    return line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })
}

function assistant(uuid: string, text: string, parentUuid?: string): string {
    return line({ type: 'assistant', uuid, ...(parentUuid ? { parentUuid } : {}), message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

function attachment(uuid: string): string {
    return line({ type: 'attachment', uuid })
}

function sidechain(uuid: string): string {
    return line({ type: 'assistant', uuid, isSidechain: true, message: { role: 'assistant', content: [] } })
}

/** Writes a transcript under a temp CLAUDE_CONFIG_DIR; returns the config root. */
function writeTranscript(lines: string[], sessionId = 'session-a'): string {
    const root = mkdtempSync(join(tmpdir(), 'hapi-claude-conv-'))
    const projectDir = join(root, 'projects')
    const projectId = CWD.replace(/[^a-zA-Z0-9]/g, '-')
    mkdirSync(join(projectDir, projectId), { recursive: true })
    writeFileSync(join(projectDir, projectId, `${sessionId}.jsonl`), lines.join('\n') + '\n')
    return root
}

function withConfigDir<T>(root: string, run: () => T): T {
    const previous = process.env.CLAUDE_CONFIG_DIR
    try {
        process.env.CLAUDE_CONFIG_DIR = root
        return run()
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previous
        rmSync(root, { recursive: true, force: true })
    }
}

describe('supportsNativeRewind', () => {
    it('accepts versions at or above 2.1.223 and rejects older or unknown output', () => {
        expect(supportsNativeRewind('2.1.223 (Claude Code)')).toBe(true)
        expect(supportsNativeRewind('2.1.240 (Claude Code)')).toBe(true)
        expect(supportsNativeRewind('2.2.0 (Claude Code)')).toBe(true)
        expect(supportsNativeRewind('3.0.1')).toBe(true)
        expect(supportsNativeRewind('2.1.222 (Claude Code)')).toBe(false)
        expect(supportsNativeRewind('2.0.9 (Claude Code)')).toBe(false)
        expect(supportsNativeRewind('1.9.9')).toBe(false)
        expect(supportsNativeRewind(null)).toBe(false)
        expect(supportsNativeRewind(undefined)).toBe(false)
        expect(supportsNativeRewind('')).toBe(false)
        expect(supportsNativeRewind('not-a-version')).toBe(false)
    })

    it('parses the leading version triple', () => {
        expect(parseClaudeVersion('2.1.223 (Claude Code)')).toEqual([2, 1, 223])
        expect(parseClaudeVersion('v3.0.1-beta.2')).toEqual([3, 0, 1])
        expect(parseClaudeVersion('garbage')).toBeNull()
    })
})

describe('claudeConversationHistoryCapabilities', () => {
    it('gates fork-at-message and rewind on the native version, keeping fork-current always', () => {
        expect(claudeConversationHistoryCapabilities('2.1.300 (Claude Code)')).toEqual({
            forkCurrent: true,
            forkAtMessage: true,
            rewindToMessage: true
        })
        expect(claudeConversationHistoryCapabilities('2.0.0 (Claude Code)')).toEqual({ forkCurrent: true })
        expect(claudeConversationHistoryCapabilities(null)).toEqual({ forkCurrent: true })
    })
})

describe('readNativeTurns', () => {
    it('collects ordered turns over the active chain, ignoring attachments and sidechains', () => {
        const root = writeTranscript([
            line({ type: 'queue-operation', uuid: 'q1' }),
            attachment('a0'),
            line({ type: 'user', uuid: 'u1', parentUuid: 'a0', message: { role: 'user', content: [{ type: 'text', text: 'Say ONE' }] } }),
            assistant('as1', 'ONE', 'u1'),
            line({ type: 'user', uuid: 'tr1', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
            line({ type: 'user', uuid: 'u2', parentUuid: 'tr1', message: { role: 'user', content: [{ type: 'text', text: 'Say TWO' }] } }),
            assistant('as2', 'TWO', 'u2'),
            sidechain('sc1')
        ])
        withConfigDir(root, () => {
            expect(readNativeTurns(CWD, 'session-a')).toEqual([
                { promptUuid: 'u1', endUuid: 'as1' },
                { promptUuid: 'u2', endUuid: 'as2' }
            ])
            expect(readCompletedNativeTurn(CWD, 'session-a', 'u1')).toEqual({ promptUuid: 'u1', endUuid: 'as1' })
            expect(readCompletedNativeTurn(CWD, 'session-a', 'missing')).toBeUndefined()
            expect(readCompletedNativeTurn(CWD, 'session-a')).toBeUndefined()
        })
    })

    it('binds a completed prompt when a steered message is the native tail', () => {
        const root = writeTranscript([
            prompt('u1', 'Q'),
            assistant('as1', 'Q answer', 'u1'),
            line({ type: 'user', uuid: 'u2', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'text', text: 'steered R' }] } })
        ])
        withConfigDir(root, () => {
            expect(readNativeTurns(CWD, 'session-a').at(-1)).toEqual({ promptUuid: 'u2', endUuid: 'u2' })
            expect(readCompletedNativeTurn(CWD, 'session-a', 'u1')).toEqual({ promptUuid: 'u1', endUuid: 'as1' })
        })
    })

    it('resolves turns over the re-parented chain after a rewind orphans later branches', () => {
        // The transcript is append-only: after a rewind, the new turn is
        // appended with a parentUuid back on an earlier entry, orphaning the
        // dropped branch. The file tail is the re-parented turn.
        const root = writeTranscript([
            prompt('u1', 'first'),
            assistant('as1', 'first answer', 'u1'),
            line({ type: 'user', uuid: 'u2', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }),
            assistant('as2', 'second answer', 'u2'),
            line({ type: 'user', uuid: 'u3', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'text', text: 'rewritten second' }] } })
        ])
        withConfigDir(root, () => {
            expect(readNativeTurns(CWD, 'session-a')).toEqual([
                { promptUuid: 'u1', endUuid: 'as1' },
                { promptUuid: 'u3', endUuid: 'u3' }
            ])
        })
    })

    it('returns no turns for a missing transcript', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-claude-conv-empty-'))
        withConfigDir(root, () => {
            expect(readNativeTurns(CWD, 'absent')).toEqual([])
        })
        rmSync(root, { recursive: true, force: true })
    })
})

describe('resolveForkAtMessagePlan', () => {
    const turns = [
        { promptUuid: 'u1', endUuid: 'as1' },
        { promptUuid: 'u2', endUuid: 'as2' },
        { promptUuid: 'u3', endUuid: 'as3' }
    ]

    it('keeps the previous turn boundary as the truncation point', () => {
        expect(resolveForkAtMessagePlan(turns, 'u3')).toEqual({ resumeSessionAt: 'as2' })
        expect(resolveForkAtMessagePlan(turns, 'u2')).toEqual({ resumeSessionAt: 'as1' })
    })

    it('rejects unknown prompts and forking before the first message', () => {
        expect(() => resolveForkAtMessagePlan(turns, 'missing')).toThrow(/No native history point/)
        expect(() => resolveForkAtMessagePlan(turns, 'u1')).toThrow(/first/i)
    })
})

describe('resolveRewindPlan', () => {
    const turns = [
        { promptUuid: 'u1', endUuid: 'as1' },
        { promptUuid: 'u2', endUuid: 'as2' },
        { promptUuid: 'u3', endUuid: 'as3' }
    ]

    it('keeps the previous turn boundary for the dropped turn', () => {
        expect(resolveRewindPlan(turns, 'u3')).toEqual({ resumeSessionAt: 'as2' })
        expect(resolveRewindPlan(turns, 'u2')).toEqual({ resumeSessionAt: 'as1' })
    })

    it('rejects unknown prompts and the first message', () => {
        expect(() => resolveRewindPlan(turns, 'missing')).toThrow(/No native history point/)
        expect(() => resolveRewindPlan(turns, 'u1')).toThrow(/first/i)
    })
})