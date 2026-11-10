import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    AgyWakeWatcher,
    createAgyTranscriptSource,
    parseAgyTaskCompletion,
    type AgyTranscriptSource,
    type AgyTranscriptStep,
    type WakeWatcherClose
} from './agyLateContinuation'

function step(overrides: Partial<AgyTranscriptStep> & { idx: number }): AgyTranscriptStep {
    return {
        kind: 'planner',
        status: 'done',
        createdAt: '2026-11-10T05:00:00Z',
        content: '',
        toolCalls: [],
        ...overrides
    }
}

class FakeSource implements AgyTranscriptSource {
    queued: AgyTranscriptStep[] = []
    latest: number | null = null
    plannerCount: number | null = null
    readNewCalls = 0

    async readNewSteps(): Promise<AgyTranscriptStep[]> {
        this.readNewCalls += 1
        return this.queued.splice(0)
    }

    async latestStepIdx(): Promise<number | null> {
        return this.latest
    }

    async countPlannerSteps(): Promise<number | null> {
        return this.plannerCount
    }
}

const TIMING = { pollMs: 10, quietMs: 60, capMs: 5_000, advanceMs: 40 } as const

function collect(): { steps: AgyTranscriptStep[]; activity: number[] } {
    const steps: AgyTranscriptStep[] = []
    return { steps, activity: [] }
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('condition not reached')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

describe('AgyWakeWatcher', () => {
    it('surfaces new steps above the baseline, marks activity once, and closes quiet with surfacedFully', async () => {
        const source = new FakeSource()
        const sink = collect()
        const watcher = new AgyWakeWatcher({
            source,
            baselineIdx: 4,
            ...TIMING,
            onStep: (surfaced) => sink.steps.push(surfaced),
            onActivity: () => sink.activity.push(1)
        })
        watcher.start()

        source.queued.push(step({ idx: 2, content: 'old' }), step({ idx: 5, content: 'wake a' }), step({ idx: 6, content: 'wake b' }))
        source.latest = 6
        await until(() => sink.steps.length === 2)
        expect(sink.activity).toHaveLength(1)
        expect(sink.steps.map((surfaced) => surfaced.idx)).toEqual([5, 6])

        const close = await watcher.waitForSettle()
        expect(close).toMatchObject({ reason: 'quiet', surfacedThroughIdx: 6, latestSeenIdx: 6, surfacedFully: true, steps: 2 })
    })

    it('ignores user_input/ephemeral/other steps but still counts them as transcript progress', async () => {
        const source = new FakeSource()
        const sink = collect()
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 0, ...TIMING, onStep: (surfaced) => sink.steps.push(surfaced) })
        watcher.start()

        source.queued.push(step({ idx: 1, kind: 'user_input' }), step({ idx: 2, kind: 'ephemeral' }), step({ idx: 3, kind: 'other' }))
        source.latest = 3
        await until(() => source.readNewCalls > 0)
        await watcher.waitForSettle()
        expect(sink.steps).toHaveLength(0)
    })

    it('closes by cap with surfacedFully false while steps keep arriving', async () => {
        const source = new FakeSource()
        const sink = collect()
        const watcher = new AgyWakeWatcher({
            source,
            baselineIdx: 0,
            pollMs: 10,
            quietMs: 5_000,
            capMs: 80,
            advanceMs: 40,
            onStep: (surfaced) => sink.steps.push(surfaced)
        })
        watcher.start()

        // Steps keep arriving past the cap: quiet can never fire first.
        const producer = setInterval(() => {
            source.queued.push(step({ idx: source.queued.length + 1 + 100, content: `more ${source.queued.length}` }))
            source.latest = (source.latest ?? 100) + 1
        }, 20)

        const close = await watcher.waitForSettle()
        clearInterval(producer)
        expect(close.reason).toBe('cap')
        expect(close.surfacedFully).toBe(false)
        expect(close.steps).toBeGreaterThan(0)
    })

    it('stop(next-prompt) resolves waitForSettle early and reports what it saw', async () => {
        const source = new FakeSource()
        const sink = collect()
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 0, ...TIMING, onStep: (surfaced) => sink.steps.push(surfaced) })
        watcher.start()
        source.queued.push(step({ idx: 1, content: 'one' }))
        source.latest = 1
        await until(() => sink.steps.length === 1)

        const settled = watcher.waitForSettle()
        const closed = await watcher.stop('next-prompt')
        expect(await settled).toBe(closed)
        expect(closed.reason).toBe('next-prompt')
        expect(closed.surfacedThroughIdx).toBe(1)
        expect(closed.surfacedFully).toBe(true)
    })

    it('counts DB-only progress toward latestSeen so a lagging transcript stays surfacedFully false', async () => {
        const source = new FakeSource()
        const sink = collect()
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 0, ...TIMING, onStep: (surfaced) => sink.steps.push(surfaced) })
        watcher.start()

        // The DB already saw idx 9; the transcript only delivered idx 5 so far.
        source.queued.push(step({ idx: 5, content: 'partial' }))
        source.latest = 9
        await until(() => sink.steps.length === 1)
        const close = await watcher.waitForSettle()
        expect(close).toMatchObject({ reason: 'quiet', surfacedThroughIdx: 5, latestSeenIdx: 9, surfacedFully: false })
    })

    it('waitForSettle resolves immediately after a close', async () => {
        const source = new FakeSource()
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 0, ...TIMING })
        watcher.start()
        await watcher.stop('disabled')
        const close = await watcher.waitForSettle()
        expect(close.reason).toBe('disabled')
    })

    it('aborts waitForSettle via the signal as a next-prompt close', async () => {
        const source = new FakeSource()
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 0, pollMs: 10, quietMs: 60_000, capMs: 60_000, advanceMs: 40 })
        watcher.start()
        const controller = new AbortController()
        const settled = watcher.waitForSettle(controller.signal)
        setTimeout(() => controller.abort(), 30)
        const close: WakeWatcherClose = await settled
        expect(close.reason).toBe('next-prompt')
    })

    it('isAdvancing is true only shortly after the latest surfaced step', async () => {
        const source = new FakeSource()
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 0, pollMs: 10, quietMs: 5_000, capMs: 60_000, advanceMs: 60 })
        watcher.start()
        expect(watcher.isAdvancing()).toBe(false)
        source.queued.push(step({ idx: 1, content: 'one' }))
        await until(() => watcher.isAdvancing())
        await new Promise((resolve) => setTimeout(resolve, 90))
        expect(watcher.isAdvancing()).toBe(false)
        await watcher.stop('next-prompt')
    })
})

describe('parseAgyTaskCompletion', () => {
    it('parses the background-task completion SYSTEM_MESSAGE body', () => {
        const parsed = parseAgyTaskCompletion([
            'The following is a <SYSTEM_MESSAGE> not actually sent by the user.',
            '',
            '<SYSTEM_MESSAGE>',
            '[Message] timestamp=2026-11-10T05:00:25Z sender=sample-session/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id "sample-session/task-1" finished with result:',
            'Command exited with code 0.',
            '',
            'Command output:',
            'SAMPLE-OUTPUT-1',
            '',
            'Log: file:///sample/tasks/task-1.log',
            '</SYSTEM_MESSAGE>'
        ].join('\n'))
        expect(parsed).toEqual({ exitCode: 0, output: 'SAMPLE-OUTPUT-1' })
    })

    it('parses a non-zero exit and multi-line output', () => {
        const parsed = parseAgyTaskCompletion([
            '<SYSTEM_MESSAGE>',
            '[Message] timestamp=2026-11-10T05:00:25Z sender=sample-session/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "sample-session/task-2" finished with result:',
            'Command exited with code 3.',
            '',
            'Command output:',
            'first line',
            'second line',
            '</SYSTEM_MESSAGE>'
        ].join('\n'))
        expect(parsed).toEqual({ exitCode: 3, output: 'first line\nsecond line' })
    })

    it('returns null for system messages that are not task completions', () => {
        expect(parseAgyTaskCompletion('The following is a <SYSTEM_MESSAGE> about something else')).toBeNull()
        expect(parseAgyTaskCompletion('')).toBeNull()
    })
})

describe('createAgyTranscriptSource', () => {
    it('falls back to the transcript for latestStepIdx when the DB is unreadable, and serves steps', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-wake-source-'))
        const transcriptDir = join(dir, 'sample-session', '.system_generated', 'logs', 'chunks', 'transcript_full')
        const { mkdirSync } = await import('node:fs')
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(join(transcriptDir, '00000000.jsonl'), [
            JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-10T05:00:00Z', content: 'answer' }),
            JSON.stringify({ step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-10T05:00:05Z', content: 'task done' })
        ].join('\n') + '\n')

        const source = createAgyTranscriptSource('sample-session', { brainDir: dir, conversationsDir: join(dir, 'conversations') })
        expect(source).not.toBeNull()
        const steps = await source!.readNewSteps()
        expect(steps.map((entry) => entry.idx)).toEqual([2, 3])
        // bun:sqlite is unavailable under the node test runner; the transcript max wins.
        expect(await source!.latestStepIdx()).toBe(3)
        expect(await source!.countPlannerSteps(2)).toBeNull()
    })
})