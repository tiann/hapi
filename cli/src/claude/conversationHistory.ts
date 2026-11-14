import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectPath } from './utils/path'
import { claudeCheckSession } from './utils/claudeCheckSession'
import { isExternalUserMessage } from '@/api/apiSession'
import type { RawJSONLines } from '@/claude/types'
import {
    CLAUDE_CONVERSATION_HISTORY,
    toConversationHistoryCapabilities,
    type ConversationHistoryCapabilities
} from '@hapi/protocol/conversationHistory'

export type NativeTurn = {
    /** uuid of the user prompt entry that starts the turn. */
    promptUuid: string
    /** uuid of the last user/assistant entry belonging to the turn on the active chain. */
    endUuid: string
}

type TranscriptEntry = {
    type?: string
    uuid?: unknown
    parentUuid?: unknown
    isSidechain?: boolean
    message?: { content?: unknown }
}

/**
 * Parse the native Claude transcript for a session into ordered turns.
 *
 * The transcript is append-only: rewinds and fork-at-message boundaries
 * re-parent new turns, so dropped entries remain in the file as orphaned
 * branches. Turns are therefore resolved over the ACTIVE parentUuid chain —
 * the one reachable backwards from the last entry in the file — never over
 * raw file order.
 */
export function readNativeTurns(workingDirectory: string, sessionId: string): NativeTurn[] {
    const file = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`)
    if (!existsSync(file)) return []

    type Node = { entry: TranscriptEntry; parent: string | null }
    const byUuid = new Map<string, Node>()
    let tailUuid: string | null = null
    for (const lineText of readFileSync(file, 'utf-8').split('\n')) {
        if (!lineText.trim()) continue
        let entry: TranscriptEntry
        try {
            entry = JSON.parse(lineText)
        } catch {
            continue
        }
        if (entry.isSidechain) continue
        if (typeof entry.uuid !== 'string') continue
        byUuid.set(entry.uuid, {
            entry,
            // Claude Code severs the parentUuid chain at compaction:
            // compact_boundary entries carry parentUuid=null and
            // logicalParentUuid=<pre-compaction leaf> (verified against a
            // real v2.1.310 transcript). Following the logical parent keeps
            // pre-compaction turns reachable for rewind resolution and
            // prevents falsely proving a rewind that spans a compaction.
            parent: typeof entry.parentUuid === 'string'
                ? entry.parentUuid
                : typeof (entry as { logicalParentUuid?: unknown }).logicalParentUuid === 'string'
                    ? (entry as { logicalParentUuid: string }).logicalParentUuid
                    : null
        })
        // Only message records may become the tailUuid: auxiliary records
        // (attachments, queue operations) can carry a uuid without being
        // parented into the message chain, and starting the backwalk at a
        // disconnected node would see an empty conversation and silently
        // disable rewind reconciliation. They stay in byUuid so a chain that
        // links through them still walks.
        if (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system') {
            tailUuid = entry.uuid
        }
    }
    if (!tailUuid) return []

    // Walk parents from the tail; entries not on this chain are orphaned branches.
    const chain: TranscriptEntry[] = []
    const visited = new Set<string>()
    let cursor: string | null = tailUuid
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor)
        const node = byUuid.get(cursor)
        if (!node) break
        chain.push(node.entry)
        cursor = node.parent
    }
    chain.reverse()

    const turns: NativeTurn[] = []
    for (const entry of chain) {
        if (entry.type !== 'user' && entry.type !== 'assistant') continue
        const uuid = entry.uuid as string
        if (entry.type === 'user') {
            // Reuse HAPI's classifier: Claude also writes system reminders, task
            // notifications and command caveats as text-bearing user entries —
            // those are not human turns and must not become history boundaries.
            if (!isExternalUserMessage(entry as RawJSONLines)) continue
            turns.push({ promptUuid: uuid, endUuid: uuid })
        } else if (turns.length > 0) {
            turns[turns.length - 1]!.endUuid = uuid
        }
    }
    return turns
}

export function readCompletedNativeTurn(workingDirectory: string, sessionId: string, promptUuid?: string): NativeTurn | undefined {
    if (!promptUuid) return undefined
    return readNativeTurns(workingDirectory, sessionId).find(turn => turn.promptUuid === promptUuid)
}

export type RewindPlan = {
    resumeSessionAt?: string
}

/**
 * Native `--resume-session-at` truncation landed in Claude Code v2.1.223.
 * Resuming with it drops every turn at and after the boundary on the active
 * chain; the dropped branch stays in the file as orphans.
 */
export const NATIVE_REWIND_MIN_VERSION = [2, 1, 223] as const

export function parseClaudeVersion(versionOutput: string | null | undefined): number[] | null {
    if (!versionOutput) return null
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput)
    if (!match) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Whether the installed Claude Code supports resume-time truncation.
 * `null`/unparseable output (detection failed) conservatively reports false so
 * the capabilities are not advertised against an unknown binary.
 */
export function supportsNativeRewind(versionOutput: string | null | undefined): boolean {
    const version = parseClaudeVersion(versionOutput)
    if (!version) return false
    for (let i = 0; i < NATIVE_REWIND_MIN_VERSION.length; i++) {
        const actual = version[i] ?? 0
        const min = NATIVE_REWIND_MIN_VERSION[i]!
        if (actual !== min) return actual > min
    }
    return true
}

/**
 * Session-metadata capabilities for the claude flavor. Fork-current works on
 * any version; fork-at-message and rewind need native resume-time truncation.
 */
export function claudeConversationHistoryCapabilities(versionOutput: string | null | undefined): ConversationHistoryCapabilities | undefined {
    const native = supportsNativeRewind(versionOutput) ? 'supported' : 'unsupported'
    return toConversationHistoryCapabilities({
        ...CLAUDE_CONVERSATION_HISTORY,
        forkAtMessage: native,
        rewindToMessage: native
    })
}

export type ForkAtMessagePlan = {
    resumeSessionAt?: string
}

/**
 * Plan a fork at the turn started by `promptUuid`: the child's history ends
 * before that turn, matching the hub transcript prefix convention (the
 * selected boundary turn is excluded). The kept boundary is the last entry of
 * the previous turn — `--resume-session-at` truncates unconditionally after
 * it, so no drops flags are needed. Forking at the first message would
 * produce an empty child and is rejected.
 */
export function resolveForkAtMessagePlan(turns: NativeTurn[], promptUuid: string): ForkAtMessagePlan {
    const index = turns.findIndex((turn) => turn.promptUuid === promptUuid)
    if (index < 0) {
        throw new Error(`No native history point for message prompt ${promptUuid}`)
    }
    if (index === 0) {
        throw new Error('Cannot fork before the first message')
    }
    return {
        resumeSessionAt: turns[index - 1]!.endUuid
    }
}

/** Durable re-arm record for a pending Claude rewind. */
export type ClaudeRewindIntent = {
    targetLocalId: string
    truncateFromLocalId: string
    keepBoundary: string
    droppedPrompts: string[]
}

export type PendingRewindRestart = { action: 'rearm' } | { action: 'clear' }

/**
 * Crash-consistency for a rewind's two systems under the immediate-hub-truncate
 * design: the hub transcript is truncated once, at rewind-RPC success, and the
 * NATIVE boundary re-arm is the durable part. The intent in session metadata is
 * the key. On (re)start: dropped turns still on the active chain mean the
 * native branch never applied, so the boundary flags are re-armed for this
 * launch; dropped turns gone mean the native branch applied and the intent is
 * cleared (pure housekeeping).
 */
export function planPendingRewindRestart(intent: ClaudeRewindIntent, turns: NativeTurn[]): PendingRewindRestart {
    const applied = turns.length > 0 && turns.every((turn) => !intent.droppedPrompts.includes(turn.promptUuid))
    return applied ? { action: 'clear' } : { action: 'rearm' }
}

/**
 * Whether the active chain no longer contains the rewind's dropped turns -
 * the transcript evidence that the native truncation took (dropped branches
 * survive in the append-only file but leave the parentUuid chain).
 */
export function nativeRewindApplied(workingDirectory: string, sessionId: string, droppedPrompts: readonly string[]): boolean {
    const turns = readNativeTurns(workingDirectory, sessionId)
    return turns.length > 0 && turns.every((turn) => !droppedPrompts.includes(turn.promptUuid))
}

/**
 * Removes one-shot resume-at flags from claudeArgs after a rewind commits, so
 * later respawns do not re-truncate. Returns undefined for absent args.
 */
export function stripRewindFlags(args: string[] | undefined): string[] | undefined {
    if (!args) return undefined
    const filtered: string[] = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--resume-session-at' && i + 1 < args.length) {
            i++
            continue
        }
        filtered.push(args[i]!)
    }
    return filtered.length > 0 ? filtered : undefined
}

/**
 * The session id a fresh claudeRemote() spawn would resume: claudeRemote
 * falls back to parsing `--resume <id>` from claudeArgs when no live session
 * id is passed, so a rewind armed on a not-yet-attached session must resolve
 * its plan against that same id. Mirrors claudeRemote's dash-heuristic parse.
 */
export function resumeSessionIdFromClaudeArgs(args: string[] | undefined): string | null {
    if (!args) return null
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--resume') continue
        const nextArg = args[i + 1]
        if (nextArg && !nextArg.startsWith('-') && nextArg.includes('-')) {
            return nextArg
        }
        return null
    }
    return null
}

/** The resume-at boundary value of a spawn request, if any. */
export function resumeSessionAtFromArgs(args: string[] | undefined): string | null {
    if (!args) return null
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--resume-session-at' && i + 1 < args.length) {
            return args[i + 1]!
        }
    }
    return null
}

/**
 * The spawn-time resume-at decision — the single source of truth for the
 * boundary flag. Every Claude spawn (remote and local) derives its args
 * here instead of carrying a mutated flag buffer:
 *
 * - A same-session rewind's boundary comes from the durable
 *   `metadata.claudeRewind` intent and applies while the dropped turns are
 *   still on the active chain — evaluated FRESH against the transcript, so
 *   a spawn landing after the proof self-corrects to no boundary.
 * - A fork-at-message request's boundary rides the hub-built spawn args and
 *   applies only while the child has not materialized (no sessionId yet);
   * once it has, the child file already carries the truncated history and
 *   re-applying would cut post-fork turns from every later respawn.
 *
 * `session.claudeArgs` is only ever READ here: the returned args are a
 * filtered copy with at most one boundary appended, and no code path may
 * add or strip rewind flags on the buffer as a side effect of init, /clear,
 * consumeOneTimeFlags or respawn.
 */
export function deriveSpawnArgs(options: {
    claudeArgs: string[] | undefined
    sessionId: string | null
    intent: ClaudeRewindIntent | undefined
    workingDirectory: string
}): { args: string[] | undefined; boundary: string | null } {
    // Materialization is a transcript ON DISK, not a bound session id: the
    // remote SessionStart hook binds session.sessionId before system/init
    // consumes the one-shot flags, so an attempt that exits in between must
    // still re-derive the fork boundary. This is the single fact every fork
    // decision derives from, matching claudeRemote/claudeLocal's own
    // claudeCheckSession startFrom gate.
    const materialized = options.sessionId != null && claudeCheckSession(options.sessionId, options.workingDirectory)
    let baseArgs = stripRewindFlags(options.claudeArgs)
    const forkPending = options.claudeArgs?.includes('--fork-session') === true && !materialized
    const forkBoundary = forkPending ? resumeSessionAtFromArgs(options.claudeArgs) : null
    if (materialized) {
        // The fork already happened; keeping --fork-session would re-fork the
        // materialized child on a respawn that races the one-shot consumption
        // (e.g. the local launcher's launch-success consume).
        baseArgs = baseArgs?.filter((arg) => arg !== '--fork-session')
    }
    const intentSessionId = options.sessionId ?? resumeSessionIdFromClaudeArgs(options.claudeArgs)
    let intentBoundary: string | null = null
    if (options.intent && intentSessionId) {
        const turns = readNativeTurns(options.workingDirectory, intentSessionId)
        const plan = planPendingRewindRestart(options.intent, turns)
        // A missing or empty transcript can never be truncated: emitting the
        // boundary only makes claudeRemote throw 'Pending resume-at request
        // has no native session to resume' in a respawn storm.
        intentBoundary = plan.action === 'rearm' && turns.length > 0 ? options.intent.keepBoundary : null
    }
    const boundary = intentBoundary ?? forkBoundary
    const args = boundary ? [...(baseArgs ?? []), '--resume-session-at', boundary] : baseArgs
    return { args, boundary }
}

/**
 * Plan a rewind to the turn started by `promptUuid`: resume truncated to the
 * previous turn's last entry. `--resume-session-at` truncates everything
 * after the boundary unconditionally (the drops guard is not used), so no
 * drops flags are needed. Dropping every turn including the first is not
 * representable and is rejected.
 */
export function resolveRewindPlan(turns: NativeTurn[], dropFromPromptUuid: string): RewindPlan {
    const index = turns.findIndex((turn) => turn.promptUuid === dropFromPromptUuid)
    if (index < 0) {
        throw new Error(`No native history point for message prompt ${dropFromPromptUuid}`)
    }
    if (index === 0) {
        throw new Error('Cannot rewind the first message')
    }
    return {
        resumeSessionAt: turns[index - 1]!.endUuid
    }
}