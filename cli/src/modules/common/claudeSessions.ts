import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
import {
    extractRawUserTextContent,
    isExternalUserMessage,
    isImportableClaudeEntry,
    listClaudeSubagentFiles,
    readSubagentParentToolUseId
} from '@/claude/utils/transcriptEntry'
import { getClaudeProjectsDir } from '@/claude/utils/path'
import type { ClaudeLocalSessionSummary, ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'

/**
 * Local Claude Code transcript reader for history import.
 * Conversations live in ~/.claude/projects/<encoded cwd>/<session>.jsonl with
 * per-session subagent transcripts in <session>/subagents/agent-*.jsonl.
 */

type ClaudeSessionFile = {
    sessionId: string
    filePath: string
    modifiedAt: number
    mtimeMs: number
}

async function listSessionFiles(): Promise<ClaudeSessionFile[]> {
    const projectsDir = getClaudeProjectsDir()
    const projectDirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => [])
    const files: ClaudeSessionFile[] = []
    for (const project of projectDirs) {
        if (!project.isDirectory()) continue
        const entries = await readdir(join(projectsDir, project.name), { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
            const filePath = join(projectsDir, project.name, entry.name)
            const stats = await stat(filePath).catch(() => null)
            if (!stats) continue
            files.push({
                sessionId: basename(entry.name, '.jsonl'),
                filePath,
                modifiedAt: Math.round(stats.mtimeMs),
                mtimeMs: stats.mtimeMs
            })
        }
    }
    // Newest file wins per session id: Claude Code leaves a stale copy behind
    // when a session moves between project dirs (worktree enter/leave), and
    // both list output and import must see exactly one, newest transcript.
    // Raw mtimes order sub-millisecond writes; the path breaks exact ties so
    // every scan picks the same copy whatever the directory listing order.
    const seen = new Set<string>()
    return files
        .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.filePath.localeCompare(b.filePath))
        .filter((file) => {
            if (seen.has(file.sessionId)) return false
            seen.add(file.sessionId)
            return true
        })
}

function parseLine(line: string): RawJSONLines | null {
    try {
        const parsed = JSON.parse(line)
        const result = RawJSONLinesSchema.safeParse(parsed)
        return result.success ? result.data : null
    } catch {
        return null
    }
}

async function readTranscriptEntries(filePath: string): Promise<RawJSONLines[]> {
    const content = await readFile(filePath, 'utf-8').catch(() => '')
    const entries: RawJSONLines[] = []
    for (const line of content.split('\n')) {
        if (!line.trim()) continue
        const parsed = parseLine(line)
        if (parsed) entries.push(parsed)
    }
    return entries
}

/** Importable entries keep the chat-visible filter the live replay uses. */
function isImportableEntry(entry: RawJSONLines): boolean {
    if (entry.type === 'summary' || entry.type === 'ai-title') return false
    return isImportableClaudeEntry(entry)
}

/**
 * Assemble one session's ordered entries: main transcript entries with each
 * subagent transcript's entries spliced in right before the main entry that
 * carries the matching tool_result. The parent tool_use id comes from the
 * sidechain rows themselves when present, falling back to the sibling
 * meta.json; batches are ordered by their first entry's timestamp so a
 * re-import stays position-stable regardless of directory listing order.
 * Subagent batches without a matching tool_result land at the end of the
 * conversation (in timestamp order): a later import that finds them a
 * matching tool_result would move them earlier, which the anchored matcher
 * deliberately rejects as diverged (matchAnchored pins insert-ahead) instead
 * of rewriting already-imported history. Unfiltered: summary/ai-title
 * bookkeeping rows stay in so the title can be derived from them.
 */
async function readAssembledEntries(sessionFile: string): Promise<RawJSONLines[]> {
    const mainEntries = await readTranscriptEntries(sessionFile)
    const subagentFiles = await listClaudeSubagentFiles(sessionFile)
    if (subagentFiles.length === 0) return mainEntries

    const parentCache = new Map<string, string>()
    const batches: Array<{ parentToolUseId: string; entries: RawJSONLines[] }> = []
    for (const subagentFile of subagentFiles) {
        const entries = await readTranscriptEntries(subagentFile)
        // Claude Code 2.x stamps the spawning tool_use id on every sidechain
        // entry; older logs only record it in the sibling meta.json.
        const nativeParentToolUseId = entries.find((entry) => typeof entry.parentToolUseId === 'string' && entry.parentToolUseId)?.parentToolUseId
        const parentToolUseId = nativeParentToolUseId ?? await readSubagentParentToolUseId(subagentFile, parentCache)
        const stamped = parentToolUseId
            ? entries.map((entry) => (
                entry.isSidechain && !entry.parentToolUseId
                    ? { ...entry, parentToolUseId } as RawJSONLines
                    : entry
            ))
            : entries
        if (stamped.length > 0) {
            batches.push({ parentToolUseId: parentToolUseId ?? '', entries: stamped })
        }
    }
    if (batches.length === 0) return mainEntries

    // Chronological batch order: the splice target fixes the position, and
    // this keeps same-target batches (and unmatched tails) deterministic
    // across directory listing orders.
    const firstTimestamp = (batch: { entries: RawJSONLines[] }): number => {
        const parsed = batch.entries[0]?.timestamp ? Date.parse(batch.entries[0].timestamp) : NaN
        return Number.isFinite(parsed) ? parsed : 0
    }
    batches.sort((a, b) => firstTimestamp(a) - firstTimestamp(b))

    const toolResultIndex = new Map<string, number>()
    mainEntries.forEach((entry, index) => {
        if (entry.type !== 'user') return
        const blocks = entry.message?.content
        if (!Array.isArray(blocks)) return
        for (const block of blocks) {
            const record = block as { type?: unknown; tool_use_id?: unknown }
            if (record?.type === 'tool_result' && typeof record.tool_use_id === 'string') {
                if (!toolResultIndex.has(record.tool_use_id)) {
                    toolResultIndex.set(record.tool_use_id, index)
                }
            }
        }
    })

    const insertions = new Map<number, RawJSONLines[]>()
    const unmatched: RawJSONLines[] = []
    for (const batch of batches) {
        const targetIndex = batch.parentToolUseId ? toolResultIndex.get(batch.parentToolUseId) : undefined
        if (targetIndex === undefined) {
            unmatched.push(...batch.entries)
            continue
        }
        const existing = insertions.get(targetIndex) ?? []
        existing.push(...batch.entries)
        insertions.set(targetIndex, existing)
    }

    const ordered: RawJSONLines[] = []
    mainEntries.forEach((entry, index) => {
        ordered.push(...(insertions.get(index) ?? []))
        ordered.push(entry)
    })
    ordered.push(...unmatched)
    return ordered
}

/** Importable entries in conversation order, chat-visible like the live replay. */
export async function readClaudeSessionEntries(sessionFile: string): Promise<RawJSONLines[]> {
    return (await readAssembledEntries(sessionFile)).filter(isImportableEntry)
}

function toImportedMessage(entry: RawJSONLines): ClaudeLocalSessionWithMessages['messages'][number] | null {
    // An empty uuid would fail the hub's anchor validation (z.string().min(1))
    // for the whole machine import: drop the row instead.
    if (typeof entry.uuid !== 'string' || entry.uuid.trim().length === 0) return null
    const createdAt = entry.timestamp ? Date.parse(entry.timestamp) : undefined
    if (entry.type !== 'assistant' && entry.type !== 'user' && entry.type !== 'system') {
        return null
    }
    if (isExternalUserMessage(entry)) {
        const text = extractRawUserTextContent(entry.message.content) ?? ''
        return {
            uuid: entry.uuid,
            ...(Number.isFinite(createdAt) ? { createdAt } : {}),
            content: {
                role: 'user',
                content: { type: 'text', text },
                meta: { sentFrom: 'cli' }
            }
        }
    }
    return {
        uuid: entry.uuid,
        ...(Number.isFinite(createdAt) ? { createdAt } : {}),
        content: {
            role: 'agent',
            content: { type: 'output', data: entry },
            meta: { sentFrom: 'cli' }
        }
    }
}

/** The messages an import of these entries stores; summaries count the same rows. */
function toImportedMessages(rawEntries: RawJSONLines[]): ClaudeLocalSessionWithMessages['messages'] {
    return rawEntries
        .filter(isImportableEntry)
        .map(toImportedMessage)
        .filter((message): message is NonNullable<typeof message> => message !== null)
}

function toSummary(
    sessionFile: ClaudeSessionFile,
    rawEntries: RawJSONLines[],
    messages: ClaudeLocalSessionWithMessages['messages']
): ClaudeLocalSessionSummary {
    const userTexts: string[] = []
    let cwd: string | undefined
    for (const entry of rawEntries) {
        if (!cwd && typeof entry.cwd === 'string' && entry.cwd.trim()) cwd = entry.cwd
        if (isExternalUserMessage(entry)) {
            userTexts.push(extractRawUserTextContent(entry.message.content) ?? '')
        }
    }
    // The native interactive-CLI title beats the compaction summary line
    // (summaries narrate a continuation, they do not name the conversation).
    const aiTitle = rawEntries.find((entry): entry is Extract<RawJSONLines, { type: 'ai-title' }> => entry.type === 'ai-title')?.aiTitle
    const summaryTitle = rawEntries.find((entry): entry is Extract<RawJSONLines, { type: 'summary' }> => entry.type === 'summary')?.summary
    const title = aiTitle ?? summaryTitle ?? ''
    return {
        id: sessionFile.sessionId,
        title: title || userTexts[0]?.trim().slice(0, 80) || `Claude session ${sessionFile.sessionId.slice(0, 8)}`,
        lastUserMessage: userTexts.at(-1) ?? null,
        cwd: cwd ?? null,
        file: sessionFile.filePath,
        modifiedAt: sessionFile.modifiedAt,
        messageCount: messages.length
    }
}

/** Summaries of the most recent local Claude conversations. */
export async function listLocalClaudeSessionSummaries(): Promise<ClaudeLocalSessionSummary[]> {
    const files = await listSessionFiles()
    const summaries: ClaudeLocalSessionSummary[] = []
    for (const sessionFile of files) {
        const rawEntries = await readAssembledEntries(sessionFile.filePath)
        const messages = toImportedMessages(rawEntries)
        if (messages.length === 0) continue
        summaries.push(toSummary(sessionFile, rawEntries, messages))
    }
    return summaries
}

/** Full transcripts for exactly the requested session ids. */
export async function listLocalClaudeSessionsWithMessagesByIds(sessionIds: Set<string>): Promise<ClaudeLocalSessionWithMessages[]> {
    const files = (await listSessionFiles()).filter((sessionFile) => sessionIds.has(sessionFile.sessionId))
    const sessions: ClaudeLocalSessionWithMessages[] = []
    for (const sessionFile of files) {
        const rawEntries = await readAssembledEntries(sessionFile.filePath)
        const messages = toImportedMessages(rawEntries)
        if (messages.length === 0) continue
        sessions.push({
            ...toSummary(sessionFile, rawEntries, messages),
            messages
        })
    }
    return sessions
}