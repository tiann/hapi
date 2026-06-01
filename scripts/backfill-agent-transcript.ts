#!/usr/bin/env bun
/**
 * Import legacy agent transcript lines into HAPI sqlite messages for a session.
 *
 * Usage:
 *   bun scripts/backfill-agent-transcript.ts --session <hapiSessionId> --agent cursor --chat-id <uuid>
 *   bun scripts/backfill-agent-transcript.ts --session <id> --transcript /path/to/file.jsonl --agent cursor
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { AGENT_MESSAGE_PAYLOAD_TYPE } from '../shared/src/modes'
import { isClaudeChatVisibleMessage } from '../shared/src/messages'
import { Store } from '../hub/src/store'
import { getMaxSeq, markMessagesInvoked } from '../hub/src/store/messages'

type AgentFlavor = 'cursor' | 'claude' | 'codex'
type HapiMessageContent = Record<string, unknown>

const BACKFILL_META = { sentFrom: 'backfill' }
const MAX_MESSAGES = 2000

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name)
    if (i >= 0) return process.argv[i + 1]
    const prefix = `${name}=`
    const hit = process.argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
}

function usage(): never {
    console.error(`Usage: bun scripts/backfill-agent-transcript.ts \\
  --session <hapiSessionId> (--agent cursor|claude|codex --chat-id <uuid> | --transcript <path>) \\
  [--db ~/.hapi/hapi.db] [--dry-run] [--force]`)
    process.exit(2)
}

function expandHome(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function findCursorTranscript(chatId: string): string | null {
    const root = join(homedir(), '.cursor', 'projects')
    if (!existsSync(root)) return null
    const needle = chatId.toLowerCase()
    for (const slug of readdirSync(root)) {
        const candidate = join(root, slug, 'agent-transcripts', chatId, `${chatId}.jsonl`)
        if (existsSync(candidate)) return candidate
        const dir = join(root, slug, 'agent-transcripts')
        if (!existsSync(dir)) continue
        for (const entry of readdirSync(dir)) {
            if (!entry.toLowerCase().startsWith(needle)) continue
            const full = join(dir, entry, `${entry}.jsonl`)
            if (existsSync(full)) return full
        }
    }
    return null
}

function findClaudeTranscript(chatId: string): string | null {
    const root = join(homedir(), '.claude', 'projects')
    if (!existsSync(root)) return null
    const needle = chatId.toLowerCase()
    for (const slug of readdirSync(root)) {
        const direct = join(root, slug, `${chatId}.jsonl`)
        if (existsSync(direct)) return direct
        const projectDir = join(root, slug)
        for (const name of readdirSync(projectDir)) {
            if (!name.endsWith('.jsonl')) continue
            const base = name.slice(0, -'.jsonl'.length)
            if (base.toLowerCase().startsWith(needle)) {
                return join(projectDir, name)
            }
        }
    }
    return null
}

function findCodexTranscript(chatId: string): string | null {
    const root = join(homedir(), '.codex', 'sessions')
    if (!existsSync(root)) return null

    function walk(dir: string): string | null {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            const st = statSync(full)
            if (st.isDirectory()) {
                const hit = walk(full)
                if (hit) return hit
                continue
            }
            if (!entry.startsWith('rollout-') || !entry.endsWith('.jsonl')) continue
            const text = readFileSync(full, 'utf8')
            const first = text.split('\n').find((l) => l.trim())
            if (!first) continue
            try {
                const row = JSON.parse(first) as { type?: string; payload?: { id?: string } }
                if (row.type === 'session_meta' && row.payload?.id === chatId) {
                    return full
                }
            } catch {
                continue
            }
        }
        return null
    }

    return walk(root)
}

export function resolveTranscriptPath(agent: AgentFlavor, chatId: string): string | null {
    if (agent === 'cursor') return findCursorTranscript(chatId)
    if (agent === 'claude') return findClaudeTranscript(chatId)
    return findCodexTranscript(chatId)
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

export function transcriptLinesToHapiMessages(agent: AgentFlavor, transcriptPath: string): HapiMessageContent[] {
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

    return out.slice(0, MAX_MESSAGES)
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

export function backfillSessionMessages(opts: {
    dbPath: string
    sessionId: string
    agent: AgentFlavor
    chatId: string
    transcriptPath?: string
    dryRun?: boolean
    force?: boolean
}): { inserted: number; skipped: number; transcriptPath: string; total: number } {
    const transcriptPath = opts.transcriptPath ?? resolveTranscriptPath(opts.agent, opts.chatId)
    if (!transcriptPath) {
        throw new Error(`transcript not found for ${opts.agent} chat ${opts.chatId}`)
    }

    const messages = transcriptLinesToHapiMessages(opts.agent, transcriptPath)
    if (messages.length === 0) {
        return { inserted: 0, skipped: 0, transcriptPath, total: 0 }
    }

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
            return { inserted: messages.length, skipped: 0, transcriptPath, total: messages.length }
        }

        let inserted = 0
        let skipped = 0
        for (let i = 0; i < messages.length; i += 1) {
            const localId = `backfill:${opts.agent}:${opts.chatId}:${i}`
            const result = insertBackfillMessage(store, db, opts.sessionId, messages[i]!, localId)
            if (result === 'inserted') inserted += 1
            else skipped += 1
        }

        return { inserted, skipped, transcriptPath, total: messages.length }
    } finally {
        store.close()
    }
}

if (import.meta.main) {
    const sessionId = argValue('--session')
    const agentRaw = argValue('--agent') as AgentFlavor | undefined
    const chatId = argValue('--chat-id')
    const transcript = argValue('--transcript')
    const dbPath = expandHome(argValue('--db') ?? process.env.HAPI_DB ?? join(homedir(), '.hapi', 'hapi.db'))
    const dryRun = process.argv.includes('--dry-run')
    const force = process.argv.includes('--force')

    if (!sessionId || !agentRaw) usage()
    if (!['cursor', 'claude', 'codex'].includes(agentRaw)) usage()
    if (!transcript && !chatId) usage()

    const agent = agentRaw as AgentFlavor
    const resolvedChatId = chatId ?? basename(transcript!, '.jsonl')

    const result = backfillSessionMessages({
        dbPath,
        sessionId,
        agent,
        chatId: resolvedChatId,
        transcriptPath: transcript ? expandHome(transcript) : undefined,
        dryRun,
        force
    })

    console.log(JSON.stringify({ ok: true, dryRun, ...result }, null, 2))
}
