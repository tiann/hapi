import { open, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { BaseSessionScanner } from "@/modules/common/session/BaseSessionScanner"
import { logger } from "@/lib"
import type { AgyTranscriptEntry } from "./agyTranscriptTypes"
import { resolveAgyTurnModels } from "./agyConversationModel"

const AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain')
const LOG_REL_PATH = join('.system_generated', 'logs', 'transcript_full.jsonl')

const MODEL_SETTLING_RETRY_DELAYS_MS = [100, 200, 300] as const

type ResolveModels = typeof resolveAgyTurnModels
type Sleep = (delayMs: number, signal?: AbortSignal) => Promise<void>

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
        const timeout = setTimeout(done, delayMs)
        signal?.addEventListener('abort', done, { once: true })
        function done() {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', done)
            resolve()
        }
    })
}

export async function emitAgyEntriesWithModels(
    entries: AgyTranscriptEntry[],
    onEntry: (entry: AgyTranscriptEntry) => void,
    brainUuid: string | null,
    options: {
        resolveModels?: ResolveModels
        retryDelaysMs?: readonly number[]
        sleep?: Sleep
        signal?: AbortSignal
    } = {},
): Promise<void> {
    const resolveModels = options.resolveModels ?? resolveAgyTurnModels
    const retryDelaysMs = options.retryDelaysMs ?? MODEL_SETTLING_RETRY_DELAYS_MS
    const sleep = options.sleep ?? abortableSleep
    const unresolvedEntries = new Map(
        entries
            .filter((entry) => entry.type === 'PLANNER_RESPONSE' && !entry.model)
            .map((entry) => [entry.step_index, entry]),
    )
    let unresolved = [...unresolvedEntries.keys()]

    for (let attempt = 0; unresolved.length > 0; attempt++) {
        const models = await resolveModels(brainUuid, unresolved)
        const stillUnresolved: number[] = []
        for (const stepIndex of unresolved) {
            const model = models.get(stepIndex)
            const entry = unresolvedEntries.get(stepIndex)
            if (model && entry) entry.model = model
            else stillUnresolved.push(stepIndex)
        }
        unresolved = stillUnresolved
        if (unresolved.length === 0 || attempt >= retryDelaysMs.length || options.signal?.aborted) break
        await sleep(retryDelaysMs[attempt], options.signal)
        if (options.signal?.aborted) break
    }

    for (const entry of entries) onEntry(entry)
}

function brainLogPath(uuid: string): string {
    return join(AGY_BRAIN_DIR, uuid, LOG_REL_PATH)
}

type CreateAgySessionScannerOpts = {
    onEntry: (entry: AgyTranscriptEntry) => void
    /**
     * When set, the scanner seeds the existing transcript as processed and
     * uses this brain UUID directly. Used on resume: the launcher knows the
     * brain UUID from the previous session and passes it here so prior turns
     * are not re-emitted.
     */
    resumeBrainUuid?: string
}

export async function createAgySessionScanner(opts: CreateAgySessionScannerOpts) {
    const scanner = new AgySessionScanner(opts)
    await scanner.start()
    return {
        cleanup: () => scanner.cleanup(),
        // Returns the known brain UUID, or null if the scanner has not been
        // told about one yet (via a resume seed or onNewSession()).
        getBrainUuid: () => scanner.getBrainUuid(),
        // Switches the scanner to a new brain UUID. This is the scanner's
        // ONLY discovery signal: it is driven by the agy PreToolUse/
        // PreInvocation hooks (via AgentSessionBase.onSessionFound ->
        // agyPtyLauncher's sessionFoundCallback), never discovered by the
        // scanner itself.
        onNewSession: (uuid: string) => scanner.onNewSession(uuid),
    }
}

class AgySessionScanner extends BaseSessionScanner<AgyTranscriptEntry> {
    private readonly onEntry: (entry: AgyTranscriptEntry) => void
    private foundBrainUuid: string | null = null
    private readonly modelSettlingAbortController = new AbortController()

    constructor(opts: CreateAgySessionScannerOpts) {
        super({ intervalMs: 5000 })
        this.onEntry = opts.onEntry
        if (opts.resumeBrainUuid) {
            this.foundBrainUuid = opts.resumeBrainUuid
            logger.debug(`[agy-scanner] resume: pre-seeded brain UUID ${opts.resumeBrainUuid}`)
        }
    }

    /** Returns the known brain UUID, or null if not yet identified. */
    getBrainUuid(): string | null {
        return this.foundBrainUuid
    }

    public override async cleanup(): Promise<void> {
        this.modelSettlingAbortController.abort()
        await super.cleanup()
    }

    /** Switch to a new brain UUID (e.g. after a re-spawn, or a hook re-firing with the same UUID). */
    onNewSession(uuid: string): void {
        // Idempotency guard: the agy PreToolUse/PreInvocation hooks can both
        // fire (and a hook can fire more than once) with the same
        // conversationId within a single turn, and each one routes here via
        // AgentSessionBase.onSessionFound -> the launcher's
        // sessionFoundCallback. Without this guard a repeat notification for
        // the UUID we already have would invalidate() and trigger an
        // unnecessary rescan.
        if (this.foundBrainUuid === uuid) return
        logger.debug(`[agy-scanner] onNewSession: switching brain to ${uuid}`)
        this.foundBrainUuid = uuid
        this.invalidate()
    }

    protected shouldScan(): boolean {
        return this.foundBrainUuid !== null
    }

    /**
     * On resume: seed the existing transcript as processed so prior turns are
     * not re-emitted by the fresh scanner instance. Mirrors how
     * ClaudeSessionScanner.initialize() seeds the JSONL transcript on claude
     * --resume to prevent the "byte-0 re-emit" bug.
     */
    protected async initialize(): Promise<void> {
        if (!this.foundBrainUuid) return
        const logPath = brainLogPath(this.foundBrainUuid)
        const { events, nextCursor } = await readBrainLog(logPath, 0)
        if (events.length > 0) {
            logger.debug(`[agy-scanner] seeding ${events.length} existing events from brain ${this.foundBrainUuid} as processed`)
            const keys = events.map((e) => generateKey(e.event))
            this.seedProcessedKeys(keys)
        }
        this.setCursor(logPath, nextCursor)
    }

    /**
     * The scanner has no discovery mechanism of its own: it only ever watches
     * a brain it has been explicitly told about (resumeBrainUuid at
     * construction, or onNewSession() later — both ultimately driven by the
     * agy PreToolUse/PreInvocation hooks). Until then it watches nothing, so
     * it never risks attaching to the wrong brain.
     */
    protected async findSessionFiles(): Promise<string[]> {
        if (this.foundBrainUuid) {
            return [brainLogPath(this.foundBrainUuid)]
        }
        return []
    }

    // Incremental byte-offset read: `cursor` is a byte offset into the
    // append-only transcript, so each scan reads only the new bytes (O(new
    // content)) instead of re-reading the whole brain log every poll. A trailing
    // partial line is left for the next scan; a shrunk file re-reads from 0.
    protected async parseSessionFile(filePath: string, cursor: number) {
        return readBrainLog(filePath, cursor)
    }

    protected generateEventKey(
        entry: AgyTranscriptEntry,
        _context: { filePath: string; lineIndex?: number },
    ): string {
        return generateKey(entry)
    }

    protected async handleFileScan(stats: {
        filePath: string
        events: AgyTranscriptEntry[]
        parsedCount: number
        newCount: number
        skippedCount: number
        cursor: number
        nextCursor: number
    }): Promise<void> {
        await emitAgyEntriesWithModels(stats.events, this.onEntry, this.foundBrainUuid, {
            signal: this.modelSettlingAbortController.signal,
        })
    }
}

//
// Helpers (module-level so initialize() and parseSessionFile() share the same logic)
//

function generateKey(entry: AgyTranscriptEntry): string {
    return `${entry.step_index}:${entry.type}`
}

// extractBodyText / extractUserRequest / normalizeUserInput below are NOT
// discovery helpers (the scanner no longer discovers brains by content —
// see the class docblock above and the removed content-match code this
// module used to carry). They are kept because agyPtyLauncher.ts's
// userRequestMatches() — a DIFFERENT concern, confirming a web-submitted
// message was echoed back into the PTY — still needs them; agy hook payloads
// carry no user-input text, so that echo check has no hook-based substitute.

// Strips a leading "@path1 @path2 ...\n\n" attachment-reference prefix (the
// exact shape formatMessageWithAttachments() produces — see
// cli/src/utils/attachmentFormatter.ts) from a session-message needle, leaving
// just the typed body text. Returns '' when the text is nothing BUT an
// attachment prefix (no body to isolate), and the original text unchanged when
// no such prefix is present (plain text-only messages).
export function extractBodyText(text: string): string {
    const separatorIndex = text.indexOf('\n\n')
    if (separatorIndex === -1) return text
    const prefix = text.slice(0, separatorIndex)
    if (!/^@\S+( @\S+)*$/.test(prefix)) return text
    return text.slice(separatorIndex + 2)
}

// Isolates the typed request from a USER_INPUT `content` field. agy wraps every
// submitted message in a <USER_REQUEST> block and appends its own sections
// (<ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>, ...), so the raw content field
// is never equal to what we sent. Returns null when the block is absent.
export function extractUserRequest(content: string): string | null {
    const open = '<USER_REQUEST>'
    const close = '</USER_REQUEST>'
    const start = content.indexOf(open)
    if (start === -1) return null
    const contentStart = start + open.length
    const end = content.indexOf(close, contentStart)
    if (end === -1) return null
    let request = content.slice(contentStart, end)
    if (request.startsWith('\n')) request = request.slice(1)
    if (request.endsWith('\n')) request = request.slice(0, -1)
    return request
}

export function normalizeUserInput(value: string): string {
    return value.replace(/\r\n/g, '\n').trim()
}

async function readBrainLog(
    filePath: string,
    cursor: number,
): Promise<{ events: { event: AgyTranscriptEntry; lineIndex?: number }[]; nextCursor: number }> {
    let size: number
    try {
        size = (await stat(filePath)).size
    } catch {
        return { events: [], nextCursor: cursor }
    }

    let from = cursor
    if (from > size) from = 0
    if (from >= size) return { events: [], nextCursor: size }

    let chunk: Buffer
    const fd = await open(filePath, 'r')
    try {
        const length = size - from
        chunk = Buffer.allocUnsafe(length)
        await fd.read(chunk, 0, length, from)
    } finally {
        await fd.close()
    }

    const lastNewline = chunk.lastIndexOf(0x0a)
    if (lastNewline === -1) return { events: [], nextCursor: from }
    const nextCursor = from + lastNewline + 1
    const text = chunk.subarray(0, lastNewline).toString('utf-8')

    const events: { event: AgyTranscriptEntry; lineIndex?: number }[] = []
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
            const entry = JSON.parse(line) as AgyTranscriptEntry & { type?: string }
            if (!entry.type || entry.type === 'CONVERSATION_HISTORY') continue
            events.push({ event: entry as AgyTranscriptEntry })
        } catch {
            continue
        }
    }

    return { events, nextCursor }
}
