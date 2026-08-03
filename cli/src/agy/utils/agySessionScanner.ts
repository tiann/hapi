import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { BaseSessionScanner } from "@/modules/common/session/BaseSessionScanner"
import { logger } from "@/lib"
import type { AgyTranscriptEntry } from "./agyTranscriptTypes"
import { resolveAgyTurnModels } from "./agyConversationModel"

const AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain')
const LOG_REL_PATH = join('.system_generated', 'logs', 'transcript_full.jsonl')

// Discovery-phase scan window: every brain dir whose mtime falls within this
// many ms of "now" (relative to when THIS scanner was constructed) is a
// candidate. Replaces a stale "newest N by mtime" cap that a background
// service spawning short-lived `agy --print` calls (238 brain dirs in 5h
// observed on one machine) could push a real session's brain out of within
// seconds, permanently blanking the chat. Our own brain cannot predate the
// scanner (it's minted by the very `agy` process this scanner was created to
// watch), so "recent enough" is a correct and self-bounding filter, and the
// window is the only bound: an unusually large candidate set is logged, never
// truncated (see SCAN_CANDIDATE_WARN_THRESHOLD).
//
// 30s covers: (a) clock/mtime granularity across filesystems, (b) the
// spawn -> first-write-to-brain-dir delay observed for agy startup.
const DISCOVERY_WINDOW_SLACK_MS = 30_000

// Observability only — never a cap. Our brain is minted right after the
// scanner starts, so every brain that churn creates afterwards is NEWER than
// ours: dropping the "oldest" candidates would discard precisely the brain we
// are looking for (that is the newest-3 bug, relocated). Dropping the newest
// instead is no safer, because unrelated brains can also be minted inside the
// slack window before ours. So the window is the only bound; an unusually
// large candidate set is logged, not truncated. Cost stays bounded by the
// prefix read below and by the early exit on the first match.
const SCAN_CANDIDATE_WARN_THRESHOLD = 50
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

// Bounded prefix read for discovery-phase content matching: the first user
// message lives near the top of the transcript, so we never need to read a
// whole (potentially 1MB+) transcript file on every poll just to check for a
// match.
const CONTENT_MATCH_PREFIX_BYTES = 64 * 1024

function brainLogPath(uuid: string): string {
    return join(AGY_BRAIN_DIR, uuid, LOG_REL_PATH)
}

async function listBrainUuids(): Promise<Set<string>> {
    try {
        const entries = await readdir(AGY_BRAIN_DIR, { withFileTypes: true })
        return new Set(entries
            .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name))
            .map((entry) => entry.name))
    } catch {
        return new Set()
    }
}

type CreateAgySessionScannerOpts = {
    onEntry: (entry: AgyTranscriptEntry) => void
    /**
     * When set, the scanner skips the content-match discovery phase and uses
     * this brain UUID directly. Used on resume: the launcher knows the brain
     * UUID from the previous session and passes it here so the scanner seeds
     * the existing transcript as processed (preventing re-emission of prior
     * turns) without waiting for a new user message to trigger content-match.
     */
    resumeBrainUuid?: string
    /**
     * Called exactly once when the brain UUID is first identified via content-
     * match (new-session path only — NOT called when resumeBrainUuid is pre-
     * seeded, because that UUID is already known to the caller).
     * Lets the launcher persist the UUID to session metadata immediately upon
     * discovery rather than relying on the onMessage PTY polling path.
     */
    onBrainFound?: (uuid: string) => void
    /** Called once when discovery cannot safely choose among exact matches. */
    onDiscoveryAmbiguous?: (matchCount: number) => void
}

export async function createAgySessionScanner(opts: CreateAgySessionScannerOpts) {
    const preexistingBrainUuids = await listBrainUuids()
    const scanner = new AgySessionScanner(opts, preexistingBrainUuids)
    await scanner.start()
    return {
        cleanup: () => scanner.cleanup(),
        setSessionMessageText: (text: string) => scanner.setSessionMessageText(text),
        // Returns the matched/known brain UUID, or null if not yet identified.
        getBrainUuid: () => scanner.getBrainUuid(),
        // Switches the scanner to a new brain UUID (used after a re-spawn where
        // agy starts a fresh conversation but we still track the PTY session).
        onNewSession: (uuid: string) => scanner.onNewSession(uuid),
    }
}

class AgySessionScanner extends BaseSessionScanner<AgyTranscriptEntry> {
    private readonly onEntry: (entry: AgyTranscriptEntry) => void
    private readonly onBrainFoundCallback: ((uuid: string) => void) | undefined
    private readonly onDiscoveryAmbiguousCallback: ((matchCount: number) => void) | undefined
    // Recorded at construction time — the scanner is created right as the
    // launcher is about to start agy, so our real brain dir cannot predate
    // this. Anchors the discovery scan window (see DISCOVERY_WINDOW_SLACK_MS).
    private readonly scannerStartMs: number
    private readonly preexistingBrainUuids: ReadonlySet<string>
    private sessionMessageText: string | null = null
    private sessionMessageSubmittedAtMs: number | null = null
    private foundBrainUuid: string | null = null
    private ambiguityReported = false
    private readonly modelSettlingAbortController = new AbortController()

    constructor(opts: CreateAgySessionScannerOpts, preexistingBrainUuids: ReadonlySet<string>) {
        super({ intervalMs: 5000 })
        this.scannerStartMs = Date.now()
        this.preexistingBrainUuids = preexistingBrainUuids
        this.onEntry = opts.onEntry
        this.onBrainFoundCallback = opts.onBrainFound
        this.onDiscoveryAmbiguousCallback = opts.onDiscoveryAmbiguous
        if (opts.resumeBrainUuid) {
            this.foundBrainUuid = opts.resumeBrainUuid
            logger.debug(`[agy-scanner] resume: pre-seeded brain UUID ${opts.resumeBrainUuid}`)
        }
    }

    /** Returns the matched/known brain UUID, or null if not yet identified. */
    getBrainUuid(): string | null {
        return this.foundBrainUuid
    }

    public override async cleanup(): Promise<void> {
        this.modelSettlingAbortController.abort()
        await super.cleanup()
    }

    /** Switch to a new brain UUID (e.g. after a re-spawn). */
    onNewSession(uuid: string): void {
        // Idempotency guard: the launcher's onBrainFound callback calls
        // session.onSessionFound(uuid), which (via the sessionFoundCallbacks
        // registry) calls back into this same scanner's onNewSession(uuid) with
        // the UUID we just set ourselves — a self-loop. Without this guard that
        // loop would invalidate() and trigger an unnecessary rescan every time
        // content-match discovers a brain.
        if (this.foundBrainUuid === uuid) return
        logger.debug(`[agy-scanner] onNewSession: switching brain to ${uuid}`)
        this.foundBrainUuid = uuid
        this.invalidate()
    }

    setSessionMessageText(text: string): void {
        if (this.sessionMessageSubmittedAtMs === null) {
            // Called immediately before the PTY writes CR. The matching AGY
            // USER_INPUT must therefore be created at or after this boundary.
            this.sessionMessageSubmittedAtMs = Date.now()
        }
        this.sessionMessageText = text
        this.invalidate()
    }

    protected shouldScan(): boolean {
        return this.sessionMessageText !== null || this.foundBrainUuid !== null
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

    protected async findSessionFiles(): Promise<string[]> {
        if (this.foundBrainUuid) {
            return [brainLogPath(this.foundBrainUuid)]
        }

        let uuids: string[]
        try {
            const entries = await readdir(AGY_BRAIN_DIR, { withFileTypes: true })
            uuids = entries
                .filter((e) => e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name))
                .map((e) => e.name)
        } catch {
            return []
        }

        const withMtime = await Promise.all(
            uuids.map(async (uuid) => {
                try {
                    const s = await stat(join(AGY_BRAIN_DIR, uuid))
                    return { uuid, mtime: s.mtimeMs }
                } catch {
                    return null
                }
            })
        )

        const windowStartMs = this.scannerStartMs - DISCOVERY_WINDOW_SLACK_MS
        const candidates = withMtime
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .filter((e) => e.mtime >= windowStartMs)
            .filter((e) => !this.preexistingBrainUuids.has(e.uuid))
            // Newest-first: the likely match (our own, just-written brain) is
            // tried first. Ordering is a heuristic for speed only — every
            // candidate in the window is scanned until one matches.
            .sort((a, b) => b.mtime - a.mtime)

        if (candidates.length > SCAN_CANDIDATE_WARN_THRESHOLD) {
            logger.warn(
                `[agy-scanner] scan window has ${candidates.length} candidate brains (above ${SCAN_CANDIDATE_WARN_THRESHOLD}) — scanning all of them; unusual brain-dir churn?`
            )
        }

        const text = this.sessionMessageText
        const bodyNeedle = text ? extractBodyText(text) : null
        const matches: Array<{ uuid: string; logPath: string }> = []
        for (const { uuid } of candidates) {
            const logPath = brainLogPath(uuid)
            if (text) {
                try {
                    if (await brainTranscriptMatches(logPath, text, bodyNeedle, this.sessionMessageSubmittedAtMs)) {
                        logger.debug(`[agy-scanner] matched brain ${uuid} via content`)
                        matches.push({ uuid, logPath })
                    }
                } catch {
                    continue
                }
            }
        }

        if (matches.length === 1) {
            const [{ uuid, logPath }] = matches
            this.foundBrainUuid = uuid
            // Notify the caller immediately so it can persist the UUID to
            // session metadata without waiting for onMessage polling.
            this.onBrainFoundCallback?.(uuid)
            logger.debug(`[agy-scanner] found brain ${uuid}, watching 1 file`)
            return [logPath]
        }
        if (matches.length > 1) {
            logger.warn(`[agy-scanner] ${matches.length} brains matched the first message exactly; refusing ambiguous attachment`)
            if (!this.ambiguityReported) {
                this.ambiguityReported = true
                this.onDiscoveryAmbiguousCallback?.(matches.length)
            }
        }
        // Brain not yet identified — do NOT fall back to watching all candidates.
        // Emitting from unmatched brains leaks another session's transcript into
        // this chat (the raw-JSON noise). Watch nothing until the session message
        // text appears in exactly one brain's transcript on a later scan.
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

// Discovery-phase content match: does this brain's transcript contain our
// session's first message? Reads only a bounded prefix (the first user
// message is near the top) and matches against the DECODED content field of
// USER_INPUT entries — never raw file text. Two reasons:
//  1. Raw-file substring matching compares JSON-escaped bytes (a real
//     newline in the needle vs. the literal two-char "\n" escape on disk) and
//     never matches a multi-line first message.
//  2. Restricting to USER_INPUT (our own message, echoed back by agy) avoids
//     false positives from the needle text coincidentally appearing inside a
//     tool result or the model's own response.
async function brainTranscriptMatches(
    logPath: string,
    text: string,
    bodyNeedle: string | null,
    submittedAtMs: number | null,
): Promise<boolean> {
    const prefix = await readTranscriptPrefix(logPath, CONTENT_MATCH_PREFIX_BYTES)
    if (matchesUserInput(prefix.entries, text, bodyNeedle, submittedAtMs)) return true

    // The first USER_INPUT sits at offset 0, so a first message longer than the
    // prefix window leaves no complete line to parse. Giving up here would
    // blank the chat permanently (and silently) for that session, so re-read
    // the whole transcript once. A prefix that DID yield a USER_INPUT needs no
    // retry: that entry is the first message, and it did not match.
    const sawUserInput = prefix.entries.some((e) => e.type === 'USER_INPUT')
    if (!sawUserInput && prefix.truncated) {
        logger.warn(
            `[agy-scanner] no complete USER_INPUT entry within the first ${CONTENT_MATCH_PREFIX_BYTES}B of ${logPath} — falling back to a full read`
        )
        const full = await readTranscriptPrefix(logPath, Number.POSITIVE_INFINITY)
        return matchesUserInput(full.entries, text, bodyNeedle, submittedAtMs)
    }
    return false
}

function matchesUserInput(
    entries: AgyTranscriptEntry[],
    text: string,
    bodyNeedle: string | null,
    submittedAtMs: number | null,
): boolean {
    const normalizedText = normalizeUserInput(text)
    const normalizedBody = bodyNeedle ? normalizeUserInput(bodyNeedle) : null
    for (const entry of entries) {
        if (entry.type !== 'USER_INPUT') continue
        const createdAtMs = Date.parse(entry.created_at)
        const submittedSecondMs = submittedAtMs === null ? null : Math.floor(submittedAtMs / 1000) * 1000
        if (submittedSecondMs === null || !Number.isFinite(createdAtMs) || createdAtMs < submittedSecondMs) continue
        const content = entry.content
        if (!content) continue
        // Prefer the attachment-stripped body text too: agy re-packages
        // attachment references into its own <USER_REQUEST> wrapper
        // (different order/separator than our @path...\n\n prefix), so a
        // whole-needle match fails for any first message that has
        // attachments. The body text alone still appears verbatim in agy's
        // re-packaged transcript regardless of how it re-orders/re-wraps the
        // attachment references.
        // agy stores the submitted text inside a <USER_REQUEST> block and
        // appends its own sections (<ADDITIONAL_METADATA>, ...), so the raw
        // content field never equals what we sent. Compare the isolated
        // request, falling back to the whole field when no wrapper is present.
        const normalizedContent = normalizeUserInput(extractUserRequest(content) ?? content)
        if (normalizedContent === normalizedText) {
            return true
        }
        if (normalizedBody && extractRepackagedAttachmentBody(normalizedContent) === normalizedBody) return true
    }
    return false
}

export function normalizeUserInput(value: string): string {
    return value.replace(/\r\n/g, '\n').trim()
}

function extractRepackagedAttachmentBody(content: string): string {
    return content
        .split('\n')
        .filter((line) => line !== '<USER_REQUEST>' && line !== '</USER_REQUEST>')
        .filter((line) => !/^@\S+( @\S+)*$/.test(line.trim()))
        .join('\n')
        .trim()
}

// Reads and JSONL-parses at most `maxBytes` from the START of the file (not
// an incremental cursor read — this is discovery-phase-only, re-run on every
// poll until a match is found, so it must stay cheap and NOT read whole
// (potentially 1MB+) transcript files every tick). A trailing partial line
// (cut off by the byte cap) is dropped rather than guessed at.
async function readTranscriptPrefix(
    filePath: string,
    maxBytes: number,
): Promise<{ entries: AgyTranscriptEntry[]; truncated: boolean }> {
    let fd
    try {
        fd = await open(filePath, 'r')
    } catch {
        return { entries: [], truncated: false }
    }
    try {
        const size = (await fd.stat()).size
        const length = Math.min(maxBytes, size)
        if (length <= 0) return { entries: [], truncated: false }
        // `truncated` means "the file has content we did not look at", which is
        // the only case where an empty parse warrants a wider re-read.
        const truncated = size > length

        const chunk = Buffer.allocUnsafe(length)
        // Honor the actual byte count: a concurrent truncation between stat()
        // and read() would otherwise leave uninitialized memory in the tail.
        const { bytesRead } = await fd.read(chunk, 0, length, 0)
        const read = chunk.subarray(0, bytesRead)

        const lastNewline = read.lastIndexOf(0x0a)
        // No complete line in the window. Only a wider read can help, and only
        // if there is more file to read (otherwise the first line is simply
        // still being written — retry on the next poll).
        if (lastNewline === -1) return { entries: [], truncated }
        const text = read.subarray(0, lastNewline).toString('utf-8')

        const entries: AgyTranscriptEntry[] = []
        for (const raw of text.split('\n')) {
            const line = raw.trim()
            if (!line) continue
            try {
                const entry = JSON.parse(line) as AgyTranscriptEntry & { type?: string }
                if (!entry.type) continue
                entries.push(entry as AgyTranscriptEntry)
            } catch {
                continue
            }
        }
        return { entries, truncated }
    } finally {
        await fd.close()
    }
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
