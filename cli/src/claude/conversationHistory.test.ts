import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    claudeConversationHistoryCapabilities,
    deriveSpawnArgs,
    nativeRewindApplied,
    parseClaudeVersion,
    planPendingRewindRestart,
    readCompletedNativeTurn,
    readNativeTurns,
    resolveForkAtMessagePlan,
    resolveRewindPlan,
    resumeSessionAtFromArgs,
    resumeSessionIdFromClaudeArgs,
    stripRewindFlags,
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

    it('keeps the chain tail when auxiliary uuid records trail the transcript', () => {
        // A trailing queue-operation/attachment record carries a uuid but is
        // not parented into the message chain; if it became the tailUuid the
        // parent backwalk would start at a disconnected node and see an empty
        // conversation - silently disabling rewind reconciliation.
        const root = writeTranscript([
            prompt('u1', 'first'),
            assistant('as1', 'first answer', 'u1'),
            line({ type: 'user', uuid: 'u2', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }),
            assistant('as2', 'second answer', 'u2'),
            line({ type: 'queue-operation', uuid: 'q9' }),
            attachment('a9')
        ])
        withConfigDir(root, () => {
            expect(readNativeTurns(CWD, 'session-a')).toEqual([
                { promptUuid: 'u1', endUuid: 'as1' },
                { promptUuid: 'u2', endUuid: 'as2' }
            ])
        })
    })

    it('does not treat a compact-summary user record as a rewind boundary', () => {
        // Claude writes compaction summaries as synthetic user records with
        // isCompactSummary: true on the active chain; they are not human turns
        // and must not become fork/rewind boundaries.
        const root = writeTranscript([
            prompt('u1', 'first'),
            assistant('as1', 'first answer', 'u1'),
            line({
                type: 'user',
                uuid: 'cs1',
                parentUuid: 'as1',
                isCompactSummary: true,
                message: { role: 'user', content: [{ type: 'text', text: 'Conversation summary so far' }] }
            })
        ])
        withConfigDir(root, () => {
            expect(readNativeTurns(CWD, 'session-a')).toEqual([
                { promptUuid: 'u1', endUuid: 'as1' }
            ])
        })
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

describe('planPendingRewindRestart', () => {
    const keptTurns = [
        { promptUuid: 'u1', endUuid: 'as1' },
        { promptUuid: 'u9', endUuid: 'as9' }
    ]
    const intent = {
        targetLocalId: 'local-2',
        truncateFromLocalId: 'local-2',
        keepBoundary: 'as1',
        droppedPrompts: ['u2', 'u3']
    }

    it('re-arms the boundary when the native branch has not applied', () => {
        const unapplied = [...keptTurns, { promptUuid: 'u2', endUuid: 'as2' }]
        expect(planPendingRewindRestart(intent, unapplied)).toEqual({ action: 'rearm' })
        expect(planPendingRewindRestart(intent, [])).toEqual({ action: 'rearm' })
    })

    it('clears the intent once the dropped turns left the native chain', () => {
        expect(planPendingRewindRestart(intent, keptTurns)).toEqual({ action: 'clear' })
    })
})

describe('nativeRewindApplied', () => {
    it('reads the active chain from the transcript', () => {
        const appliedRoot = writeTranscript([
            prompt('u1', 'first'),
            assistant('as1', 'first answer', 'u1'),
            line({ type: 'user', uuid: 'u9', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'text', text: 'after rewind' }] } })
        ])
        withConfigDir(appliedRoot, () => {
            expect(nativeRewindApplied(CWD, 'session-a', ['u2'])).toBe(true)
            expect(nativeRewindApplied(CWD, 'session-a', ['u1'])).toBe(false)
        })
        const unappliedRoot = writeTranscript([
            prompt('u1', 'first'),
            assistant('as1', 'first answer', 'u1'),
            line({ type: 'user', uuid: 'u2', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } })
        ])
        withConfigDir(unappliedRoot, () => {
            expect(nativeRewindApplied(CWD, 'session-a', ['u2'])).toBe(false)
        })
    })
})

/**
 * State-table cells for the spawn-time boundary derivation (the SSOT
 * decision point). Rows reference the design note's table:
 * ~/workspace/artifacts/2417-resume-at-design.md (S0-S8).
 */
describe('deriveSpawnArgs', () => {
    const intent = {
        targetLocalId: 'local-2',
        truncateFromLocalId: 'local-2',
        keepBoundary: 'as1',
        droppedPrompts: ['u2']
    }
    // Session ids must carry a dash: resumeSessionIdFromClaudeArgs only
    // accepts uuid-shaped anchors (see its heuristic test below).
    const unprovenRoot = () => writeTranscript([
        prompt('u1', 'first'),
        assistant('as1', 'first answer', 'u1'),
        prompt('u2', 'second'),
        assistant('as2', 'second answer', 'u2')
    ], 'sess-1')
    const appliedRoot = () => writeTranscript([
        prompt('u1', 'first'),
        assistant('as1', 'first answer', 'u1'),
        line({ type: 'user', uuid: 'u9', parentUuid: 'as1', message: { role: 'user', content: [{ type: 'text', text: 'after rewind' }] } })
    ], 'sess-1')

    it('S0: derives no boundary without intent or fork request', () => {
        expect(deriveSpawnArgs({ claudeArgs: ['--resume', 'sess-1'], sessionId: 'sess-1', intent: undefined, workingDirectory: CWD }))
            .toEqual({ args: ['--resume', 'sess-1'], boundary: null })
        expect(deriveSpawnArgs({ claudeArgs: undefined, sessionId: null, intent: undefined, workingDirectory: CWD }))
            .toEqual({ args: undefined, boundary: null })
    })

    it('S1/S2: re-derives the intent boundary fresh on every spawn while unproven', () => {
        const root = unprovenRoot()
        withConfigDir(root, () => {
            const options = {
                claudeArgs: ['--resume', 'sess-1'] as string[] | undefined,
                sessionId: 'sess-1' as string | null,
                intent,
                workingDirectory: CWD
            }
            // Two spawns of the same unproven intent (initial respawn, then a
            // post-init retry or crash relaunch) each truncate again.
            expect(deriveSpawnArgs(options)).toEqual({ args: ['--resume', 'sess-1', '--resume-session-at', 'as1'], boundary: 'as1' })
            expect(deriveSpawnArgs(options)).toEqual({ args: ['--resume', 'sess-1', '--resume-session-at', 'as1'], boundary: 'as1' })
        })
    })

    it('S3/S8: drops the boundary once the transcript shows the rewind applied', () => {
        const root = appliedRoot()
        withConfigDir(root, () => {
            // The intent may still sit in metadata inside the proof's
            // async-flush window; the fresh transcript evaluation wins.
            expect(deriveSpawnArgs({ claudeArgs: ['--resume', 'sess-1'], sessionId: 'sess-1', intent, workingDirectory: CWD }))
                .toEqual({ args: ['--resume', 'sess-1'], boundary: null })
        })
    })

    it('S4: after /clear there is no session to resume, so no boundary applies', () => {
        // Remote /clear: sessionId null and no --resume anchor. Even a
        // not-yet-cancelled intent cannot truncate anything.
        expect(deriveSpawnArgs({ claudeArgs: undefined, sessionId: null, intent, workingDirectory: CWD }))
            .toEqual({ args: undefined, boundary: null })
    })

    it('S5: applies the hub-built fork boundary while the child is unbuilt', () => {
        const args = ['--resume', 'source-id', '--fork-session', '--resume-session-at', 'fork-boundary']
        expect(deriveSpawnArgs({ claudeArgs: args, sessionId: null, intent: undefined, workingDirectory: CWD }))
            .toEqual({ args, boundary: 'fork-boundary' })
    })

    it('S5b: keeps the fork boundary when a SessionStart hook bound the id before the transcript exists', () => {
        // Major 1 (r6): the remote SessionStart hook binds session.sessionId
        // before system/init consumes the one-shot flags. Materialization is
        // the transcript on disk, not the bound id: a spawn attempt that exits
        // between the two must re-derive the boundary and keep --fork-session.
        const args = ['--resume', 'source-id', '--fork-session', '--resume-session-at', 'fork-boundary']
        expect(deriveSpawnArgs({ claudeArgs: args, sessionId: 'sess-1', intent: undefined, workingDirectory: CWD }))
            .toEqual({ args, boundary: 'fork-boundary' })
    })

    it('S6: drops the fork boundary and the fork flag once the child transcript materialized', () => {
        const root = unprovenRoot()
        withConfigDir(root, () => {
            const args = ['--resume', 'sess-1', '--fork-session', '--resume-session-at', 'fork-boundary']
            // The sessionId proves the child .jsonl exists and already carries
            // the truncation - even if a crash skipped consumeOneTimeFlags, a
            // later respawn must not re-truncate or re-fork.
            expect(deriveSpawnArgs({ claudeArgs: args, sessionId: 'sess-1', intent: undefined, workingDirectory: CWD }))
                .toEqual({ args: ['--resume', 'sess-1'], boundary: null })
        })
    })

    it('derives no boundary from an intent whose transcript is missing or empty', () => {
        // Minor 4 (r6): a missing/empty transcript can never be truncated, and
        // emitting the boundary makes claudeRemote throw
        // 'Pending resume-at request has no native session to resume' in a
        // respawn storm. No transcript on disk means no boundary.
        expect(deriveSpawnArgs({ claudeArgs: ['--resume', 'sess-1'], sessionId: 'sess-1', intent, workingDirectory: CWD }))
            .toEqual({ args: ['--resume', 'sess-1'], boundary: null })
    })

    it('walks the active chain across a compaction boundary via logicalParentUuid', () => {
        // Minor 6 (r6, verified against a real Claude Code 2.1.310 transcript):
        // compact_boundary entries carry parentUuid=null and
        // logicalParentUuid=<pre-compaction leaf>; the parentUuid-only walk
        // severed the chain there, hiding pre-compaction turns from rewind
        // resolution and falsely proving rewinds that span a compaction.
        const root = writeTranscript([
            prompt('u0', 'before compaction'),
            assistant('as0', 'old answer', 'u0'),
            line({ type: 'system', subtype: 'compact_boundary', uuid: 'cb-1', parentUuid: null, logicalParentUuid: 'as0' }),
            line({ type: 'user', uuid: 'u9', parentUuid: 'cb-1', isCompactSummary: true, message: { role: 'user', content: 'summary' } }),
            line({ type: 'user', uuid: 'u2', parentUuid: 'u9', message: { role: 'user', content: [{ type: 'text', text: 'after compaction' }] } }),
            assistant('as2', 'new answer', 'u2')
        ], 'sess-1')
        withConfigDir(root, () => {
            const turns = readNativeTurns(CWD, 'sess-1')
            // The synthetic compaction summary (isCompactSummary) is on the
            // chain but is not a human turn.
            expect(turns.map((turn) => turn.promptUuid)).toEqual(['u0', 'u2'])
        })
    })

    it('S7: resolves the resume anchor from args when no sessionId is captured yet', () => {
        const root = unprovenRoot()
        withConfigDir(root, () => {
            // Wrapper restart before the child id was captured: the anchor
            // comes from the --resume value.
            expect(deriveSpawnArgs({ claudeArgs: ['--resume', 'sess-1'], sessionId: null, intent, workingDirectory: CWD }).boundary)
                .toBe('as1')
        })
    })

    it('filters a stale boundary flag off claudeArgs but keeps --resume', () => {
        expect(deriveSpawnArgs({ claudeArgs: ['--resume', 'native-a', '--resume-session-at', 'stale'], sessionId: 'native-a', intent: undefined, workingDirectory: CWD }))
            .toEqual({ args: ['--resume', 'native-a'], boundary: null })
    })

    it('prefers the intent boundary over the fork boundary when both resolve', () => {
        const root = unprovenRoot()
        withConfigDir(root, () => {
            expect(deriveSpawnArgs({
                claudeArgs: ['--resume', 'sess-1', '--fork-session', '--resume-session-at', 'fork-boundary'],
                sessionId: null,
                intent,
                workingDirectory: CWD
            })).toEqual({
                args: ['--resume', 'sess-1', '--fork-session', '--resume-session-at', 'as1'],
                boundary: 'as1'
            })
        })
    })
})

describe('resumeSessionAtFromArgs', () => {
    it('reads the boundary value of a spawn request', () => {
        expect(resumeSessionAtFromArgs(['--resume', 'sid', '--resume-session-at', 'b1'])).toBe('b1')
        expect(resumeSessionAtFromArgs(['--resume', 'sid'])).toBeNull()
        expect(resumeSessionAtFromArgs(undefined)).toBeNull()
    })
})

describe('stripRewindFlags', () => {
    it('removes the one-shot resume-at flag with its value and keeps the rest', () => {
        expect(stripRewindFlags(['--resume', 'sid', '--resume-session-at', 'b1']))
            .toEqual(['--resume', 'sid'])
        expect(stripRewindFlags(['--resume-session-at', 'b1'])).toBeUndefined()
        expect(stripRewindFlags(undefined)).toBeUndefined()
    })
})

describe('resumeSessionIdFromClaudeArgs', () => {
    it('parses the --resume anchor the way claudeRemote resolves startFrom', () => {
        expect(resumeSessionIdFromClaudeArgs(['--resume', 'native-a', '--resume-session-at', 'b1'])).toBe('native-a')
        expect(resumeSessionIdFromClaudeArgs(['--permission-mode', 'default', '--resume', 'sid-x'])).toBe('sid-x')
        expect(resumeSessionIdFromClaudeArgs(['--permission-mode', 'default'])).toBeNull()
        expect(resumeSessionIdFromClaudeArgs(undefined)).toBeNull()
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