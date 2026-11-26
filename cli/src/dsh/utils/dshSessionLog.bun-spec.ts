import { afterAll, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    decodeZstdFrames,
    decodeZstdFramesTolerant,
    firstZstdFrameLength,
    listDshSessionSummaries,
    readDshSessionTranscriptsByIds
} from './dshSessionLog'

/**
 * Production-runtime spec for the DSH log reader.
 *
 * The cli suite runs on vitest/Node, which exercises the node:zlib frame walk
 * (`decodeFramesByLength`). The shipped runner is a Bun binary, so the Bun
 * one-shot decode — and its torn-tail fallback, which Bun needs because it
 * rejects the whole file for one torn frame — is covered here, on Bun:
 *
 *     cd cli && bun test ./src/dsh/utils/dshSessionLog.bun-spec.ts
 *
 * `dshSessionLog.test.ts` runs this file in a Bun subprocess so CI covers it
 * with the rest of the suite. The name avoids `.test.ts` on purpose: vitest
 * must not pick it up (it imports `bun:test`), and the `./` prefix makes
 * `bun test` treat the path as a file rather than a filter.
 */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** One append batch per frame, the way DSH writes a log. */
function batch(lines: object[]): Buffer {
    return Bun.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'))
}

const T0 = 1_700_000_000_000
const event = (type: string, seq: number, data?: unknown) => ({ type, seq, time: T0 + seq * 1000, data })
const header = (id: string) => ({ type: 'session', version: 4, id, createdAt: T0, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 })

const home = mkdtempSync(join(tmpdir(), 'dsh-log-bun-spec-'))
const env = { DSH_HOME: home }

/** Write one session log. The list is ordered by mtime, so it is pinned. */
function write(id: string, frames: Buffer[], modifiedAt = T0): string {
    const dir = join(home, 'sessions', '--tmp-proj--', id)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(path, Buffer.concat(frames))
    utimesSync(path, new Date(modifiedAt), new Date(modifiedAt))
    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify({
        version: 7,
        record: { identity: { formatVersion: 4 }, rows: { turnBoundary: { ver: 1, seq: 3, val: { lastTurn: 1 } } } }
    }))
    return path
}

afterAll(() => {
    rmSync(home, { recursive: true, force: true })
})

describe('dshSessionLog on the Bun runtime', () => {
    it('decodes every frame of a DSH log in one shot', () => {
        const decoded = decodeZstdFrames(Buffer.concat([
            batch([{ a: 1 }, { a: 2 }]),
            batch([{ a: 3 }]),
            batch([{ a: 4 }, { a: 5 }])
        ]))
        expect(Buffer.isBuffer(decoded)).toBe(true)
        expect(decoded.toString('utf8').trim().split('\n').map((line) => JSON.parse(line).a)).toEqual([1, 2, 3, 4, 5])
    })

    it('drops a torn tail frame instead of rejecting the whole log', () => {
        const frames = [batch([{ a: 1 }]), batch([{ a: 2 }]), batch([{ a: 3 }])]
        const whole = Buffer.concat(frames)
        // Bun rejects the file outright for the torn last frame…
        expect(() => decodeZstdFrames(whole.subarray(0, whole.length - Math.floor(frames[2]!.length * 0.4)))).toThrow()
        // …and the tolerant decode keeps every complete frame.
        const decoded = decodeZstdFramesTolerant(whole.subarray(0, whole.length - Math.floor(frames[2]!.length * 0.4)))
        expect(decoded.toString('utf8').trim().split('\n').map((line) => JSON.parse(line).a)).toEqual([1, 2])
    })

    it('is not fooled by a frame boundary look-alike inside a compressed payload', () => {
        const payload = Buffer.concat([
            Buffer.from('{"type":"assistant/message","seq":1,"time":' + T0 + ',"data":{"message":{"id":"m","content":[{"type":"text","text":"before '),
            ZSTD_MAGIC,
            Buffer.from(' after magic"}]}}}\n')
        ])
        // A RAW-block frame keeps the magic verbatim inside the frame body.
        const frameHeader = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x0a])
        const block = (payload.length << 3) | 1
        const rawFrame = Buffer.concat([frameHeader, Buffer.from([block & 0xff, (block >> 8) & 0xff, (block >> 16) & 0xff]), payload])
        const path = write('sess-magic', [batch([header('sess-magic')]), rawFrame])
        const text = decodeZstdFrames(readFileSync(path)).toString('utf8')
        expect(text).toContain('before (')
        expect(text).toContain(' after magic')
    })

    it('lists the session and folds its transcript with unique prefixed ids', async () => {
        // Newer than `sess-magic`: the list is ordered by mtime.
        write('sess-a', [
            batch([header('sess-a')]),
            batch([
                event('user/message', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
                event('assistant/message', 2, { message: { id: 'm', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'hi' }] } }),
                event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } })
            ])
        ], T0 + 60_000)
        expect(listDshSessionSummaries(env, home).map((session) => session.id)).toEqual(['sess-a', 'sess-magic'])
        const [item] = await readDshSessionTranscriptsByIds(['sess-a'], env, home)
        expect(item && 'messages' in item ? item.messages.map((message) => message.localId) : null).toEqual([
            'dsh:sess-a:1', 'dsh:sess-a:2', 'dsh:sess-a:2:1'
        ])
    })

    it('measures the frames Bun writes by length, one block or several', () => {
        // Incompressible input over the 128KB block size: several blocks.
        const severalBlocks = Bun.zstdCompressSync(randomBytes(300_000))
        for (const frame of [batch([{ a: 1 }]), severalBlocks]) {
            expect(firstZstdFrameLength(frame)).toBe(frame.length)
        }
    })
})
