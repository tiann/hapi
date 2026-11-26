import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants, zstdCompressSync } from 'node:zlib'
import { ListLocalSessionsRpcResponseSchema, dshToTranscript, dshToTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { DshLocalSessionSummary, DshLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import {
    MAX_TRANSCRIPT_COMPRESSED_BYTES,
    type DshFoldedMessage,
    decodeZstdFrames,
    decodeZstdFramesTolerant,
    firstZstdFrameLength,
    foldDshLogEvents,
    foldDshLogText,
    listDshSessionSummaries,
    readDshSessionTranscriptsByIds,
    resolveDshHome
} from './dshSessionLog'

/**
 * Every fixture below mirrors shapes taken from real DSH 0.2.2-rc.1 logs:
 * one header frame then one frame per append batch carrying several events;
 * `turn/end.data.reason` is an OBJECT; injected context arrives as
 * `user/message` events with other `source.kind` values; an assistant message
 * carries several reasoning/text blocks on one seq; tool results are
 * re-emitted with pruned content after a compaction.
 */

type Event = { type: string; seq: number; time: number; data?: unknown }

const T0 = 1_700_000_000_000
const event = (type: string, seq: number, data?: unknown): Event => ({ type, seq, time: T0 + seq * 1000, data })

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** One append batch: DSH compresses a whole batch of lines into one frame. */
function batch(lines: object[]): Buffer {
    return zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'))
}

/**
 * A zstd frame made of a single RAW (uncompressed) block, so the magic can be
 * placed INSIDE the compressed payload deterministically.
 */
function rawFrame(payload: Buffer): Buffer {
    const header = Buffer.alloc(9)
    ZSTD_MAGIC.copy(header, 0)
    header[4] = 0x00 // frame header descriptor: no size, no checksum, no dict
    header[5] = 0x0a // window descriptor: exponent 10 → 1MB window
    const block = (payload.length << 3) | 1 // raw block, last block
    header[6] = block & 0xff
    header[7] = (block >> 8) & 0xff
    header[8] = (block >> 16) & 0xff
    return Buffer.concat([header, payload])
}

const header = (id: string, cwd: string, extra: object = {}) => ({
    type: 'session', version: 4, id, createdAt: T0, cwd, isSeeded: false, delegationDepth: 0, ...extra
})

const home = mkdtempSync(join(tmpdir(), 'dsh-log-test-'))
const env = { DSH_HOME: home }

function sessionDir(project: string, id: string): string {
    const dir = join(home, 'sessions', project, id)
    mkdirSync(dir, { recursive: true })
    return dir
}

function projcache(id: string, rows: Record<string, unknown>): void {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 7, record: { identity: { formatVersion: 4 }, rows } }))
}

const row = (val: unknown) => ({ ver: 1, seq: 1, val })
const mtime = (path: string, at: number) => utimesSync(path, new Date(at), new Date(at))

const MODEL = { kind: 'model', provider: 'deepseek-official', model: 'glm-5.4' }

// --- sess-a: a full conversation ------------------------------------------------
const sessABatch1 = batch([
    event('sandbox/mode', 1, { mode: 'workspace-write' }),
    event('user/message', 2, { content: [{ type: 'text', text: '帮我修一下登录页' }], source: { kind: 'user' } }),
    event('user/message', 3, { content: [{ type: 'text', text: 'available skills: …' }], source: { kind: 'skill-catalog' } }),
    event('assistant/message', 4, {
        turn: 1, step: 1,
        message: { id: 'msg-1', content: [{ type: 'reasoning', text: '先看看路由' }, { type: 'text', text: '我来检查登录页代码。' }], source: MODEL },
        usage: { inputTokens: 100, outputTokens: 20 }
    }),
    event('tool/call', 5, { callId: 'call-1', name: 'read_file', arguments: '{"path":"/tmp/dsh-a/proj/login.ts"}' }),
    event('tool/result', 6, { message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'const x = 1' }] } }),
    event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } })
])
const sessABatch2 = batch([
    event('user/message', 8, { content: [{ type: 'text', text: 'Agent other sent a message: done' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'other' } }),
    event('user/message', 9, { content: [{ type: 'text', text: '再跑下测试' }], source: { kind: 'user' } }),
    event('assistant/message', 10, { turn: 2, step: 1, message: { id: 'msg-2', content: [{ type: 'text', text: '好的。' }, { type: 'text', text: '开始。' }], source: MODEL } }),
    event('tool/call', 11, { callId: 'call-2', name: 'bash', arguments: '{"cmd":"npm test"}' }),
    event('tool/result', 12, { message: { toolCallId: 'call-2', isError: false, content: [{ type: 'text', text: 'original full output' }] } }),
    event('compaction/prune', 13, { shadowedSeqs: [12] }),
    // re-emitted after compaction with pruned content — must not fold again
    event('tool/result', 14, { message: { toolCallId: 'call-2', isError: false, content: [{ type: 'text', text: '[... tool result middle pruned ...]' }] } }),
    event('tool/call', 15, { callId: 'call-3', name: 'bash', arguments: '{"cmd":"npm run build"}' }),
    event('turn/end', 16, { turn: 2, reason: { kind: 'error', error: { message: '您已达到请求数限制', code: 'RATE_LIMIT', status: 429 } } })
])
const sessAPath = join(sessionDir('--tmp-dsh-a-proj--', 'sess-a'), 'session.v4.jsonl.zstd')
writeFileSync(sessAPath, Buffer.concat([batch([header('sess-a', '/tmp/dsh-a/proj')]), sessABatch1, sessABatch2]))
mtime(sessAPath, T0 + 100_000)
projcache('sess-a', {
    title: row('修复登录页'),
    titleInput: row({ first: { seq: 2, text: '帮我修一下登录页' }, count: 2, lastSeq: 9 }),
    turnBoundary: row({ lastTurn: 2 }),
    modelSelection: row({ lastUsed: { provider: 'deepseek-official', model: 'glm-5.4', reasoningEffort: 'high' } }),
    permissions: row({ preset: 'workspace-write' })
})

// --- sess-sub: subagent, never listed -------------------------------------------
writeFileSync(
    join(sessionDir('--tmp-dsh-a-proj--', 'sess-sub'), 'session.v4.jsonl.zstd'),
    batch([header('sess-sub', '/tmp/dsh-a/proj', { parentSession: 'sess-a', origin: 'subagent', delegationDepth: 1 })])
)

// --- sess-relative: no absolute cwd, never listed --------------------------------
writeFileSync(
    join(sessionDir('--rel-proj--', 'sess-relative'), 'session.v4.jsonl.zstd'),
    batch([header('sess-relative', 'relative/proj')])
)

// --- sess-blank: created but never ran a turn -----------------------------------
const sessBlankPath = join(sessionDir('--tmp-dsh-a-proj--', 'sess-blank'), 'session.v4.jsonl.zstd')
writeFileSync(sessBlankPath, Buffer.concat([
    batch([header('sess-blank', '/tmp/dsh-a/proj')]),
    batch([event('sandbox/mode', 1, { mode: 'workspace-write' })])
]))
mtime(sessBlankPath, T0 + 200_000)
projcache('sess-blank', {
    turnBoundary: row({ lastTurn: 0 }),
    modelSelection: row({ lastUsed: null, pending: { provider: 'deepseek-official', model: 'glm-5.3' } })
})

// --- sess-plain: a profile configured with compression "none" -------------------
const sessPlainPath = join(sessionDir('--tmp-dsh-b-proj--', 'sess-plain'), 'session.v4.jsonl')
writeFileSync(sessPlainPath, [
    JSON.stringify(header('sess-plain', '/tmp/dsh-b/proj')),
    JSON.stringify(event('user/message', 1, { content: [{ type: 'text', text: 'plain log' }], source: { kind: 'user' } })),
    JSON.stringify(event('turn/end', 2, { turn: 1, reason: { kind: 'max-tokens' } }))
].join('\n') + '\n')
mtime(sessPlainPath, T0 + 300_000)
projcache('sess-plain', { titleInput: row({ first: { seq: 1, text: 'plain log' }, count: 1 }) })

// --- sess-torn: the last frame was torn by a crash ------------------------------
const tornBatch = batch([event('user/message', 3, { content: [{ type: 'text', text: 'never completed' }], source: { kind: 'user' } })])
const sessTornPath = join(sessionDir('--tmp-dsh-c-proj--', 'sess-torn'), 'session.v4.jsonl.zstd')
writeFileSync(sessTornPath, Buffer.concat([
    batch([header('sess-torn', '/tmp/dsh-c/proj')]),
    batch([event('user/message', 1, { content: [{ type: 'text', text: 'complete batch' }], source: { kind: 'user' } }), event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } })]),
    tornBatch.subarray(0, Math.floor(tornBatch.length * 0.6))
]))
mtime(sessTornPath, T0 + 400_000)
projcache('sess-torn', { turnBoundary: row({ lastTurn: 1 }) })

// --- sess-magic: a frame whose compressed payload contains the zstd magic --------
const sessMagicPath = join(sessionDir('--tmp-dsh-d-proj--', 'sess-magic'), 'session.v4.jsonl.zstd')
writeFileSync(sessMagicPath, Buffer.concat([
    batch([header('sess-magic', '/tmp/dsh-d/proj')]),
    rawFrame(Buffer.concat([
        Buffer.from(`{"type":"assistant/message","seq":1,"time":${T0 + 1000},"data":{"message":{"id":"m","content":[{"type":"text","text":"before `),
        ZSTD_MAGIC,
        Buffer.from(' after magic"}]}}}\n{"type":"step/start","seq":2,"time":1,"data":{}}\n')
    ])),
    batch([event('user/message', 3, { content: [{ type: 'text', text: 'after the magic frame' }], source: { kind: 'user' } })])
]))
mtime(sessMagicPath, T0 + 500_000)
projcache('sess-magic', { turnBoundary: row({ lastTurn: 1 }) })

// --- sess-huge: above the compressed-size bound (never decoded) -----------------
const sessHugePath = join(sessionDir('--tmp-dsh-e-proj--', 'sess-huge'), 'session.v4.jsonl.zstd')
writeFileSync(sessHugePath, Buffer.concat([
    batch([header('sess-huge', '/tmp/dsh-e/proj'), event('turn/start', 1, { turn: 1 })]),
    Buffer.alloc(MAX_TRANSCRIPT_COMPRESSED_BYTES + 1)
]))
mtime(sessHugePath, T0 + 600_000)
projcache('sess-huge', { turnBoundary: row({ lastTurn: 1 }) })

// --- sess-bigheader: a header row past the first 8KB window (the read grows) ---
const sessBigHeaderPath = join(sessionDir('--tmp-dsh-f-proj--', 'sess-bigheader'), 'session.v4.jsonl.zstd')
writeFileSync(sessBigHeaderPath, batch([
    header('sess-bigheader', '/tmp/dsh-f/proj', { padding: randomBytes(12_000).toString('hex') }),
    event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } })
]))
mtime(sessBigHeaderPath, T0 + 700_000)
projcache('sess-bigheader', { title: row('大头部'), turnBoundary: row({ lastTurn: 1 }) })

afterAll(() => {
    rmSync(home, { recursive: true, force: true })
})

type Kind = 'user' | 'reasoning' | 'message' | 'tool-call' | 'tool-call-result' | 'error'
type Row = { localId: string; createdAt?: number; data: Record<string, unknown> | null }

function rowsOf(messages: DshFoldedMessage[]): Row[] {
    return messages.map((message) => {
        const content = message.content as { role: string; content: { type: string; text?: string; data?: Record<string, unknown> } }
        const kind = content.role === 'user' ? 'user' : content.content.data?.type as Kind
        return { localId: message.localId, createdAt: message.createdAt, data: kind === 'user' ? { kind, text: content.content.text } : { kind, ...content.content.data } }
    })
}

describe('listDshSessionSummaries', () => {
    it('lists root sessions with content, skipping subagents, relative-cwd and blank sessions', () => {
        const summaries = listDshSessionSummaries(env, home)
        // Newest first. `sess-torn` ends in a torn frame that sits inside the
        // 8KB header window: the window is cut by frame length, so the torn
        // frame never reaches the decoder. `sess-bigheader` needs the window
        // to grow for its header row.
        expect(summaries.map((session) => session.id)).toEqual([
            'sess-bigheader', 'sess-huge', 'sess-magic', 'sess-torn', 'sess-plain', 'sess-a'
        ])
        expect(summaries.find((session) => session.id === 'sess-bigheader')!.title).toBe('大头部')
        const sessA = summaries.find((session) => session.id === 'sess-a')!
        expect(sessA).toMatchObject({
            title: '修复登录页',
            // The list preview is the first prompt; the imported transcript
            // carries the last user turn.
            lastUserMessage: '帮我修一下登录页',
            cwd: '/tmp/dsh-a/proj',
            modifiedAt: T0 + 100_000
        })
        // The opaque picker value plus the readable id for search.
        expect(sessA.model).toBe('["deepseek-official","glm-5.4"]')
        expect(sessA.extra).toEqual({ turns: 2, model: 'glm-5.4' })
        // No projcache title: the first prompt stands in.
        expect(summaries.find((session) => session.id === 'sess-plain')!.title).toBe('plain log')
    })
})

/** One session's transcript, read the way the runner source reads it. */
async function readOne(id: string): Promise<DshLocalSessionWithMessages | null> {
    const [item] = await readDshSessionTranscriptsByIds([id], env, home)
    if (item && !('messages' in item)) throw new Error(`${id} came back without a transcript: ${JSON.stringify(item.importError)}`)
    return item ?? null
}

describe('readDshSessionTranscriptsByIds', () => {
    it('folds real-shaped events into unique, prefixed rows', async () => {
        const transcript = await readOne('sess-a')
        expect(transcript).not.toBeNull()
        const rows = rowsOf(transcript!.messages)

        // Every folded block of one event after the first carries its block
        // index; seq is unique per event, so ids are unique per row.
        const ids = rows.map((r) => r.localId)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids.every((id) => id.startsWith('dsh:sess-a:'))).toBe(true)
        expect(ids.slice(1, 3)).toEqual(['dsh:sess-a:4', 'dsh:sess-a:4:1'])

        expect(rows.map((r) => r.data!.kind)).toEqual<Kind[]>([
            'user', 'reasoning', 'message', 'tool-call', 'tool-call-result',
            'user', 'message', 'message', 'tool-call', 'tool-call-result',
            'tool-call', 'tool-call-result', 'error'
        ])
        // Injected context (skill catalog, relays from other agents) never
        // becomes a chat row.
        expect(rows.some((r) => r.data!.text === 'available skills: …')).toBe(false)
        expect(rows.some((r) => typeof r.data!.text === 'string' && (r.data!.text as string).includes('Agent other sent'))).toBe(false)
        // The re-emitted pruned tool result is dropped; the original stays.
        const call2Results = rows.filter((r) => r.data!.kind === 'tool-call-result' && r.data!.callId === 'call-2')
        expect(call2Results).toHaveLength(1)
        expect(call2Results[0]!.data!.output).toBe('original full output')
        // A call whose turn died before a result gets a synthetic failed
        // result right after it instead of spinning forever.
        const call3 = rows.findIndex((r) => r.data!.kind === 'tool-call' && r.data!.callId === 'call-3')
        expect(rows[call3 + 1]!.data).toMatchObject({ kind: 'tool-call-result', callId: 'call-3', is_error: true })
        expect(rows[call3 + 1]!.localId).toBe('dsh:sess-a:15:aborted')
        // turn/end.reason is an object; the failed turn becomes an error row.
        expect(rows.at(-1)!.data).toMatchObject({ kind: 'error' })
        expect(rows.at(-1)!.data!.message).toContain('RATE_LIMIT')
        // Tool arguments are parsed; createdAt is the log event time.
        expect(rows[3]!.data!.input).toEqual({ path: '/tmp/dsh-a/proj/login.ts' })
        expect(rows[0]!.createdAt).toBe(T0 + 2000)
        expect(transcript!.lastUserMessage).toBe('再跑下测试')
    })

    it('produces transcripts the shared import contract accepts with importable ids', async () => {
        const transcript = await readOne('sess-a')
        const response = ListLocalSessionsRpcResponseSchema.safeParse({
            success: true,
            sessions: [dshToTranscript(transcript!)]
        })
        expect(response.success).toBe(true)
        if (!response.success || !('sessions' in response.data)) return
        const parsed = response.data.sessions[0]!
        expect('messages' in parsed).toBe(true)
        if (!('messages' in parsed)) return
        expect(parsed.messages.every((message) => message.id.startsWith('dsh:sess-a:'))).toBe(true)
    })

    it('tolerates a torn tail frame and a magic byte sequence inside a compressed payload', async () => {
        const torn = await readOne('sess-torn')
        expect(rowsOf(torn!.messages).map((r) => r.data!.text)).toEqual(['complete batch'])

        const magic = await readOne('sess-magic')
        const magicRows = rowsOf(magic!.messages)
        expect(magicRows.map((r) => r.data!.kind)).toEqual<Kind[]>(['message', 'user'])
        expect(magicRows[0]!.data!.message).toBe('before (\uFFFD/\uFFFD after magic')
        expect(magicRows[1]!.data!.text).toBe('after the magic frame')
    })

    it('reads plain (uncompressed) logs and reports max-tokens turns', async () => {
        const plain = await readOne('sess-plain')
        const rows = rowsOf(plain!.messages)
        expect(rows.map((r) => r.data!.kind)).toEqual<Kind[]>(['user', 'error'])
        expect(rows[1]!.data!.message).toBe('Turn ended (max-tokens)')
    })

    it('reports an oversized session per session instead of decoding it', async () => {
        const [huge, a] = await readDshSessionTranscriptsByIds(['sess-huge', 'sess-a', 'missing'], env, home)
        // The junk after the header would fail a decode; it was never attempted.
        // A rejection is the session's SUMMARY: no `messages` key, or the hub
        // would file it as an empty transcript instead of reporting it.
        expect(huge).not.toHaveProperty('messages')
        expect(dshToTranscriptSummary(huge as DshLocalSessionSummary).importError).toEqual(huge!.importError)
        expect(huge!.importError).toMatchObject({ code: 'transcript_too_large' })
        expect(huge!.importError!.message).toMatch(/MB compressed log/)
        // The rest of the batch is unaffected; unknown ids are simply absent.
        expect(a && 'messages' in a ? a.messages.length : 0).toBeGreaterThan(0)
        expect(a!.importError).toBeUndefined()
        expect([huge, a]).toHaveLength(2)
    })
})

describe('zstd decoding', () => {
    it('decodes every frame of a concatenation', () => {
        const decoded = decodeZstdFrames(Buffer.concat([
            batch([{ a: 1 }, { a: 2 }]),
            batch([{ a: 3 }]),
            batch([{ a: 4 }, { a: 5 }])
        ])).toString('utf8')
        expect(decoded.trim().split('\n').map((line) => JSON.parse(line).a)).toEqual([1, 2, 3, 4, 5])
    })

    it('is not fooled by a frame boundary look-alike inside a payload', () => {
        const payload = Buffer.concat([
            Buffer.from('{"type":"text","text":"x'),
            ZSTD_MAGIC,
            Buffer.from('y"}\n'),
            ZSTD_MAGIC,
            Buffer.from('\n')
        ])
        const decoded = decodeZstdFrames(Buffer.concat([batch([{ a: 'first' }]), rawFrame(payload)])).toString('utf8')
        expect(decoded).toContain('"a":"first"')
        expect(decoded).toContain('x(\uFFFD/\uFFFDy')
    })

    it('drops a torn tail frame instead of failing the whole log', () => {
        const frames = [batch([{ a: 1 }]), batch([{ a: 2 }]), batch([{ a: 3 }])]
        const torn = Buffer.concat(frames).subarray(0, frames[0]!.length + frames[1]!.length + Math.floor(frames[2]!.length * 0.5))
        // The strict decode refuses it; the tolerant one keeps what is whole.
        expect(() => decodeZstdFrames(torn)).toThrow(/truncated/)
        const decoded = decodeZstdFramesTolerant(torn).toString('utf8')
        expect(decoded.trim().split('\n').map((line) => JSON.parse(line).a)).toEqual([1, 2])
    })
})

describe('firstZstdFrameLength', () => {
    it('measures frames the way node:zlib writes them, one block or several', () => {
        const oneBlock = batch([{ a: 1 }])
        // Incompressible input over the 128KB block size: several blocks.
        const severalBlocks = zstdCompressSync(randomBytes(300_000))
        const withChecksum = zstdCompressSync(Buffer.from('checksummed'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
        const handBuilt = rawFrame(Buffer.from('raw block'))
        for (const frame of [oneBlock, severalBlocks, withChecksum, handBuilt]) {
            expect(firstZstdFrameLength(frame)).toBe(frame.length)
        }

        // Inside a concatenation only the frame at the offset is measured.
        const whole = Buffer.concat([oneBlock, severalBlocks, withChecksum])
        expect(firstZstdFrameLength(whole)).toBe(oneBlock.length)
        expect(firstZstdFrameLength(whole.subarray(oneBlock.length))).toBe(severalBlocks.length)
        expect(firstZstdFrameLength(whole.subarray(oneBlock.length + severalBlocks.length))).toBe(withChecksum.length)
    })

    it('reports a frame longer than the buffer, and null for what is not a frame start', () => {
        const frame = batch([{ a: 1 }])
        // Torn: the frame's length is still known (the caller reads more, or
        // drops it as a tail).
        expect(firstZstdFrameLength(frame.subarray(0, frame.length - 1))).toBe(frame.length)
        // Too short to hold the frame and block headers.
        expect(firstZstdFrameLength(frame.subarray(0, 6))).toBeNull()
        expect(firstZstdFrameLength(Buffer.alloc(0))).toBeNull()
        expect(firstZstdFrameLength(Buffer.from('not zstd at all'))).toBeNull()
    })
})

describe('fold limits', () => {
    it('stops folding once the budget is blown and reports it', async () => {
        const events = Array.from({ length: 6 }, (_, index) =>
            event('user/message', index + 1, { content: [{ type: 'text', text: `turn ${index}` }], source: { kind: 'user' } }))
        expect(foldDshLogEvents(events, 'x', { maxChars: 1e9, maxMessages: 2 })).toHaveLength(2)

        const plain = events.map((item) => JSON.stringify(item)).join('\n')
        const limited = await foldDshLogText(plain, 'x', { maxChars: 100, maxMessages: 1000 })
        expect(limited.exceeded).toBe(true)
        expect(limited.messages.length).toBeLessThan(6)
        const full = await foldDshLogText(plain, 'x')
        expect(full.exceeded).toBe(false)
        expect(full.messages).toHaveLength(6)
        expect(full.lastUserMessage).toBe('turn 5')
    })

    it('gives events without a seq stable unique ids', () => {
        const messages = foldDshLogEvents([
            { type: 'user/message', data: { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } } },
            { type: 'user/message', data: { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } } }
        ], 'x')
        expect(messages.map((message) => message.localId)).toEqual(['dsh:x:x1', 'dsh:x:x2'])
    })
})

describe('Bun runtime', () => {
    it('passes the Bun-runtime spec that covers the production decode path', () => {
        // vitest runs this file on Node, where the reader takes its node:zlib
        // fallback. The shipped runner is a Bun binary, so the Bun one-shot
        // decode is specified in dshSessionLog.bun-spec.ts and executed here.
        const cliRoot = fileURLToPath(new URL('../../../', import.meta.url))
        try {
            execFileSync('bun', ['test', './src/dsh/utils/dshSessionLog.bun-spec.ts'], {
                cwd: cliRoot,
                encoding: 'utf8',
                timeout: 120_000
            })
        } catch (error) {
            const failure = error as { stdout?: string; stderr?: string; message?: string }
            throw new Error(`bun test failed: ${failure.message ?? ''}
${failure.stdout ?? ''}
${failure.stderr ?? ''}`)
        }
    })
})

describe('resolveDshHome', () => {
    it('follows the DSH_HOME override and falls back to ~/.dsh', () => {
        expect(resolveDshHome({}, '/home/someone')).toBe('/home/someone/.dsh')
        expect(resolveDshHome({ DSH_HOME: ' /elsewhere/dsh ' }, '/home/someone')).toBe('/elsewhere/dsh')
    })
})
