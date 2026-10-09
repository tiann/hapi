import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNativeTurns, resolveRewindPlan, supportsNativeRewind } from './conversationHistory'

const CWD = '/tmp/rewind-fixture-project'

function line(entry: Record<string, unknown>): string {
    return JSON.stringify(entry)
}

function prompt(uuid: string, text: string): string {
    return line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })
}

function toolResult(uuid: string, parentUuid?: string): string {
    return line({
        type: 'user',
        uuid,
        parentUuid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] }
    })
}

function assistant(uuid: string, text: string): string {
    return line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

function attachment(uuid: string): string {
    return line({ type: 'attachment', uuid })
}

function sidechain(uuid: string): string {
    return line({ type: 'assistant', uuid, isSidechain: true, message: { role: 'assistant', content: [] } })
}

function writeTranscript(lines: string[]): string {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'hapi-rewind-')), 'projects')
    mkdirSync(projectDir, { recursive: true })
    // getProjectPath encodes every non-alphanumeric char of the cwd as '-'
    const projectId = CWD.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(projectDir, projectId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-a.jsonl'), lines.join('\n') + '\n')
    return projectDir
}

describe('readNativeTurns', () => {
    it('collects ordered turns from prompts and assistant entries only', () => {
        const root = writeTranscript([
            line({ type: 'queue-operation', uuid: 'q1' }),
            attachment('a0'),
            line({ type: 'user', uuid: 'u1', parentUuid: 'a0', message: { role: 'user', content: [{ type: 'text', text: 'Say ONE' }] } }),
            line({ type: 'assistant', uuid: 'as1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'ONE' }] } }),
            toolResult('tr1', 'as1'),
            line({ type: 'user', uuid: 'u2', parentUuid: 'tr1', message: { role: 'user', content: [{ type: 'text', text: 'Say TWO' }] } }),
            line({ type: 'assistant', uuid: 'as2', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'TWO' }] } }),
            sidechain('sc1'),
            line({ type: 'user', uuid: 'u3', parentUuid: 'as2', message: { role: 'user', content: [{ type: 'text', text: 'Say THREE' }] } })
        ])
        try {
            process.env.CLAUDE_CONFIG_DIR = root.replace(/\/projects$/, '')
            expect(readNativeTurns(CWD, 'session-a')).toEqual([
                { promptUuid: 'u1', endUuid: 'as1' },
                { promptUuid: 'u2', endUuid: 'as2' },
                { promptUuid: 'u3', endUuid: 'u3' }
            ])
        } finally {
            delete process.env.CLAUDE_CONFIG_DIR
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('returns empty for a missing transcript', () => {
        process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'hapi-rewind-missing-config')
        try {
            expect(readNativeTurns('/nonexistent-cwd', 'nope')).toEqual([])
        } finally {
            delete process.env.CLAUDE_CONFIG_DIR
        }
    })
})

describe('supportsNativeRewind', () => {
    it('accepts versions at or above 2.1.223', () => {
        expect(supportsNativeRewind('2.1.240 (Claude Code)')).toBe(true)
        expect(supportsNativeRewind('2.2.0 (Claude Code)')).toBe(true)
        expect(supportsNativeRewind('3.0.1')).toBe(true)
        expect(supportsNativeRewind('2.1.223 (Claude Code)')).toBe(true)
    })

    it('rejects older and undetectable binaries', () => {
        expect(supportsNativeRewind('2.1.222 (Claude Code)')).toBe(false)
        expect(supportsNativeRewind('2.0.55')).toBe(false)
        expect(supportsNativeRewind(null)).toBe(false)
        expect(supportsNativeRewind('Claude Code')).toBe(false)
    })
})

describe('resolveRewindPlan', () => {
    const turns = [
        { promptUuid: 'u1', endUuid: 'as1' },
        { promptUuid: 'u2', endUuid: 'as2' },
        { promptUuid: 'u3', endUuid: 'as3' }
    ]

    it('keeps the previous turn boundary and drops the selected turn onward', () => {
        expect(resolveRewindPlan(turns, 'u2')).toEqual({
            resumeSessionAt: 'as1',
            dropsTurns: ['u2', 'u3']
        })
    })

    it('rejects unknown prompts and dropping the first turn', () => {
        expect(() => resolveRewindPlan(turns, 'nope')).toThrow('No native history point')
        expect(() => resolveRewindPlan(turns, 'u1')).toThrow('Cannot rewind the first message')
    })
})

describe('readNativeTurns active chain', () => {
    function writeLines(lines: string[]): void {
        const root = writeTranscript(lines)
        process.env.CLAUDE_CONFIG_DIR = root.replace(/\/projects$/, '')
    }

    it('ignores orphaned branches left by a previous rewind', () => {
        // u1 -> as1 -> (orphaned: u2 -> as2) ; after rewind the new turn re-parents onto as1
        const lines = [
            line({ type: 'user', uuid: 'u1', parentUuid: 'p0', message: { role: 'user', content: 'Say ONE' } }),
            line({ type: 'assistant', uuid: 'as1', parentUuid: 'x0', message: { role: 'assistant', content: [{ type: 'text', text: 'ONE' }] } }),
            line({ type: 'user', uuid: 'u2', parentUuid: 'as1', message: { role: 'user', content: 'Say TWO' } }),
            line({ type: 'assistant', uuid: 'as2', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'TWO' }] } })
        ]
        try {
            writeLines(lines)
            // tail is as2; walking parents from as2 only reaches the orphaned branch
            expect(readNativeTurns(CWD, 'session-a')).toEqual([
                { promptUuid: 'u2', endUuid: 'as2' }
            ])
        } finally {
            delete process.env.CLAUDE_CONFIG_DIR
        }
    })

    it('follows re-parented turns across a rewind boundary', () => {
        const lines = [
            line({ type: 'user', uuid: 'u1', parentUuid: 'p0', message: { role: 'user', content: 'Say ONE' } }),
            line({ type: 'attachment', uuid: 'att', parentUuid: 'u1' }),
            line({ type: 'assistant', uuid: 'as1', parentUuid: 'att', message: { role: 'assistant', content: [{ type: 'text', text: 'ONE' }] } }),
            // orphaned branch
            line({ type: 'user', uuid: 'u2', parentUuid: 'as1', message: { role: 'user', content: 'Say TWO' } }),
            line({ type: 'assistant', uuid: 'as2', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'TWO' }] } }),
            // new turn re-parented onto as1
            line({
                type: 'user',
                uuid: 'inj',
                parentUuid: 'as1',
                isMeta: true,
                message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] }
            }),
            line({ type: 'user', uuid: 'u3', parentUuid: 'as1', message: { role: 'user', content: 'Say THREE' } }),
            line({ type: 'user', uuid: 'u4', parentUuid: 'u3', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] } }),
            line({ type: 'assistant', uuid: 'as3', parentUuid: 'u4', message: { role: 'assistant', content: [{ type: 'text', text: 'THREE' }] } })
        ]
        try {
            writeLines(lines)
            const turns = readNativeTurns(CWD, 'session-a')
            expect(turns.map((t) => t.promptUuid)).toEqual(['u1', 'u3'])
            expect(resolveRewindPlan(turns, 'u3')).toEqual({
                resumeSessionAt: 'as1',
                dropsTurns: ['u3']
            })
        } finally {
            delete process.env.CLAUDE_CONFIG_DIR
        }
    })
})
