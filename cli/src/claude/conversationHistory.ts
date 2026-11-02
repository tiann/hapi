import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fsyncFile } from '@/utils/fsyncFile'
import { getProjectPath } from './utils/path'
import { isExternalUserMessage } from '@/api/apiSession'
import type { RawJSONLines } from '@/claude/types'

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
 * The transcript is append-only: rewinds re-parent new turns, so dropped
 * entries remain in the file as orphaned branches. Turns are therefore
 * resolved over the ACTIVE parentUuid chain — the one reachable backwards
 * from the last entry in the file — never over raw file order.
 */
export function readNativeTurns(workingDirectory: string, sessionId: string): NativeTurn[] {
    const file = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`)
    if (!existsSync(file)) return []

    type Node = { entry: TranscriptEntry; parent: string | null }
    const byUuid = new Map<string, Node>()
    let tailUuid: string | null = null
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        let entry: TranscriptEntry
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        if (entry.isSidechain) continue
        if (typeof entry.uuid !== 'string') continue
        byUuid.set(entry.uuid, {
            entry,
            parent: typeof entry.parentUuid === 'string' ? entry.parentUuid : null
        })
        tailUuid = entry.uuid
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
            // those are not human turns and must not become rewind boundaries.
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
 * The selected branch is materialized by a subsequent real input; the hub
 * separately commits its reserved suffix only after native branch evidence.
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
 * the rewind capability is not advertised against an unknown binary.
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
 * Build the resume flags to drop the turn started by `promptUuid` and every
 * turn after it on the active chain. The kept boundary is the last entry of
 * the previous turn; dropping every turn including the first is not
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

/**
 * Lazy positive acceptance proof for a rewind: Claude's first post-respawn
 * transcript write re-parents onto the kept boundary
 * (`parentUuid === resumeSessionAt` — observed on the next user turn's
 * `attachment prompt_snapshot`). An accepted respawn that receives no user
 * input writes nothing, so before the next turn this proof cannot exist.
 * Silence never implies acceptance. A rejected resume writes no branch proof.
 * `knownUuids` must be the full uuid set read BEFORE the respawn so only
 * post-respawn writes count.
 */
export function hasRewindProof(workingDirectory: string, sessionId: string, resumeSessionAt: string, knownUuids: ReadonlySet<string>): boolean {
    const file = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`)
    if (!existsSync(file)) return false
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        let entry: TranscriptEntry
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        if (typeof entry.uuid !== 'string' || knownUuids.has(entry.uuid)) continue
        if (entry.isSidechain) continue
        if (entry.parentUuid === resumeSessionAt) return true
    }
    return false
}

/** Snapshot of every entry uuid currently in the native transcript. */
export function readTranscriptUuids(workingDirectory: string, sessionId: string): Set<string> {
    const file = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`)
    const uuids = new Set<string>()
    if (!existsSync(file)) return uuids
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
            const entry = JSON.parse(line) as TranscriptEntry
            if (typeof entry.uuid === 'string') uuids.add(entry.uuid)
        } catch {
            continue
        }
    }
    return uuids
}

/** A real new user turn must select the requested branch; a startup marker
 * alone is not enough. Sync the native file before committing the hub side. */
export function hasDurableRewindBranch(
    workingDirectory: string, sessionId: string, boundary: string,
    baseline: ReadonlySet<string>, droppedPrompts: readonly string[], expectedTextHash?: string
): boolean {
    if (!hasRewindProof(workingDirectory, sessionId, boundary, baseline)) return false
    const turns = readNativeTurns(workingDirectory, sessionId)
    if (!turns.some(turn => !baseline.has(turn.promptUuid))
        || turns.some(turn => droppedPrompts.includes(turn.promptUuid))) return false
    if (expectedTextHash) {
        const freshPrompts = new Set(turns.filter(turn => !baseline.has(turn.promptUuid)).map(turn => turn.promptUuid))
        const entries = readFileSync(join(getProjectPath(workingDirectory), `${sessionId}.jsonl`), 'utf8').split('\n')
        const matches = entries.some(line => {
            let entry: TranscriptEntry
            try { entry = JSON.parse(line) } catch { return false }
            if (typeof entry.uuid !== 'string' || !freshPrompts.has(entry.uuid)) return false
            const content = entry.message?.content
            const text = typeof content === 'string' ? content : Array.isArray(content)
                ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''
            return hashRewindInput(text) === expectedTextHash
        })
        if (!matches) return false
    }
    fsyncFile(join(getProjectPath(workingDirectory), `${sessionId}.jsonl`))
    return true
}

export function hashRewindInput(text: string): string {
    return createHash('sha256').update(text).digest('hex')
}
