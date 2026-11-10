import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    AgyWakeWatcher,
    createAgyTranscriptSource,
    createAgyWakeWatch,
    parseAgyTaskCompletion,
    type AgyFsWatchFn,
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
    all: AgyTranscriptStep[] = []
    latest: number | null = null
    plannerCount: number | null = null
    readNewCalls = 0

    async readNewSteps(): Promise<AgyTranscriptStep[]> {
        this.readNewCalls += 1
        return this.queued.splice(0)
    }

    async readStepsSince(sinceIdxExclusive: number): Promise<AgyTranscriptStep[]> {
        return this.all.filter((entry) => entry.idx > sinceIdxExclusive)
    }

    async latestStepIdx(): Promise<number | null> {
        return this.latest
    }

    async countPlannerSteps(): Promise<number | null> {
        return this.plannerCount
    }
}

const TIMING = { pollMs: 10, maxPollMs: 20, quietMs: 60, capMs: 5_000 } as const

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
            maxPollMs: 20,
            quietMs: 5_000,
            capMs: 80,
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
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 0, pollMs: 10, maxPollMs: 20, quietMs: 60_000, capMs: 60_000 })
        watcher.start()
        const controller = new AbortController()
        const settled = watcher.waitForSettle(controller.signal)
        setTimeout(() => controller.abort(), 30)
        const close: WakeWatcherClose = await settled
        expect(close.reason).toBe('next-prompt')
    })

    it('stays armed with zero surfaced steps while background completions are unseen, closing by the cap', async () => {
        const source = new FakeSource()
        const watcher = new AgyWakeWatcher({
            source,
            baselineIdx: 9,
            pollMs: 10,
            maxPollMs: 20,
            quietMs: 80,
            capMs: 220,
            hasOpenBackgroundCommands: () => true
        })
        watcher.start()
        // The quiet window elapses twice over while the background task runs:
        // the watcher must still be polling (readNewCalls keeps growing), not
        // closed.
        await until(() => source.readNewCalls >= 8)
        const close = await watcher.waitForSettle()
        expect(close).toMatchObject({ reason: 'cap', surfacedThroughIdx: null, latestSeenIdx: null, surfacedFully: false, steps: 0 })
    })

    it('closes quiet with zero surfaced steps once the start quiet window passes without background work', async () => {
        const source = new FakeSource()
        const watcher = new AgyWakeWatcher({ source, baselineIdx: 9, pollMs: 10, maxPollMs: 20, quietMs: 80, capMs: 60_000 })
        watcher.start()
        const close = await watcher.waitForSettle()
        expect(close).toMatchObject({ reason: 'quiet', surfacedThroughIdx: null, latestSeenIdx: null, surfacedFully: false, steps: 0 })
    })

    it('ends quiet once the background completions are seen, even mid-wakeup', async () => {
        const source = new FakeSource()
        const sink = collect()
        let bgOpen = true
        const watcher = new AgyWakeWatcher({
            source,
            baselineIdx: 0,
            pollMs: 10,
            maxPollMs: 20,
            quietMs: 120,
            capMs: 10_000,
            hasOpenBackgroundCommands: () => bgOpen,
            onStep: (surfaced) => sink.steps.push(surfaced)
        })
        watcher.start()
        source.queued.push(step({ idx: 1, content: 'completion' }))
        await until(() => sink.steps.length === 1)
        // Past the quiet window with the completion still unseen: still armed.
        await new Promise((resolve) => setTimeout(resolve, 140))
        source.queued.push(step({ idx: 2, content: 'after the completion' }))
        await until(() => sink.steps.length === 2)
        bgOpen = false
        const close = await watcher.waitForSettle()
        expect(close.reason).toBe('quiet')
        expect(close.surfacedFully).toBe(true)
    })

    it('backs the fallback poll off over quiet stretches and restarts it on an event wake', async () => {
        const source = new FakeSource()
        const waits: number[] = []
        let manual = false
        const resolvers: Array<() => void> = []
        const waitForChange = (ms: number): Promise<boolean> => new Promise((resolve) => {
            waits.push(ms)
            if (manual) resolvers.push(() => resolve(true))
            else setTimeout(() => resolve(false), ms)
        })
        const watcher = new AgyWakeWatcher({
            source,
            baselineIdx: 0,
            pollMs: 10,
            maxPollMs: 40,
            quietMs: 60_000,
            capMs: 60_000,
            waitForChange,
            hasOpenBackgroundCommands: () => true
        })
        watcher.start()
        // Auto mode: each wait runs to its timeout, so the interval doubles up
        // to the cap.
        await until(() => waits.length >= 3)
        expect(waits.slice(0, 3)).toEqual([10, 20, 40])
        // Event mode: an early wake restarts the short interval.
        manual = true
        await until(() => resolvers.length > 0)
        expect(waits[3]).toBe(40)
        resolvers.splice(0).forEach((resolve) => resolve())
        await until(() => waits.length >= 5)
        expect(waits[4]).toBe(10)
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
        expect(parsed).toEqual({ exitCode: 0, output: 'SAMPLE-OUTPUT-1', taskId: 'sample-session/task-1' })
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
        expect(parsed).toEqual({ exitCode: 3, output: 'first line\nsecond line', taskId: 'sample-session/task-2' })
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

function fakeWatchFn(): {
    fn: AgyFsWatchFn
    emit: (filename: string | Buffer | null) => void
    fail: () => void
    closed: () => boolean
} {
    const listeners: Array<(event: string, filename: string | Buffer | null) => void> = []
    const errorListeners: Array<() => void> = []
    let closed = false
    const fn: AgyFsWatchFn = (_dir, listener) => {
        listeners.push(listener)
        return {
            on: (_event, cb) => {
                errorListeners.push(cb)
                return undefined
            },
            close: () => {
                closed = true
            }
        }
    }
    return {
        fn,
        emit: (filename) => {
            for (const listener of [...listeners]) listener('change', filename)
        },
        fail: () => {
            for (const cb of [...errorListeners]) cb()
        },
        closed: () => closed
    }
}

describe('createAgyWakeWatch', () => {
    it('wakes the pending wait early when the DB files report a change, filtered by session', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-wake-lease-'))
        const fake = fakeWatchFn()
        const lease = createAgyWakeWatch('sess-1', { conversationsDir: dir }, { watchFn: fake.fn })

        const first = lease.waitForChange(5_000)
        fake.emit('sess-1.db-wal')
        await first

        const second = lease.waitForChange(5_000)
        fake.emit('other-session.db')
        let settled = false
        void second.then(() => {
            settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(settled).toBe(false)
        lease.close()
        await second
    })

    it('resolves a pending waitForChange when the lease closes, instead of hanging', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-wake-lease-'))
        const fake = fakeWatchFn()
        const lease = createAgyWakeWatch('sess-1', { conversationsDir: dir }, { watchFn: fake.fn })

        const pending = lease.waitForChange(60_000)
        lease.close()
        const start = Date.now()
        const woke = await pending
        expect(Date.now() - start).toBeLessThan(1_000)
        expect(woke).toBe(true)
    })

    it('falls back to the timeout wait when fs.watch throws (EMFILE-style machine-wide limit)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-wake-lease-'))
        const throwing: AgyFsWatchFn = () => {
            throw new Error('EMFILE: too many open inotify instances')
        }
        const lease = createAgyWakeWatch('sess-1', { conversationsDir: dir }, { watchFn: throwing })
        const start = Date.now()
        await lease.waitForChange(80)
        expect(Date.now() - start).toBeGreaterThanOrEqual(60)
        lease.close()
    })

    it('marks the hub failed on a late watcher error and keeps serving the timeout wait', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-wake-lease-'))
        const fake = fakeWatchFn()
        const lease = createAgyWakeWatch('sess-1', { conversationsDir: dir }, { watchFn: fake.fn })
        lease.waitForChange(5_000)
        fake.fail()
        const start = Date.now()
        await lease.waitForChange(80)
        expect(Date.now() - start).toBeGreaterThanOrEqual(60)
        lease.close()
    })

    it('closes the directory watcher when the last listener cancels, and probes the DB through the lease', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-wake-lease-'))
        const fake = fakeWatchFn()
        const lease = createAgyWakeWatch('sample-session', { conversationsDir: join(dir, 'conversations') }, { watchFn: fake.fn })

        // No conversations DB in this scratch dir (and bun:sqlite is
        // unavailable under the node test runner anyway): the probe reports
        // no steps instead of throwing.
        expect(await lease.latestStepIdx()).toBeNull()

        lease.close()
        expect(fake.closed()).toBe(true)
    })
})