import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { DshLocalSessionSummary, DshLocalSessionWithMessages } from '@hapi/protocol/apiTypes'

/**
 * Durable DSH session reader (disk side of the local-session import).
 *
 * DSH persists every session as `~/.dsh/sessions/<projectKey>/<id>/
 * session.v4.jsonl.zstd` — a concatenation of independent zstd frames (one
 * header frame, then one frame per append batch) — plus a projection cache
 * at `~/.dsh/storages/session_projcache/sessions/<id>.json` that folds the
 * interesting state (title, first prompt, turn boundaries, model selection).
 * ACP `session/list` exposes none of that (only {sessionId, cwd}, subagents
 * hidden, createdAt computed then dropped), so the import list is built
 * straight from disk:
 *
 * - summaries: an 8KB read of the log's first frame (the header row, cut by
 *   length and decoded on its own) plus the projection cache;
 * - transcripts: a full decode folded into the CodexMessage payload shapes
 *   the web already renders for live DSH sessions.
 *
 * Everything is read-only: the log is append-only under flock and must never
 * be written from outside. Shapes below were taken from real 0.2.2-rc.1 logs
 * (`turn/end.data.reason` is an OBJECT, tool results are re-emitted with
 * pruned content after every compaction, assistant messages carry several
 * reasoning/text blocks on one seq).
 */

/** DSH resolves its home from `$DSH_HOME`, then `~/.dsh` (same rule as the
 * skill roots in modules/common/skills.ts). */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const override = env.DSH_HOME?.trim()
    if (override) return override
    return join(home, '.dsh')
}

/** Only the first 8KB of a log are read for the header frame (real header
 * frames compress to ~230 bytes). */
const HEADER_READ_BYTES = 8192
const HEADER_READ_MAX_BYTES = 65536

/**
 * Transcript bounds. The runner answers one socket.io frame per request and
 * the hub caps a frame at 48MB (`SOCKET_MAX_HTTP_BUFFER_SIZE`), so a folded
 * transcript must stay well under that on its own:
 * - logs above `MAX_TRANSCRIPT_COMPRESSED_BYTES` are never decoded (folded
 *   JSON tracks compressed size closely on real data);
 * - folding stops once the approximate size or row budget is blown.
 * Oversized sessions stay listable but import with `transcript_too_large`
 * instead of killing the runner's machine socket.
 */
export const MAX_TRANSCRIPT_COMPRESSED_BYTES = 16 * 1024 * 1024
const MAX_TRANSCRIPT_JSON_BYTES = 24 * 1024 * 1024
const MAX_FOLDED_CHARS = 12 * 1024 * 1024
const MAX_FOLDED_MESSAGES = 60_000

/** Preview length for list rows and the imported summary (Pi uses 140). */
const PREVIEW_CHARS = 140

type DshSessionHeader = {
    id: string
    createdAt?: number
    cwd?: string
    origin?: string
    version?: number
}

type ProjcacheRow = { val?: unknown }

type DshProjcache = {
    record?: { rows?: Record<string, ProjcacheRow> }
}

type DshLogEvent = { type: string; seq?: number; time?: number; data?: unknown }

/** Folded transcript row — the agent/user payload shapes `convertAgentMessage`
 * produces for the live stream, wrapped the way the other importers do. */
export type DshFoldedMessage = DshLocalSessionWithMessages['messages'][number]

export type DshTranscriptError = NonNullable<DshLocalSessionSummary['importError']>

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function truncatePreview(text: string): string {
    const singleLine = text.replace(/\s+/g, ' ').trim()
    return singleLine.length > PREVIEW_CHARS ? `${singleLine.slice(0, PREVIEW_CHARS)}…` : singleLine
}

// ---------------------------------------------------------------------------
// zstd decoding
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 0xfd2fb528

function isBunRuntime(): boolean {
    return typeof Bun !== 'undefined' && typeof Bun.zstdDecompressSync === 'function'
}

/**
 * Byte length of the zstd frame that starts at `raw[0]` (RFC 8878), or null
 * when the buffer is too short for the frame's headers or does not start with
 * a frame this reader can walk. The length may exceed the buffer: the frame
 * is then truncated.
 *
 * Frames are cut by length rather than left to a decoder together with
 * whatever follows them: what a decoder makes of a torn frame behind a
 * complete one differs between runtimes (node:zlib returns the first frame on
 * one Node version and throws on another), and a magic byte sequence inside a
 * compressed payload would fool a byte scan.
 */
export function firstZstdFrameLength(raw: Buffer): number | null {
    if (raw.length < 5 || raw.readUInt32LE(0) !== ZSTD_MAGIC) return null
    const descriptor = raw[4]!
    if ((descriptor & 0x08) !== 0) return null // reserved bit: not a conformant frame
    const singleSegment = (descriptor & 0x20) !== 0
    const contentSizeFlag = descriptor >> 6
    const dictionaryIdFlag = descriptor & 0x03
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0)
        : contentSizeFlag === 1 ? 2
        : contentSizeFlag === 2 ? 4
        : 8
    const dictionaryIdBytes = dictionaryIdFlag === 0 ? 0 : dictionaryIdFlag === 1 ? 1 : dictionaryIdFlag === 2 ? 2 : 4
    let at = 5 + (singleSegment ? 0 : 1) + dictionaryIdBytes + contentSizeBytes
    for (;;) {
        // Block header: last-block flag, block type, then a 21-bit size. A
        // run-length block stores one byte whatever its size says.
        if (at + 3 > raw.length) return null
        const blockHeader = raw[at]! | (raw[at + 1]! << 8) | (raw[at + 2]! << 16)
        const lastBlock = (blockHeader & 1) === 1
        const blockType = (blockHeader >> 1) & 0x03
        if (blockType === 3) return null // reserved
        at += 3 + (blockType === 1 ? 1 : blockHeader >> 3)
        if (lastBlock) break
    }
    return at + ((descriptor & 0x04) !== 0 ? 4 : 0)
}

/** Decode the frames of `raw` one by one on node:zlib, each cut by length.
 * Stops before the first frame that is not wholly present. */
function decodeFramesByLength(raw: Buffer): { parts: Buffer[]; decodedBytes: number } {
    const parts: Buffer[] = []
    let offset = 0
    while (offset < raw.length) {
        const length = firstZstdFrameLength(raw.subarray(offset))
        if (length === null || length > raw.length - offset) break
        parts.push(zstdDecompressSync(raw.subarray(offset, offset + length)))
        offset += length
    }
    return { parts, decodedBytes: offset }
}

/**
 * Decode one multi-frame zstd buffer.
 *
 * Bun (the shipped runtime) decodes every frame in one call. node:zlib — what
 * vitest runs on — is given one frame per call instead, and a frame that is
 * not wholly present (a torn tail) is an error.
 */
export function decodeZstdFrames(raw: Buffer): Buffer {
    if (isBunRuntime()) {
        return Bun.zstdDecompressSync(raw)
    }
    const { parts, decodedBytes } = decodeFramesByLength(raw)
    if (decodedBytes !== raw.length) throw new Error('zstd frame is truncated or not a frame start')
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
}

/**
 * Decode a log to text, tolerating a torn TAIL frame. DSH appends one frame
 * per batch with a single write + fsync and repairs a torn tail before its
 * next append (`truncateTornTail`); a reader that races a crash can still see
 * one. The complete frames are kept and the torn tail dropped.
 */
export function decodeZstdFramesTolerant(raw: Buffer): Buffer {
    try {
        return decodeZstdFrames(raw)
    } catch (error) {
        const { parts } = decodeFramesByLength(raw)
        if (parts.length === 0) throw error
        return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** Read the log's first frame (the header row). It is tiny (~230 bytes
 * compressed on real logs), so 8KB are read and exactly that one frame is
 * decoded: whatever follows it in the window, complete or torn, never reaches
 * the decoder. The read only grows when the header frame itself is larger. */
function readSessionHeader(path: string, compressed: boolean): DshSessionHeader | null {
    let handle: number | null = null
    try {
        const size = statSync(path).size
        handle = openSync(path, 'r')
        let readBytes = Math.min(HEADER_READ_BYTES, size)
        while (readBytes > 0) {
            const buffer = Buffer.allocUnsafe(readBytes)
            const read = readSync(handle, buffer, 0, readBytes, 0)
            if (read <= 0) return null
            const slice = buffer.subarray(0, read)
            let frame: Buffer = slice
            if (compressed) {
                const frameLength = firstZstdFrameLength(slice)
                if (frameLength === null) return null
                if (frameLength > read) {
                    if (read < size && readBytes < HEADER_READ_MAX_BYTES) {
                        readBytes = Math.min(HEADER_READ_MAX_BYTES, size)
                        continue
                    }
                    // The header frame itself is torn: nothing to list.
                    return null
                }
                frame = slice.subarray(0, frameLength)
            }
            const text = (compressed ? zstdDecompressSync(frame) : frame).toString('utf8')
            const newline = text.indexOf('\n')
            // A plain log carries more than the header line in the window.
            if (!compressed && newline < 0 && read < size && readBytes < HEADER_READ_MAX_BYTES) {
                readBytes = Math.min(HEADER_READ_MAX_BYTES, size)
                continue
            }
            const firstLine = newline >= 0 ? text.slice(0, newline) : text
            const parsed = asRecord(JSON.parse(firstLine))
            if (!parsed || parsed.type !== 'session') return null
            const id = asString(parsed.id)
            if (!id) return null
            return {
                id,
                ...(typeof parsed.createdAt === 'number' ? { createdAt: parsed.createdAt } : {}),
                ...(asString(parsed.cwd) ? { cwd: parsed.cwd as string } : {}),
                ...(asString(parsed.origin) ? { origin: parsed.origin as string } : {})
            }
        }
        return null
    } catch {
        return null
    } finally {
        if (handle !== null) closeSync(handle)
    }
}

function readProjcache(path: string): DshProjcache | null {
    try {
        return asRecord(JSON.parse(readFileSync(path, 'utf8'))) as DshProjcache | null
    } catch {
        return null
    }
}

function rowVal(cache: DshProjcache | null, key: string): unknown {
    return cache?.record?.rows?.[key]?.val
}

/** The opaque ACP model value the dsh model rail sends back verbatim is a
 * JSON `[provider, model]` tuple; expose the readable model id as well. */
function launchModel(cache: DshProjcache | null): { model: string; modelId: string | null } | null {
    const lastUsed = asRecord(asRecord(rowVal(cache, 'modelSelection'))?.lastUsed)
    const provider = asString(lastUsed?.provider)
    const model = asString(lastUsed?.model)
    if (!provider || !model) return null
    return { model: JSON.stringify([provider, model]), modelId: model }
}

/**
 * Scan the DSH home for durable ROOT sessions.
 *
 * Excluded: subagent sessions (ACP `session/list` and `session/resume` both
 * refuse `origin === "subagent"`), sessions without an absolute cwd, other
 * log generations, and BLANK sessions — ones that never started a turn. DSH
 * itself marks a session blank until its first `turn/start`; such a log
 * holds no conversation to import.
 */
export function listDshSessionSummaries(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): DshLocalSessionSummary[] {
    const dshHome = resolveDshHome(env, home)
    const sessionsRoot = join(dshHome, 'sessions')
    const cacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions')
    const summaries: DshLocalSessionSummary[] = []
    let projects: string[]
    try {
        projects = readdirSync(sessionsRoot)
    } catch {
        return summaries
    }
    for (const project of projects) {
        const projectDir = join(sessionsRoot, project)
        let segments: string[]
        try {
            if (!statSync(projectDir).isDirectory()) continue
            segments = readdirSync(projectDir)
        } catch {
            continue
        }
        for (const segment of segments) {
            // DSH defaults to zstd; a profile may configure plain JSONL.
            const zstdPath = join(projectDir, segment, 'session.v4.jsonl.zstd')
            const plainPath = join(projectDir, segment, 'session.v4.jsonl')
            let logPath = zstdPath
            let compressed = true
            try {
                statSync(zstdPath)
            } catch {
                try {
                    statSync(plainPath)
                } catch {
                    continue
                }
                logPath = plainPath
                compressed = false
            }
            const header = readSessionHeader(logPath, compressed)
            if (!header) continue
            if (header.origin === 'subagent') continue
            const cwd = header.cwd ?? null
            if (!cwd || !isAbsolute(cwd)) continue

            const cache = readProjcache(join(cacheRoot, `${header.id}.json`))
            const firstPrompt = asString(asRecord(asRecord(rowVal(cache, 'titleInput'))?.first)?.text)
            const title = asString(rowVal(cache, 'title')) ?? (firstPrompt ? truncatePreview(firstPrompt) : '')
            const turnBoundary = asRecord(rowVal(cache, 'turnBoundary'))
            const turns = typeof turnBoundary?.lastTurn === 'number' ? turnBoundary.lastTurn : null
            // Blank = no turn ever started (a blank probe session carries
            // `lastTurn: 0`) AND no operator prompt was ever recorded — a
            // missing cache row alone does not make a session blank.
            const startedTurn = turns !== null && turns >= 1
            if (!startedTurn && !firstPrompt && !asString(rowVal(cache, 'title'))) continue

            let modifiedAt = header.createdAt ?? 0
            try {
                modifiedAt = statSync(logPath).mtimeMs
            } catch {
                // createdAt fallback already in place
            }
            const launch = launchModel(cache)
            summaries.push({
                id: header.id,
                title,
                ...(firstPrompt ? { lastUserMessage: truncatePreview(firstPrompt) } : {}),
                cwd,
                file: logPath,
                modifiedAt,
                ...(launch ? { model: launch.model } : {}),
                extra: {
                    turns,
                    model: launch?.modelId ?? null
                }
            })
        }
    }
    summaries.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return summaries
}

// ---------------------------------------------------------------------------
// Transcript folding
// ---------------------------------------------------------------------------

const FOLDABLE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'])

/**
 * Imported rows are identified by `<flavor>:<nativeId>:` + a position, which
 * is the prefix the hub importer uses to find its own rows again on a
 * re-import. One event folds to one or more rows; every row of an event after
 * the first carries its block index.
 */
function localId(nativeId: string, event: DshLogEvent, index: number, fallback: { seq: number }): string {
    const position = typeof event.seq === 'number' ? String(event.seq) : `x${fallback.seq}`
    return index === 0 ? `dsh:${nativeId}:${position}` : `dsh:${nativeId}:${position}:${index}`
}

function agentContent(data: unknown, meta: { sentFrom: 'cli' }) {
    return { role: 'agent' as const, content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data }, meta }
}

function textOfBlocks(blocks: unknown, imagePlaceholder: string): { text: string; images: number } {
    const parts: string[] = []
    let images = 0
    if (!Array.isArray(blocks)) return { text: '', images }
    for (const block of blocks) {
        const record = asRecord(block)
        if (!record) continue
        if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
            parts.push(record.text)
        } else if (record.type === 'image') {
            images += 1
            parts.push(imagePlaceholder)
        }
    }
    return { text: parts.join(''), images }
}

class TranscriptFold {
    private readonly messages: DshFoldedMessage[] = []
    private chars = 0
    private fallbackSeq = 0
    private lastUserMessage: string | null = null
    /** callIds of folded tool calls that have no result yet. */
    private readonly openCalls = new Set<string>()
    /** tool results are re-emitted with pruned content after every
     * compaction; only the first (original, complete) one is folded. */
    private readonly resultsSeen = new Set<string>()
    exceeded = false

    constructor(
        private readonly nativeId: string,
        private readonly limits: { maxChars: number; maxMessages: number }
    ) {}

    push(event: DshLogEvent): void {
        if (this.exceeded || !FOLDABLE_EVENT_TYPES.has(event.type)) return
        const data = asRecord(event.data)
        switch (event.type) {
            case 'user/message': {
                // Only operator turns. DSH logs injected context under the
                // same event (runtime-context, skill-catalog, agent-instructions,
                // tool-jobs, relays from other agents, …) with other source kinds.
                if (asRecord(data?.source)?.kind !== 'user') break
                const { text, images } = textOfBlocks(data?.content, '[image]')
                if (!text.trim() && images === 0) break
                this.lastUserMessage = text
                this.add(event, 0, text.length, { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } })
                break
            }
            case 'assistant/message': {
                const message = asRecord(data?.message)
                const blocks = message?.content
                if (!Array.isArray(blocks)) break
                let index = 0
                for (const block of blocks) {
                    const record = asRecord(block)
                    const text = typeof record?.text === 'string' ? record.text : ''
                    if (text.length === 0) continue
                    if (record?.type === 'reasoning') {
                        this.add(event, index, text.length, agentContent({ type: 'reasoning', message: text, id: `dsh-r:${this.nativeId}:${event.seq ?? index}` }, { sentFrom: 'cli' }))
                    } else if (record?.type === 'text') {
                        this.add(event, index, text.length, agentContent({ type: 'message', message: text, id: asString(message?.id) ?? `dsh-m:${this.nativeId}:${event.seq ?? index}` }, { sentFrom: 'cli' }))
                    } else {
                        // tool-call blocks are folded from their tool/call events
                        continue
                    }
                    index += 1
                }
                break
            }
            case 'tool/call': {
                const callId = asString(data?.callId)
                const name = asString(data?.name)
                if (!callId || !name) break
                let input: unknown = data?.arguments
                if (typeof input === 'string') {
                    try { input = JSON.parse(input) } catch { /* opaque model output kept as text */ }
                }
                this.openCalls.add(callId)
                this.add(event, 0, name.length + (typeof input === 'string' ? input.length : 64), agentContent({ type: 'tool-call', name, callId, input, status: 'in_progress' }, { sentFrom: 'cli' }))
                break
            }
            case 'tool/result': {
                const result = asRecord(data?.message)
                const callId = asString(result?.toolCallId)
                if (!callId || this.resultsSeen.has(callId)) break
                this.resultsSeen.add(callId)
                this.openCalls.delete(callId)
                const { text } = textOfBlocks(result?.content, '[image]')
                this.add(event, 0, text.length, agentContent({ type: 'tool-call-result', callId, output: text, is_error: result?.isError === true }, { sentFrom: 'cli' }))
                break
            }
            case 'turn/end': {
                // `data.reason` is an object: { kind, error?: { message, code, status? }, reason? }.
                const reason = asRecord(data?.reason)
                const kind = asString(reason?.kind)
                if (!kind || kind === 'completed' || kind === 'aborted') break
                const failure = asRecord(reason?.error)
                const detail = [asString(failure?.code), asString(failure?.message)].filter(Boolean).join(': ')
                this.add(event, 0, kind.length + detail.length, agentContent({ type: 'error', message: detail ? `Turn ended (${kind}): ${detail}` : `Turn ended (${kind})` }, { sentFrom: 'cli' }))
                break
            }
            default:
                break
        }
    }

    private add(event: DshLogEvent, index: number, textLength: number, content: DshFoldedMessage['content']): void {
        this.chars += textLength + 192
        if (this.chars > this.limits.maxChars || this.messages.length >= this.limits.maxMessages) {
            this.exceeded = true
            return
        }
        this.fallbackSeq += 1
        const createdAt = typeof event.time === 'number' ? event.time : undefined
        this.messages.push({
            localId: localId(this.nativeId, event, index, { seq: this.fallbackSeq }),
            ...(createdAt !== undefined ? { createdAt } : {}),
            content
        })
    }

    /** Close tool calls that never got a result (the turn was aborted or
     * failed mid-tool) with a synthetic failed result right after the call,
     * so no imported card spins forever. */
    finalize(): { messages: DshFoldedMessage[]; lastUserMessage: string | null; exceeded: boolean } {
        if (this.exceeded || this.openCalls.size === 0) {
            return { messages: this.messages, lastUserMessage: this.lastUserMessage, exceeded: this.exceeded }
        }
        const output: DshFoldedMessage[] = []
        for (const message of this.messages) {
            output.push(message)
            const data = (message.content as { content?: { data?: { type?: string; callId?: string } } }).content?.data
            if (data?.type !== 'tool-call' || !data.callId || !this.openCalls.has(data.callId)) continue
            output.push({
                localId: `${message.localId}:aborted`,
                ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
                content: agentContent({ type: 'tool-call-result', callId: data.callId, output: 'Tool call did not complete: the turn ended before a result was recorded.', is_error: true }, { sentFrom: 'cli' })
            })
        }
        return { messages: output, lastUserMessage: this.lastUserMessage, exceeded: false }
    }
}

const DEFAULT_FOLD_LIMITS = { maxChars: MAX_FOLDED_CHARS, maxMessages: MAX_FOLDED_MESSAGES }

/** The event type of one log line, read without a JSON parse (every log line
 * starts with `{"type":"<kind>"`). Lines of other kinds — the large majority
 * (step/start, request/header, job/*, …) — are never parsed. */
function lineEventType(text: string, start: number, end: number): string | null {
    const head = text.slice(start, Math.min(end, start + 96))
    const open = head.indexOf('"type":"')
    if (open < 0) {
        // Not near the start: either not an event line or an unusual key
        // order. Only a line that mentions a foldable type anywhere is worth
        // parsing, so a cheap containment check guards the JSON.parse.
        for (const type of FOLDABLE_EVENT_TYPES) {
            const at = text.indexOf(`"type":"${type}"`, start)
            if (at >= 0 && at < end) return type
        }
        return null
    }
    const close = head.indexOf('"', open + 8)
    return close < 0 ? null : head.slice(open + 8, close)
}

/** Fold decoded log text. Yields to the event loop between chunks so a large
 * transcript never blocks the runner (it serves live sessions) for long. */
export async function foldDshLogText(text: string, nativeId: string, limits = DEFAULT_FOLD_LIMITS): Promise<ReturnType<TranscriptFold['finalize']>> {
    const fold = new TranscriptFold(nativeId, limits)
    let start = 0
    let lines = 0
    while (start < text.length) {
        let end = text.indexOf('\n', start)
        if (end < 0) end = text.length
        if (end > start && !fold.exceeded) {
            const type = lineEventType(text, start, end)
            if (type && FOLDABLE_EVENT_TYPES.has(type)) {
                try {
                    fold.push(JSON.parse(text.slice(start, end)) as DshLogEvent)
                } catch {
                    // a torn tail line is dropped; the rest of the log stands
                }
            }
        }
        start = end + 1
        lines += 1
        if ((lines & 4095) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    return fold.finalize()
}

/** Sync fold of already-parsed events (tests and small inputs). */
export function foldDshLogEvents(events: DshLogEvent[], nativeId: string, limits = DEFAULT_FOLD_LIMITS): DshFoldedMessage[] {
    const fold = new TranscriptFold(nativeId, limits)
    for (const event of events) fold.push(event)
    return fold.finalize().messages
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

function readLogText(path: string, compressed: boolean): string {
    const raw = readFileSync(path)
    return (compressed ? decodeZstdFramesTolerant(raw) : raw).toString('utf8')
}

type DshTranscriptResult =
    | { kind: 'transcript'; transcript: DshLocalSessionWithMessages }
    | { kind: 'error'; error: DshTranscriptError }

async function readTranscript(summary: DshLocalSessionSummary): Promise<DshTranscriptResult> {
    const tooLarge = (detail: string): DshTranscriptResult => ({
        kind: 'error',
        error: { code: 'transcript_too_large', message: `DSH session is too large to import (${detail}).` }
    })
    const compressed = summary.file.endsWith('.zstd')
    let size: number
    try {
        size = statSync(summary.file).size
    } catch {
        return { kind: 'error', error: { code: 'not_found', message: 'DSH session log is no longer readable.' } }
    }
    // Folded JSON tracks the compressed size closely on real logs; refuse
    // before decoding so an oversized log never enters memory at all.
    if (size > MAX_TRANSCRIPT_COMPRESSED_BYTES) {
        return tooLarge(`${(size / 1048576).toFixed(1)}MB compressed log`)
    }
    let text: string
    try {
        text = readLogText(summary.file, compressed)
    } catch (error) {
        return { kind: 'error', error: { code: 'transcript_unreadable', message: `DSH session log could not be decoded: ${error instanceof Error ? error.message : String(error)}` } }
    }
    const folded = await foldDshLogText(text, summary.id)
    if (folded.exceeded) return tooLarge('more messages than one import can carry')
    const jsonBytes = Buffer.byteLength(JSON.stringify(folded.messages))
    if (jsonBytes > MAX_TRANSCRIPT_JSON_BYTES) return tooLarge(`${(jsonBytes / 1048576).toFixed(1)}MB of messages`)
    return {
        kind: 'transcript',
        transcript: {
            ...summary,
            // The list preview is the FIRST prompt (all the cache knows);
            // the imported summary uses the last user turn like every other flavor.
            ...(folded.lastUserMessage ? { lastUserMessage: truncatePreview(folded.lastUserMessage) } : {}),
            messages: folded.messages
        }
    }
}

/**
 * Full transcript read for import: one session at a time, each bounded by
 * size, each reported on its own. A session that cannot be imported (too
 * large, unreadable) comes back as its SUMMARY carrying `importError` — no
 * `messages` key at all, so the hub cannot mistake it for an empty
 * transcript — instead of failing the batch; the hub turns it into that
 * session's own result.
 */
export async function readDshSessionTranscriptsByIds(
    ids: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): Promise<Array<DshLocalSessionWithMessages | DshLocalSessionSummary>> {
    const wanted = new Set(ids)
    const summaries = listDshSessionSummaries(env, home).filter((session) => wanted.has(session.id))
    const items: Array<DshLocalSessionWithMessages | DshLocalSessionSummary> = []
    for (const summary of summaries) {
        const result = await readTranscript(summary)
        items.push(result.kind === 'transcript' ? result.transcript : { ...summary, importError: result.error })
    }
    return items
}
