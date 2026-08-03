/**
 * Tests for agy resume support in AgySessionScanner:
 *  1. getBrainUuid() reports the matched brain UUID once content is matched.
 *  2. initialize() seeds processed keys from an existing transcript so a
 *     resume does NOT re-emit prior turns (the "old messages re-show" bug).
 *  3. onNewSession() switches to a new brain UUID.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createAgySessionScanner, emitAgyEntriesWithModels } from './agySessionScanner'
import type { AgyTranscriptEntry } from './agyTranscriptTypes'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import type { AttachmentMetadata } from '@/api/types'
import { logger } from '@/ui/logger'

// Build a minimal transcript line for a given step and type.
function makeTranscriptLine(step_index: number, type: AgyTranscriptEntry['type'], content: string): string {
    const entry: AgyTranscriptEntry = {
        step_index,
        source: 'MODEL',
        type,
        status: 'DONE',
        created_at: new Date(Math.ceil(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
        content,
    }
    return JSON.stringify(entry)
}

// We need to write into the real brain dir so AgySessionScanner finds it.
// Capture the expected path structure: ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
const BRAIN_BASE = join(homedir(), '.gemini', 'antigravity-cli', 'brain')

describe('AGY planner model settling', () => {
    const BRAIN_UUID = '00000000-0000-4000-8000-000000000001'

    it('retries a temporarily missing generation and emits every entry once in original order', async () => {
        const entries = [
            JSON.parse(makeTranscriptLine(1, 'USER_INPUT', 'question')) as AgyTranscriptEntry,
            JSON.parse(makeTranscriptLine(2, 'PLANNER_RESPONSE', 'answer')) as AgyTranscriptEntry,
            JSON.parse(makeTranscriptLine(3, 'VIEW_FILE', 'tool')) as AgyTranscriptEntry,
        ]
        const emitted: AgyTranscriptEntry[] = []
        const resolveModels = vi.fn()
            .mockResolvedValueOnce(new Map([[2, null]]))
            .mockResolvedValueOnce(new Map([[2, 'Gemini 3.5 Flash (High)']]))
        const sleep = vi.fn(async () => {})

        await emitAgyEntriesWithModels(entries, emitted.push.bind(emitted), BRAIN_UUID, {
            resolveModels,
            retryDelaysMs: [100, 200],
            sleep,
        })

        expect(resolveModels).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalledTimes(1)
        expect(emitted.map((entry) => [entry.step_index, entry.model])).toEqual([
            [1, undefined],
            [2, 'Gemini 3.5 Flash (High)'],
            [3, undefined],
        ])
    })

    it('stops after bounded retries and emits unknown entries once in original order', async () => {
        const entries = [
            JSON.parse(makeTranscriptLine(4, 'PLANNER_RESPONSE', 'first')) as AgyTranscriptEntry,
            JSON.parse(makeTranscriptLine(5, 'PLANNER_RESPONSE', 'second')) as AgyTranscriptEntry,
        ]
        const emitted: AgyTranscriptEntry[] = []
        const resolveModels = vi.fn(async (_uuid: string | null | undefined, indexes: readonly number[]) => new Map(indexes.map((idx) => [idx, null])))
        const sleep = vi.fn(async () => {})

        await emitAgyEntriesWithModels(entries, emitted.push.bind(emitted), BRAIN_UUID, {
            resolveModels,
            retryDelaysMs: [100, 200, 300],
            sleep,
        })

        expect(resolveModels).toHaveBeenCalledTimes(4)
        expect(sleep).toHaveBeenCalledTimes(3)
        expect(emitted.map((entry) => [entry.step_index, entry.model])).toEqual([
            [4, undefined],
            [5, undefined],
        ])
    })
})

// Build a USER_INPUT line in the shape agy actually writes: the submitted text
// wrapped in <USER_REQUEST> with agy's own trailing sections appended.
function makeAgyUserInputLine(step_index: number, request: string): string {
    return makeTranscriptLine(step_index, 'USER_INPUT', [
        '<USER_REQUEST>',
        request,
        '</USER_REQUEST>',
        '<ADDITIONAL_METADATA>',
        'The current local time is: 2026-08-04T00:00:00+09:00.',
        '</ADDITIONAL_METADATA>',
        '<USER_SETTINGS_CHANGE>',
        'The user changed setting `Model Selection` from None to Gemini 3.6 Flash (Low).',
        '</USER_SETTINGS_CHANGE>',
    ].join('\n'))
}

function makeTempBrain(uuid: string, content: string): { brainDir: string; logPath: string } {
    const brainDir = join(BRAIN_BASE, uuid)
    const logDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 'transcript_full.jsonl')
    writeFileSync(logPath, content, 'utf-8')
    return { brainDir, logPath }
}

describe('AgySessionScanner — resume support', () => {
    // Must match /^[0-9a-f-]{36}$/ so the scanner's directory filter accepts it.
    const TEST_UUID = '00000000-0000-4000-8000-000000000001'

    afterEach(() => {
        // Clean up the temp brain dir.
        try { rmSync(join(BRAIN_BASE, TEST_UUID), { recursive: true, force: true }) } catch { /* best-effort */ }
    })

    it('getBrainUuid() returns null before content match', async () => {
        // A fresh scanner with no session message → no brain known yet.
        const emitted: AgyTranscriptEntry[] = []
        const scanner = await createAgySessionScanner({ onEntry: (e) => emitted.push(e) })
        expect(scanner.getBrainUuid()).toBeNull()
        await scanner.cleanup()
    })

    it('getBrainUuid() returns the UUID once a content match identifies the brain', async () => {
        const needle = `hapi-test-needle-${Date.now()}`
        // USER_INPUT, not PLANNER_RESPONSE: content-match only inspects the
        // decoded content of USER_INPUT entries (our own submitted message
        // echoed back by agy), not the model's own response text — matching
        // PLANNER_RESPONSE would be exactly the "tool-result/response false
        // positive" this scanner deliberately avoids.
        const line = makeTranscriptLine(0, 'USER_INPUT', needle)
        const emitted: AgyTranscriptEntry[] = []
        const scanner = await createAgySessionScanner({ onEntry: (e) => emitted.push(e) })
        makeTempBrain(TEST_UUID, line + '\n')

        // Arm the scanner with the session message text so it can match.
        scanner.setSessionMessageText(needle)
        // Allow a scan cycle to run.
        await vi.waitFor(() => expect(scanner.getBrainUuid()).toBe(TEST_UUID), { timeout: 1500 })
        await scanner.cleanup()
    })

    it('initialize() with a known brain UUID seeds existing transcript so prior turns are not re-emitted', async () => {
        // Pre-existing transcript with 3 entries.
        const existingLines = [
            makeTranscriptLine(0, 'USER_INPUT', 'hello'),
            makeTranscriptLine(1, 'PLANNER_RESPONSE', 'world'),
            makeTranscriptLine(2, 'PLANNER_RESPONSE', 'done'),
        ].join('\n') + '\n'
        makeTempBrain(TEST_UUID, existingLines)

        const emitted: AgyTranscriptEntry[] = []
        // Create scanner with the known brain UUID (resume path).
        const scanner = await createAgySessionScanner({
            resumeBrainUuid: TEST_UUID,
            onEntry: (e) => emitted.push(e),
        })

        // No new content written → scanner should have seeded the 3 existing
        // entries as processed and emitted nothing.
        expect(emitted).toHaveLength(0)
        // Brain UUID must be reported immediately (no content-match needed).
        expect(scanner.getBrainUuid()).toBe(TEST_UUID)

        await scanner.cleanup()
    })

    it('new entry appended after resume is emitted (only the new one)', async () => {
        // Pre-existing transcript.
        const existingLines = [
            makeTranscriptLine(0, 'USER_INPUT', 'prior-msg'),
            makeTranscriptLine(1, 'PLANNER_RESPONSE', 'prior-response'),
        ].join('\n') + '\n'
        const { logPath } = makeTempBrain(TEST_UUID, existingLines)

        const emitted: AgyTranscriptEntry[] = []
        const scanner = await createAgySessionScanner({
            resumeBrainUuid: TEST_UUID,
            onEntry: (e) => emitted.push(e),
        })

        // Append a new entry (simulating agy writing a new turn).
        const newLine = makeTranscriptLine(2, 'PLANNER_RESPONSE', 'new-response') + '\n'
        writeFileSync(logPath, existingLines + newLine, 'utf-8')

        // Trigger a scan via file watch. Model metadata may settle shortly
        // after the transcript append, so wait on the observable emission.
        await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1200 })
        expect(emitted[0].content).toBe('new-response')

        await scanner.cleanup()
    })

    it('onNewSession() switches the scanner to a new brain UUID', async () => {
        const emitted: AgyTranscriptEntry[] = []
        const scanner = await createAgySessionScanner({
            resumeBrainUuid: TEST_UUID,
            onEntry: (e) => emitted.push(e),
        })

        const NEW_UUID = 'ffffffff-0000-4000-8000-000000000002'
        scanner.onNewSession(NEW_UUID)
        expect(scanner.getBrainUuid()).toBe(NEW_UUID)

        await scanner.cleanup()
    })

    it('onNewSession() alone (no content-match, no resumeBrainUuid) emits the existing backlog — the mechanism the launcher hook-wiring fix (agyPtyLauncher.test.ts) depends on', async () => {
        // Existing transcript with a PLANNER_RESPONSE, written BEFORE the scanner
        // is even created (simulates: agy already produced output by the time the
        // PreToolUse hook discovers the brain UUID and notifies the scanner).
        const existingLines = [
            makeTranscriptLine(0, 'USER_INPUT', 'hello'),
            makeTranscriptLine(1, 'PLANNER_RESPONSE', 'agent output the hook must surface'),
        ].join('\n') + '\n'
        makeTempBrain(TEST_UUID, existingLines)

        const emitted: AgyTranscriptEntry[] = []
        // Fresh scanner: no resumeBrainUuid seeded, no sessionMessageText set —
        // content-match never runs, so this is the ONLY discovery signal.
        const scanner = await createAgySessionScanner({ onEntry: (e) => emitted.push(e) })

        // The scanner does nothing until told about a brain (shouldScan() is
        // false with neither sessionMessageText nor foundBrainUuid set).
        expect(emitted).toHaveLength(0)

        scanner.onNewSession(TEST_UUID)
        await vi.waitFor(() => expect(emitted).toHaveLength(2), { timeout: 1200 })

        expect(scanner.getBrainUuid()).toBe(TEST_UUID)
        // The full pre-existing backlog is emitted (cursor started at 0 for this
        // never-before-seen file), not just newly-appended entries.
        expect(emitted.map((e) => e.content)).toEqual(['hello', 'agent output the hook must surface'])

        await scanner.cleanup()
    })

    it('onBrainFound callback is invoked when content-match identifies the brain', async () => {
        const needle = `hapi-test-onbrainFound-${Date.now()}`
        // USER_INPUT — see the "getBrainUuid()...content match" test above for why.
        const line = makeTranscriptLine(0, 'USER_INPUT', needle)
        const emitted: AgyTranscriptEntry[] = []
        const foundUuids: string[] = []
        const scanner = await createAgySessionScanner({
            onEntry: (e) => emitted.push(e),
            onBrainFound: (uuid) => foundUuids.push(uuid),
        })
        makeTempBrain(TEST_UUID, line + '\n')

        scanner.setSessionMessageText(needle)
        await vi.waitFor(() => expect(scanner.getBrainUuid()).toBe(TEST_UUID), { timeout: 1500 })
        expect(foundUuids).toEqual([TEST_UUID])

        await scanner.cleanup()
    })

    it('content-match identifies the brain from the wrapper shape agy actually writes', async () => {
        // A real transcript never stores the bare prompt: agy wraps it in
        // <USER_REQUEST> and appends its own sections. Matching the whole
        // content field can therefore never succeed against a live session.
        const needle = `hapi-test-wrapped-${Date.now()}`
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        // After the scanner starts: a brain that already existed is treated as
        // pre-existing and skipped during discovery.
        makeTempBrain(TEST_UUID, makeAgyUserInputLine(0, needle) + '\n')

        scanner.setSessionMessageText(needle)
        await vi.waitFor(() => expect(scanner.getBrainUuid()).toBe(TEST_UUID), { timeout: 1500 })

        await scanner.cleanup()
    })

    it('content-match stays fail-closed when the wrapped request is a different message', async () => {
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        makeTempBrain(TEST_UUID, makeAgyUserInputLine(0, 'someone-elses-prompt') + '\n')

        scanner.setSessionMessageText(`hapi-test-nomatch-${Date.now()}`)
        await new Promise((resolve) => setTimeout(resolve, 800))
        expect(scanner.getBrainUuid()).toBeNull()

        await scanner.cleanup()
    })

    it('onBrainFound is NOT called when resumeBrainUuid is pre-seeded (already known)', async () => {
        makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'PLANNER_RESPONSE', 'existing') + '\n')

        const foundUuids: string[] = []
        const scanner = await createAgySessionScanner({
            resumeBrainUuid: TEST_UUID,
            onEntry: () => {},
            onBrainFound: (uuid) => foundUuids.push(uuid),
        })

        // Give scanner time to initialize — callback must NOT fire for pre-seeded UUID.
        await new Promise((r) => setTimeout(r, 200))
        expect(foundUuids).toHaveLength(0)

        await scanner.cleanup()
    })

    // Phase 2 (defense-in-depth): the "attachment first message" bug diagnosed
    // 2026-07-03. runAgy.ts's onUserMessage pushes
    // formatMessageWithAttachments(text, attachments) — "@path1 @path2 ...\n\nbody"
    // — into the queue, and agyPtyLauncher sets that as the scanner's
    // sessionMessageText needle. agy's own transcript re-packages the attachment
    // references in a DIFFERENT order/wrapper (observed in production:
    // "<USER_REQUEST>\n@reordered-paths...\nbody"), so a naive
    // content.includes(needle) never matches — the raw needle's "\n\n" separator
    // alone breaks the match (JSON-encodes to a literal two-char "\n" on disk,
    // never equal to the real newline byte in our in-memory needle), regardless
    // of attachment order.
    it('matches content when the transcript re-packages attachments differently than the needle (attachment-first-message regression)', async () => {
        const attachments: AttachmentMetadata[] = [
            { id: 'a', filename: 'a.png', mimeType: 'image/png', size: 1, path: '/tmp/a.png' },
            { id: 'b', filename: 'b.png', mimeType: 'image/png', size: 1, path: '/tmp/b.png' },
            { id: 'c', filename: 'c.png', mimeType: 'image/png', size: 1, path: '/tmp/c.png' },
        ]
        const bodyText = `hapi-test-attachment-reorder-${Date.now()}`
        const needle = formatMessageWithAttachments(bodyText, attachments)
        expect(needle).toBe(`@/tmp/a.png @/tmp/b.png @/tmp/c.png\n\n${bodyText}`)

        // Transcript re-packages the SAME attachments in a different order and a
        // different wrapper/separator — same shape as the real agy <USER_REQUEST> repackaging.
        const reorderedLine = makeAgyUserInputLine(
            0,
            `@/tmp/c.png @/tmp/a.png @/tmp/b.png\n${bodyText}`
        )
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        makeTempBrain(TEST_UUID, reorderedLine + '\n')
        scanner.setSessionMessageText(needle)
        await vi.waitFor(() => expect(scanner.getBrainUuid()).toBe(TEST_UUID), { timeout: 1500 })

        await scanner.cleanup()
    })

    // 2026-07-10: a resident service (gen-proxy) on this machine spawns
    // `agy --print` repeatedly, minting a new brain dir per call — 238 in 5h
    // observed. The old "newest 3 by mtime" cap pushed a real HAPI session's
    // brain out of the scan window within seconds of it being created, so it
    // was never content-matched and the chat stayed permanently empty. The
    // scan window (all brains newer than scannerStartMs - SLACK, no count cap)
    // replaces that cap.
    it('finds our brain despite churn from many newer brains (formerly truncated by the newest-3 window)', async () => {
        const needle = `hapi-churn-needle-${Date.now()}`
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'USER_INPUT', needle) + '\n')

        // Simulate several more-recently-touched foreign brains created after
        // ours (short-lived agy --print churn). Under the old "newest 3" cap,
        // 3+ of these alone would push our brain out of the window entirely.
        const foreignUuids: string[] = []
        for (let i = 0; i < 6; i++) {
            const uuid = `10000000-0000-4000-8000-00000000000${i}`
            foreignUuids.push(uuid)
            makeTempBrain(uuid, makeTranscriptLine(0, 'USER_INPUT', `unrelated-${i}`) + '\n')
        }

        try {
            scanner.setSessionMessageText(needle)
            await new Promise((r) => setTimeout(r, 300))

            expect(scanner.getBrainUuid()).toBe(TEST_UUID)
            await scanner.cleanup()
        } finally {
            for (const uuid of foreignUuids) {
                try { rmSync(join(BRAIN_BASE, uuid), { recursive: true, force: true }) } catch { /* best-effort */ }
            }
        }
    })

    it('never matches a brain older than the discovery window, even if its transcript contains the needle', async () => {
        const needle = `hapi-stale-needle-${Date.now()}`
        const { brainDir } = makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'USER_INPUT', needle) + '\n')

        // Backdate the brain dir well past the (tens-of-seconds) discovery
        // slack, simulating a brain that predates this scanner instance.
        const old = new Date(Date.now() - 5 * 60 * 1000)
        utimesSync(brainDir, old, old)

        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        scanner.setSessionMessageText(needle)
        await new Promise((r) => setTimeout(r, 300))

        // Content matches, but the brain is outside the scan window — must
        // stay unmatched (never falsely claim a stale/foreign brain).
        expect(scanner.getBrainUuid()).toBeNull()
        await scanner.cleanup()
    })

    it('ignores an exact matching brain that existed before scanner startup even within the same timestamp second', async () => {
        const prompt = `timestamp-boundary-${Date.now()}`
        const foreignUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const foreignLine = JSON.stringify({
            ...JSON.parse(makeTranscriptLine(0, 'USER_INPUT', prompt)),
            created_at: new Date(Math.ceil(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
        })

        try {
            makeTempBrain(foreignUuid, foreignLine + '\n')
            const scanner = await createAgySessionScanner({ onEntry: () => {} })
            scanner.setSessionMessageText(prompt)
            await new Promise((resolve) => setTimeout(resolve, 300))

            expect(scanner.getBrainUuid()).toBeNull()
            await scanner.cleanup()
        } finally {
            try { rmSync(join(BRAIN_BASE, foreignUuid), { recursive: true, force: true }) } catch { /* best-effort */ }
        }
    })

    it('fails closed when two in-window brains have the same exact first prompt', async () => {
        const otherUuid = '00000000-0000-4000-8000-000000000002'
        const prompt = `hapi-ambiguous-${Date.now()}`
        try {
            const foundUuids: string[] = []
            const ambiguityCounts: number[] = []
            const scanner = await createAgySessionScanner({
                onEntry: () => {},
                onBrainFound: (uuid) => foundUuids.push(uuid),
                onDiscoveryAmbiguous: (count) => ambiguityCounts.push(count),
            })
            makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'USER_INPUT', prompt) + '\n')
            makeTempBrain(otherUuid, makeTranscriptLine(0, 'USER_INPUT', prompt) + '\n')
            scanner.setSessionMessageText(prompt)
            await new Promise((r) => setTimeout(r, 300))
            scanner.setSessionMessageText(prompt)
            await new Promise((r) => setTimeout(r, 300))

            expect(scanner.getBrainUuid()).toBeNull()
            expect(foundUuids).toEqual([])
            expect(ambiguityCounts).toEqual([2])
            await scanner.cleanup()
        } finally {
            rmSync(join(BRAIN_BASE, otherUuid), { recursive: true, force: true })
        }
    })

    it('does not match a USER_INPUT that only contains the first prompt as a substring', async () => {
        const prompt = `yes-${Date.now()}`
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'USER_INPUT', `please say ${prompt} now`) + '\n')
        scanner.setSessionMessageText(prompt)
        await new Promise((r) => setTimeout(r, 300))

        expect(scanner.getBrainUuid()).toBeNull()
        await scanner.cleanup()
    })

    it('matches a first message whose USER_INPUT line is longer than the bounded prefix read', async () => {
        // The first USER_INPUT sits at offset 0, so a very long first message
        // IS the prefix window: no complete line fits, the prefix parse yields
        // nothing, and giving up there would blank the chat forever (the old
        // whole-file read matched this input).
        const needle = `${'x'.repeat(70 * 1024)} hapi-huge-needle-${Date.now()}`
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'USER_INPUT', needle) + '\n')
        scanner.setSessionMessageText(needle)
        await vi.waitFor(() => expect(scanner.getBrainUuid()).toBe(TEST_UUID), { timeout: 1500 })
        await scanner.cleanup()
    })

    it('finds our brain even when in-window candidates exceed the sanity bound (our brain is the OLDEST in the window)', async () => {
        // Our brain is minted right after the scanner starts, so every foreign
        // brain that churn creates afterwards is NEWER than ours. Any cap that
        // keeps the newest N therefore drops precisely the one brain we are
        // looking for — the newest-3 bug, moved to N.
        const needle = `hapi-cap-needle-${Date.now()}`
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        const { brainDir } = makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'USER_INPUT', needle) + '\n')
        const older = new Date(Date.now() - 5000) // still inside the window, but oldest
        utimesSync(brainDir, older, older)

        const foreignUuids: string[] = []
        for (let i = 0; i < 60; i++) {
            const uuid = `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`
            foreignUuids.push(uuid)
            makeTempBrain(uuid, makeTranscriptLine(0, 'USER_INPUT', `unrelated-${i}`) + '\n')
        }

        try {
            scanner.setSessionMessageText(needle)
            await new Promise((r) => setTimeout(r, 500))

            expect(scanner.getBrainUuid()).toBe(TEST_UUID)
            await scanner.cleanup()
        } finally {
            for (const uuid of foreignUuids) {
                try { rmSync(join(BRAIN_BASE, uuid), { recursive: true, force: true }) } catch { /* best-effort */ }
            }
        }
    })

    it('logs a warning (not silent truncation) when in-window candidates exceed the sanity bound', async () => {
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        const extraUuids: string[] = []
        const COUNT = 60 // comfortably above the sanity bound, with margin for ambient brain-dir churn on this machine
        for (let i = 0; i < COUNT; i++) {
            const uuid = `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`
            extraUuids.push(uuid)
            mkdirSync(join(BRAIN_BASE, uuid), { recursive: true })
        }

        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
        try {
            scanner.setSessionMessageText('needle-that-matches-nothing')
            await new Promise((r) => setTimeout(r, 500))

            expect(warnSpy).toHaveBeenCalled()
            const [message] = warnSpy.mock.calls[0] ?? []
            expect(message).toMatch(/scan window|sanity bound|dropping/i)

            // No content matched anything real → still correctly unmatched.
            expect(scanner.getBrainUuid()).toBeNull()
            await scanner.cleanup()
        } finally {
            warnSpy.mockRestore()
            for (const uuid of extraUuids) {
                try { rmSync(join(BRAIN_BASE, uuid), { recursive: true, force: true }) } catch { /* best-effort */ }
            }
        }
    })

    // Transcript content is JSON-encoded, so a real newline in the user's
    // first message is escaped as the two characters "\n" on disk. Raw-file
    // `fileText.includes(needle)` compares that raw (still-escaped) text
    // against the needle (a real newline byte in memory) and never matches —
    // any multi-line first message permanently blanked the chat. Matching on
    // the JSON-decoded content field (not raw file text) fixes this.
    it('matches a multi-line first user message (decoded-content match, not raw-file substring)', async () => {
        const bodyText = `line one\nline two\nhapi-multiline-${Date.now()}`
        const line = makeTranscriptLine(0, 'USER_INPUT', bodyText)
        const scanner = await createAgySessionScanner({ onEntry: () => {} })
        makeTempBrain(TEST_UUID, line + '\n')
        scanner.setSessionMessageText(bodyText)
        await vi.waitFor(() => expect(scanner.getBrainUuid()).toBe(TEST_UUID), { timeout: 1500 })
        await scanner.cleanup()
    })
})
