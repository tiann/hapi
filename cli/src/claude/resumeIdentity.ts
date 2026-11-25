import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalResumeTarget, ResumableSession } from '@hapi/protocol'
import type { ApiClient } from '@/api/api'
import { claudeCheckSession } from './utils/claudeCheckSession'
import { getProjectPath } from './utils/path'

/**
 * `hapi claude --resume/--continue` must pick the HAPI session BEFORE Claude
 * starts: `HAPI_SESSION_ID` is exported into the Claude process at bootstrap
 * and cannot change afterwards. Resolving here lets a resume reopen the HAPI
 * session that already owns the conversation (same id, same title, same
 * history) instead of minting a duplicate that the hub merges later.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ClaudeResumeRequest =
    | { kind: 'explicit'; agentSessionId: string }
    | { kind: 'picker' }
    | { kind: 'continue' }

export type ParsedClaudeResumeArgs = {
    request: ClaudeResumeRequest | null
    /** Claude args with the resume/continue flags (and their value) removed. */
    remainingArgs: string[]
}

/**
 * Extract Claude's session-selection flags. `--fork-session` keeps the args
 * untouched: a fork is an intentional new conversation (and a new HAPI id).
 * A non-UUID `--resume` value is Claude's picker search term, so it maps to
 * the picker.
 */
export function parseClaudeResumeArgs(args: readonly string[]): ParsedClaudeResumeArgs {
    const separator = args.indexOf('--')
    const flagArgs = separator === -1 ? args : args.slice(0, separator)
    const passthroughTail = separator === -1 ? [] : args.slice(separator)

    if (flagArgs.includes('--fork-session')) {
        return { request: null, remainingArgs: [...args] }
    }

    let request: ClaudeResumeRequest | null = null
    const remainingArgs: string[] = []
    for (let i = 0; i < flagArgs.length; i++) {
        const arg = flagArgs[i]!
        if (arg === '-r' || arg === '--resume' || arg.startsWith('--resume=')) {
            let value: string | undefined
            if (arg.startsWith('--resume=')) {
                value = arg.slice('--resume='.length)
            } else if (i + 1 < flagArgs.length && !flagArgs[i + 1]!.startsWith('-')) {
                value = flagArgs[++i]
            }
            request ??= value && UUID_RE.test(value.trim())
                ? { kind: 'explicit', agentSessionId: value.trim() }
                : { kind: 'picker' }
            continue
        }
        if (arg === '-c' || arg === '--continue') {
            request ??= { kind: 'continue' }
            continue
        }
        remainingArgs.push(arg)
    }

    if (!request) {
        return { request: null, remainingArgs: [...args] }
    }
    return { request, remainingArgs: [...remainingArgs, ...passthroughTail] }
}

/** Newest resumable Claude transcript for `workingDirectory` (Claude's `--continue` target). */
export function findLatestClaudeTranscriptId(workingDirectory: string): string | null {
    const projectDir = getProjectPath(workingDirectory)
    let names: string[]
    try {
        names = readdirSync(projectDir)
    } catch {
        return null
    }

    const candidates: Array<{ id: string; mtimeMs: number }> = []
    for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const id = name.slice(0, -'.jsonl'.length)
        if (!UUID_RE.test(id)) continue
        try {
            candidates.push({ id, mtimeMs: statSync(join(projectDir, name)).mtimeMs })
        } catch {
            // Raced with a delete; skip.
        }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

    for (const candidate of candidates) {
        if (claudeCheckSession(candidate.id, workingDirectory)) {
            return candidate.id
        }
    }
    return null
}

export type ClaudeResumeResolution =
    /** No HAPI session owns the conversation: start a new one with the original args. */
    | { kind: 'passthrough' }
    /** Reopen this HAPI session and resume its current Claude conversation. */
    | { kind: 'reopen'; target: LocalResumeTarget; notice?: string }

export type ClaudeResumeDeps = {
    api: Pick<ApiClient, 'getLocalResumeTargetByAgentSessionId' | 'listResumableSessions' | 'getLocalResumeTarget'>
    machineId: string
    workingDirectory: string
    isTTY: boolean
    selectSession: (sessions: ResumableSession[]) => Promise<string>
    findLatestTranscriptId?: (workingDirectory: string) => string | null
}

async function resolveByAgentSessionId(
    agentSessionId: string,
    deps: ClaudeResumeDeps
): Promise<ClaudeResumeResolution> {
    const result = await deps.api.getLocalResumeTargetByAgentSessionId(agentSessionId, deps.machineId)
    if (!result.target) {
        return { kind: 'passthrough' }
    }
    const notice = result.historical
        ? `Claude session ${agentSessionId} is an earlier id of HAPI session ${result.target.sessionId}; `
            + `resuming its latest conversation ${result.target.agentSessionId}.`
        : undefined
    return { kind: 'reopen', target: result.target, ...(notice ? { notice } : {}) }
}

/** Current directory first, then most recently updated. */
function orderForPicker(sessions: ResumableSession[], workingDirectory: string): ResumableSession[] {
    return [...sessions].sort((a, b) => {
        const aHere = a.directory === workingDirectory
        const bHere = b.directory === workingDirectory
        if (aHere !== bHere) return aHere ? -1 : 1
        return b.updatedAt - a.updatedAt
    })
}

export async function resolveClaudeResume(
    request: ClaudeResumeRequest,
    deps: ClaudeResumeDeps
): Promise<ClaudeResumeResolution> {
    if (request.kind === 'explicit') {
        return await resolveByAgentSessionId(request.agentSessionId, deps)
    }

    if (request.kind === 'continue') {
        const latest = (deps.findLatestTranscriptId ?? findLatestClaudeTranscriptId)(deps.workingDirectory)
        return latest ? await resolveByAgentSessionId(latest, deps) : { kind: 'passthrough' }
    }

    // Bare --resume: pick among HAPI's Claude sessions so the choice already
    // carries its HAPI id. With none known to HAPI, fall back to Claude's own
    // picker (the resumed conversation is then imported as a new session).
    const sessions = (await deps.api.listResumableSessions(deps.machineId))
        .filter((session) => session.flavor === 'claude')
    if (sessions.length === 0) {
        return { kind: 'passthrough' }
    }
    if (!deps.isTTY) {
        throw new Error('Pick a session explicitly: hapi claude --resume <claude-session-id>, or hapi resume <hapi-session-id>')
    }
    const sessionId = await deps.selectSession(orderForPicker(sessions, deps.workingDirectory))
    return { kind: 'reopen', target: await deps.api.getLocalResumeTarget(sessionId) }
}
