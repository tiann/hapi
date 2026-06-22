#!/usr/bin/env bun
/**
 * Import legacy agent transcript lines into HAPI sqlite messages for a session.
 *
 * Usage:
 *   bun scripts/tooling/backfill-agent-transcript.ts --session <hapiSessionId> --agent cursor --chat-id <uuid>
 *   bun scripts/tooling/backfill-agent-transcript.ts --session <id> --transcript /path/to/file.jsonl --agent cursor
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { AGENT_MESSAGE_PAYLOAD_TYPE } from '../../shared/src/modes'
import { isClaudeChatVisibleMessage } from '../../shared/src/messages'
import { Store } from '../../hub/src/store'
import { getMaxSeq, markMessagesInvoked } from '../../hub/src/store/messages'

type AgentFlavor = 'cursor' | 'claude' | 'codex'
type HapiMessageContent = Record<string, unknown>

const BACKFILL_META = { sentFrom: 'backfill' }
// Per-attach cap on imported messages. Set high enough to cover real chats
// (jessica-story founding chat: 2974 lines; agent-notify 5.4MB chats can hit
// 6k+ lines). Override via --max-messages or HAPI_BACKFILL_MAX_MESSAGES env.
// At 50k we'd cap on roughly 30MB of jsonl input — generous, and the import
// is one-time per session so there's no steady-state cost.
const DEFAULT_MAX_MESSAGES = 50_000

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name)
    if (i >= 0) return process.argv[i + 1]
    const prefix = `${name}=`
    const hit = process.argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
}

function usage(): never {
    console.error(`Usage: bun scripts/tooling/backfill-agent-transcript.ts \\
  --session <hapiSessionId> (--agent cursor|claude|codex --chat-id <uuid> | --transcript <path>) \\
  [--project <projectDir>]   # tie-breaker when the same chat UUID exists under multiple Cursor/Claude projects
  [--max-messages <N>]       # per-attach import cap (default 50000; env: HAPI_BACKFILL_MAX_MESSAGES)
  [--db ~/.hapi/hapi.db] [--dry-run] [--force]`)
    process.exit(2)
}

function expandHome(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

type TranscriptCandidate = {
    path: string
    slug: string
    size: number
}

function projectPathToSlug(projectPath: string): string {
    // Cursor / Claude project dirs replace path separators with single hyphens,
    // e.g. /home/heavygee/coding/openab -> home-heavygee-coding-openab
    // Claude prefixes with a single leading dash.
    const trimmed = projectPath.replace(/^\/+|\/+$/g, '')
    return trimmed.split('/').filter(Boolean).join('-')
}

function scoreCandidate(c: TranscriptCandidate, projectHint?: string): number {
    // Higher is better. Matching slug wins decisively; size breaks ties.
    let score = c.size
    if (projectHint) {
        const wantSlug = projectPathToSlug(projectHint)
        if (c.slug === wantSlug || c.slug === `-${wantSlug}`) score += 1_000_000_000
    }
    return score
}

function pickCandidate(
    agent: AgentFlavor,
    chatId: string,
    candidates: TranscriptCandidate[],
    projectHint?: string
): string | null {
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]!.path
    const ranked = [...candidates].sort((a, b) => scoreCandidate(b, projectHint) - scoreCandidate(a, projectHint))
    const winner = ranked[0]!
    const loserPaths = ranked.slice(1).map((c) => `  - ${c.path} (size=${c.size})`).join('\n')
    console.warn(
        `warn: ${candidates.length} ${agent} transcripts found for chat ${chatId}; ` +
        `using "${winner.path}" (size=${winner.size}${projectHint ? `, projectHint=${projectHint}` : ''}).\n` +
        `  other candidates:\n${loserPaths}`
    )
    return winner.path
}

function findCursorTranscriptCandidates(chatId: string, rootOverride?: string): TranscriptCandidate[] {
    const root = rootOverride ?? join(homedir(), '.cursor', 'projects')
    if (!existsSync(root)) return []
    const needle = chatId.toLowerCase()
    const found: TranscriptCandidate[] = []
    for (const slug of readdirSync(root)) {
        const tryPush = (p: string) => {
            if (!existsSync(p)) return
            try {
                const st = statSync(p)
                if (st.isFile()) found.push({ path: p, slug, size: st.size })
            } catch {
                // ignore stat errors
            }
        }
        tryPush(join(root, slug, 'agent-transcripts', chatId, `${chatId}.jsonl`))
        const dir = join(root, slug, 'agent-transcripts')
        if (!existsSync(dir)) continue
        for (const entry of readdirSync(dir)) {
            if (entry.toLowerCase() === needle) continue // already pushed above
            if (!entry.toLowerCase().startsWith(needle)) continue
            tryPush(join(dir, entry, `${entry}.jsonl`))
        }
    }
    // De-dupe by path
    const seen = new Set<string>()
    return found.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)))
}

function findClaudeTranscriptCandidates(chatId: string, rootOverride?: string): TranscriptCandidate[] {
    const root = rootOverride ?? join(homedir(), '.claude', 'projects')
    if (!existsSync(root)) return []
    const needle = chatId.toLowerCase()
    const found: TranscriptCandidate[] = []
    for (const slug of readdirSync(root)) {
        const tryPush = (p: string) => {
            if (!existsSync(p)) return
            try {
                const st = statSync(p)
                if (st.isFile()) found.push({ path: p, slug, size: st.size })
            } catch {
                // ignore
            }
        }
        tryPush(join(root, slug, `${chatId}.jsonl`))
        const projectDir = join(root, slug)
        if (!existsSync(projectDir)) continue
        for (const name of readdirSync(projectDir)) {
            if (!name.endsWith('.jsonl')) continue
            const base = name.slice(0, -'.jsonl'.length)
            if (base.toLowerCase() === needle) continue
            if (base.toLowerCase().startsWith(needle)) tryPush(join(projectDir, name))
        }
    }
    const seen = new Set<string>()
    return found.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)))
}

function findCodexTranscriptCandidates(chatId: string, rootOverride?: string): TranscriptCandidate[] {
    const root = rootOverride ?? join(homedir(), '.codex', 'sessions')
    if (!existsSync(root)) return []
    const found: TranscriptCandidate[] = []

    function walk(dir: string): void {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            let st
            try { st = statSync(full) } catch { continue }
            if (st.isDirectory()) { walk(full); continue }
            if (!entry.startsWith('rollout-') || !entry.endsWith('.jsonl')) continue
            try {
                const text = readFileSync(full, 'utf8')
                const first = text.split('\n').find((l) => l.trim())
                if (!first) continue
                const row = JSON.parse(first) as { type?: string; payload?: { id?: string } }
                if (row.type === 'session_meta' && row.payload?.id === chatId) {
                    found.push({ path: full, slug: '', size: st.size })
                }
            } catch {
                // skip malformed
            }
        }
    }

    walk(root)
    return found
}

export function resolveTranscriptPath(
    agent: AgentFlavor,
    chatId: string,
    projectHint?: string,
    rootOverride?: string
): string | null {
    const candidates = agent === 'cursor' ? findCursorTranscriptCandidates(chatId, rootOverride)
        : agent === 'claude' ? findClaudeTranscriptCandidates(chatId, rootOverride)
        : findCodexTranscriptCandidates(chatId, rootOverride)
    return pickCandidate(agent, chatId, candidates, projectHint)
}

function extractCursorText(content: unknown): string {
    if (!Array.isArray(content)) return ''
    return content
        .filter((c): c is { type: string; text: string } => !!c && typeof c === 'object' && (c as { type?: string }).type === 'text')
        .map((c) => c.text)
        .join('')
}

type CodexWireMessage = {
    type: 'message' | 'reasoning' | 'tool-call' | 'tool-call-result'
    message?: string
    id?: string
    name?: string
    callId?: string
    input?: unknown
    output?: unknown
}

function convertCodexTranscriptLine(row: Record<string, unknown>): { userMessage?: string; message?: CodexWireMessage } | null {
    if (row.type === 'session_meta') return null
    const payload = row.payload
    if (!payload || typeof payload !== 'object') return null
    const p = payload as Record<string, unknown>
    const eventType = typeof p.type === 'string' ? p.type : null
    if (!eventType) return null

    if (eventType === 'user_message' && typeof p.message === 'string') {
        return { userMessage: p.message }
    }
    if (eventType === 'agent_message' && typeof p.message === 'string') {
        return { message: { type: 'message', message: p.message, id: typeof p.id === 'string' ? p.id : randomUUID() } }
    }
    if (eventType === 'reasoning' && typeof p.message === 'string') {
        return { message: { type: 'reasoning', message: p.message, id: typeof p.id === 'string' ? p.id : randomUUID() } }
    }
    if (eventType === 'function_call') {
        const callId = typeof p.call_id === 'string' ? p.call_id : randomUUID()
        return {
            message: {
                type: 'tool-call',
                name: typeof p.name === 'string' ? p.name : 'tool',
                callId,
                input: p.arguments ?? p.input ?? {},
                id: callId
            }
        }
    }
    if (eventType === 'function_call_output') {
        const callId = typeof p.call_id === 'string' ? p.call_id : randomUUID()
        return {
            message: {
                type: 'tool-call-result',
                callId,
                output: p.output ?? p.result ?? p.content,
                id: callId
            }
        }
    }
    return null
}

export function transcriptLinesToHapiMessages(
    agent: AgentFlavor,
    transcriptPath: string,
    opts?: { maxMessages?: number }
): HapiMessageContent[] {
    const max = opts?.maxMessages ?? DEFAULT_MAX_MESSAGES
    const raw = readFileSync(transcriptPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    const out: HapiMessageContent[] = []
    let seq = 0

    for (const line of lines) {
        let row: Record<string, unknown>
        try {
            row = JSON.parse(line) as Record<string, unknown>
        } catch {
            continue
        }

        if (agent === 'cursor') {
            const role = row.role
            if (role !== 'user' && role !== 'assistant') continue
            const message = row.message as { content?: unknown } | undefined
            const text = extractCursorText(message?.content)
            if (!text.trim()) continue
            if (role === 'user') {
                out.push({
                    role: 'user',
                    content: { type: 'text', text },
                    meta: BACKFILL_META
                })
            } else {
                const id = typeof row.id === 'string' ? row.id : `backfill-cursor-${seq}`
                out.push({
                    role: 'agent',
                    content: {
                        type: AGENT_MESSAGE_PAYLOAD_TYPE,
                        data: { type: 'message', message: text, id }
                    },
                    meta: BACKFILL_META
                })
            }
            seq += 1
            continue
        }

        if (agent === 'claude') {
            const type = row.type
            if (type === 'user') {
                const message = row.message as { content?: unknown } | undefined
                const text = typeof message?.content === 'string'
                    ? message.content
                    : Array.isArray(message?.content)
                        ? message.content
                            .filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object')
                            .map((c) => (c.type === 'text' && c.text ? c.text : ''))
                            .join('')
                        : ''
                if (!text.trim()) continue
                out.push({
                    role: 'user',
                    content: { type: 'text', text },
                    meta: BACKFILL_META
                })
                seq += 1
                continue
            }
            if (!isClaudeChatVisibleMessage({ type, subtype: row.subtype })) continue
            out.push({
                role: 'agent',
                content: { type: 'output', data: row },
                meta: BACKFILL_META
            })
            seq += 1
            continue
        }

        if (agent === 'codex') {
            const converted = convertCodexTranscriptLine(row)
            if (!converted) continue
            if (converted.userMessage) {
                out.push({
                    role: 'user',
                    content: { type: 'text', text: converted.userMessage },
                    meta: BACKFILL_META
                })
                seq += 1
                continue
            }
            if (converted.message) {
                const msg = converted.message
                out.push({
                    role: 'agent',
                    content: {
                        type: AGENT_MESSAGE_PAYLOAD_TYPE,
                        data: msg
                    },
                    meta: BACKFILL_META
                })
                seq += 1
            }
        }
    }

    return out.slice(0, max)
}

/**
 * Count raw transcript-line records that WOULD be considered for backfill,
 * before any per-attach cap. Lets callers detect truncation without
 * re-parsing the whole file.
 */
export function countTranscriptRecords(transcriptPath: string): number {
    return readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim()).length
}

function insertBackfillMessage(
    store: Store,
    db: Database,
    sessionId: string,
    content: HapiMessageContent,
    localId: string
): 'inserted' | 'skipped' {
    const before = getMaxSeq(db, sessionId)
    const row = store.messages.addMessage(sessionId, content, localId)
    const after = getMaxSeq(db, sessionId)
    if (after <= before) return 'skipped'
    // Historical import is not awaiting CLI ack — stamp invoked so Web does not
    // show hundreds of rows in the queued floating bar.
    markMessagesInvoked(db, sessionId, [localId], row.createdAt)
    return 'inserted'
}

export type BackfillResult = {
    inserted: number
    skipped: number
    transcriptPath: string
    total: number
    /** Raw line count of the source transcript before any per-attach cap. */
    rawTranscriptLines: number
    /** The cap actually applied this run (DEFAULT_MAX_MESSAGES or override). */
    maxMessagesApplied: number
    /** True iff rawTranscriptLines exceeded the cap and we dropped the tail. */
    truncated: boolean
}

export function backfillSessionMessages(opts: {
    dbPath: string
    sessionId: string
    agent: AgentFlavor
    chatId: string
    transcriptPath?: string
    projectHint?: string
    dryRun?: boolean
    force?: boolean
    /** Override per-attach cap (default 50_000). Also accepts HAPI_BACKFILL_MAX_MESSAGES env. */
    maxMessages?: number
}): BackfillResult {
    const transcriptPath = opts.transcriptPath ?? resolveTranscriptPath(opts.agent, opts.chatId, opts.projectHint)
    if (!transcriptPath) {
        throw new Error(`transcript not found for ${opts.agent} chat ${opts.chatId}`)
    }

    const envMax = process.env.HAPI_BACKFILL_MAX_MESSAGES
        ? parseInt(process.env.HAPI_BACKFILL_MAX_MESSAGES, 10)
        : undefined
    const maxMessagesApplied = opts.maxMessages ?? (envMax && envMax > 0 ? envMax : DEFAULT_MAX_MESSAGES)
    const rawTranscriptLines = countTranscriptRecords(transcriptPath)
    const truncated = rawTranscriptLines > maxMessagesApplied

    if (truncated) {
        console.warn(
            `warn: transcript has ${rawTranscriptLines} records, capping at ${maxMessagesApplied} (${rawTranscriptLines - maxMessagesApplied} dropped). ` +
            `Raise the cap via --max-messages or HAPI_BACKFILL_MAX_MESSAGES.`
        )
    }

    const messages = transcriptLinesToHapiMessages(opts.agent, transcriptPath, { maxMessages: maxMessagesApplied })
    if (messages.length === 0) {
        return { inserted: 0, skipped: 0, transcriptPath, total: 0, rawTranscriptLines, maxMessagesApplied, truncated }
    }

    const prevAllowNewer = process.env.HAPI_STORE_ALLOW_NEWER_SCHEMA
    process.env.HAPI_STORE_ALLOW_NEWER_SCHEMA = '1'
    const store = new Store(opts.dbPath)
    try {
        const session = store.sessions.getSession(opts.sessionId)
        if (!session) {
            throw new Error(`HAPI session not found: ${opts.sessionId}`)
        }

        const db = (store as unknown as { db: Database }).db
        const existingCount = getMaxSeq(db, opts.sessionId)
        if (existingCount > 0 && !opts.force) {
            throw new Error(`session already has ${existingCount} messages; pass --force to append backfill rows`)
        }

        if (opts.dryRun) {
            return { inserted: messages.length, skipped: 0, transcriptPath, total: messages.length, rawTranscriptLines, maxMessagesApplied, truncated }
        }

        let inserted = 0
        let skipped = 0
        for (let i = 0; i < messages.length; i += 1) {
            const localId = `backfill:${opts.agent}:${opts.chatId}:${i}`
            const result = insertBackfillMessage(store, db, opts.sessionId, messages[i]!, localId)
            if (result === 'inserted') inserted += 1
            else skipped += 1
        }

        return { inserted, skipped, transcriptPath, total: messages.length, rawTranscriptLines, maxMessagesApplied, truncated }
    } finally {
        store.close()
        if (prevAllowNewer === undefined) {
            delete process.env.HAPI_STORE_ALLOW_NEWER_SCHEMA
        } else {
            process.env.HAPI_STORE_ALLOW_NEWER_SCHEMA = prevAllowNewer
        }
    }
}

if (import.meta.main) {
    const sessionId = argValue('--session')
    const agentRaw = argValue('--agent') as AgentFlavor | undefined
    const chatId = argValue('--chat-id')
    const transcript = argValue('--transcript')
    const projectHint = argValue('--project')
    const maxMessagesRaw = argValue('--max-messages')
    const dbPath = expandHome(argValue('--db') ?? process.env.HAPI_DB ?? join(homedir(), '.hapi', 'hapi.db'))
    const dryRun = process.argv.includes('--dry-run')
    const force = process.argv.includes('--force')

    if (!sessionId || !agentRaw) usage()
    if (!['cursor', 'claude', 'codex'].includes(agentRaw)) usage()
    if (!transcript && !chatId) usage()

    const agent = agentRaw as AgentFlavor
    const resolvedChatId = chatId ?? basename(transcript!, '.jsonl')
    const maxMessages = maxMessagesRaw ? parseInt(maxMessagesRaw, 10) : undefined
    if (maxMessages !== undefined && (!Number.isFinite(maxMessages) || maxMessages <= 0)) {
        console.error(`--max-messages must be a positive integer; got ${maxMessagesRaw}`)
        process.exit(2)
    }

    const result = backfillSessionMessages({
        dbPath,
        sessionId,
        agent,
        chatId: resolvedChatId,
        transcriptPath: transcript ? expandHome(transcript) : undefined,
        projectHint: projectHint ? expandHome(projectHint) : undefined,
        dryRun,
        force,
        maxMessages
    })

    console.log(JSON.stringify({ ok: true, dryRun, ...result }, null, 2))
}
