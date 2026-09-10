import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
    _parseAgyModelsJsonForTests,
    _parseAgyModelsOutputForTests,
    _resetAgyModelsCacheForTests,
    listAgyModels
} from './agyModels'

// Real `agy --output-format=json models` capture, trimmed to four models.
const JSON_LISTING = JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response: 'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n',
    command: {
        name: 'models',
        data: {
            models: [
                { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
                { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
                { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)' },
                { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
            ]
        }
    }
})

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
    })
}

beforeEach(() => {
    vi.useRealTimers()
    spawnMock.mockReset()
    _resetAgyModelsCacheForTests()
})

describe('parseAgyModelsJson', () => {
    it('reads the ids and labels straight out of the structured listing', () => {
        expect(_parseAgyModelsJsonForTests(JSON_LISTING)).toEqual([
            { modelId: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
            { modelId: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
            { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
        ])
    })

    it('ignores the progress line agy writes alongside the payload', () => {
        // The probe reads stdout and stderr together, so the status line and
        // the JSON object arrive in the same string in either order.
        expect(_parseAgyModelsJsonForTests(`Fetching available models...\n${JSON_LISTING}\n`))
            .toHaveLength(4)
        expect(_parseAgyModelsJsonForTests(`${JSON_LISTING}\nFetching available models...\n`))
            .toHaveLength(4)
    })

    it('declines output that is not the structured listing so the caller can fall back', () => {
        // Older agy releases ignore `--output-format` and print the table.
        expect(_parseAgyModelsJsonForTests('gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n')).toBeNull()
        expect(_parseAgyModelsJsonForTests('{"command":{"data":{"models":[]}}}')).toBeNull()
        expect(_parseAgyModelsJsonForTests('{"command":{"name":"models"}}')).toBeNull()
        expect(_parseAgyModelsJsonForTests('{ truncated')).toBeNull()
    })

    it('keeps an entry whose label is missing rather than dropping the model', () => {
        const payload = JSON.stringify({ command: { data: { models: [{ id: 'gemini-9-future' }, { id: '' }] } } })
        expect(_parseAgyModelsJsonForTests(payload)).toEqual([{ modelId: 'gemini-9-future' }])
    })
})

describe('parseAgyModelsOutput', () => {
    it('parses space-aligned id and display-name columns without duplicating the id', () => {
        expect(_parseAgyModelsOutputForTests([
            'gemini-3.6-flash-high     Gemini 3.6 Flash (High)',
            'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)'
        ].join('\r\n'))).toEqual([
            { modelId: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)' },
            { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }
        ])
    })

    it('keeps legacy display-name-only output compatible', () => {
        expect(_parseAgyModelsOutputForTests('Gemini 3.5 Flash (High)\n')).toEqual([
            { modelId: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)' }
        ])
    })

    it('accepts raw model ids from non-tty output and keeps their display labels', () => {
        // Piped `agy models` emits bare wire ids, which is the path the probe
        // actually takes; without the label backfill the picker would regress to
        // showing raw ids for every model.
        expect(_parseAgyModelsOutputForTests('gemini-3.6-flash-high\ngemini-3.6-flash-low\n')).toEqual([
            { modelId: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)' },
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }
        ])
    })

    it('leaves an unknown wire id unlabeled rather than inventing a name', () => {
        expect(_parseAgyModelsOutputForTests('gemini-9.9-experimental\n')).toEqual([
            { modelId: 'gemini-9.9-experimental' }
        ])
    })

    it('parses piped output, which separates the id/name columns with a single tab', () => {
        // Real `agy models` capture (piped, agy 1.1.13): the status line is
        // followed by tab-separated `id<TAB>name` rows.
        const output = [
            'Fetching available models...',
            'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
            'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
            'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
            'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
        ].join('\n')

        expect(_parseAgyModelsOutputForTests(output)).toEqual([
            { modelId: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
            { modelId: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
            { modelId: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)' },
            { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
        ])
    })

    it('does not mistake the "Fetching available models..." status line for a model row', () => {
        // A naive `\s+` widening would split this into
        // {modelId:'Fetching', name:'available models...'} — a fake entry at
        // the top of the list. Requiring a tab or 2+ spaces keeps it out.
        const output = 'Fetching available models...\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n'

        expect(_parseAgyModelsOutputForTests(output)).toEqual([
            { modelId: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)' }
        ])
    })
})


describe('listAgyModels live probe', () => {
    it('launches the same agy executable resolved from PATH without a shell wrapper', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()

        // `--output-format=json` is a global flag: after the subcommand, or in
        // its space-separated form, agy rejects it.
        expect(spawnMock).toHaveBeenCalledWith('agy', ['--output-format=json', 'models'], expect.objectContaining({
            stdio: ['ignore', 'pipe', 'pipe'],
            env: expect.objectContaining({ GEMINI_FORCE_FILE_STORAGE: 'true' }),
            windowsHide: process.platform === 'win32',
        }))
        const options = spawnMock.mock.calls[0][2]
        expect(options.env.PATH).toBe(process.env.PATH)
        expect(Object.keys(options.env).some((key) => key.startsWith('SSH_'))).toBe(false)

        child.stdout.emit('data', Buffer.from(`${JSON_LISTING}\n`))
        child.stderr.emit('data', Buffer.from('Fetching available models...\n'))
        child.emit('exit', 0)
        const result = await resultPromise
        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual([
            { modelId: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
            { modelId: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
            { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
        ])
    })

    it('asks again without the flag when the first probe returns no listing at all', async () => {
        // Every agy from 1.0.16 to 1.1.13 ignores an unknown `--output-format`
        // and prints the table anyway, but a build that rejected it outright
        // would leave nothing for either parser to read, and the picker would
        // silently drop to the hardcoded mirror.
        const rejecting = fakeChild()
        const plain = fakeChild()
        spawnMock.mockReturnValueOnce(rejecting).mockReturnValueOnce(plain)
        const resultPromise = listAgyModels()

        rejecting.stderr.emit('data', Buffer.from('flags provided but not defined: -output-format\n'))
        rejecting.emit('exit', 1)
        await Promise.resolve()
        plain.stdout.emit('data', Buffer.from('gemini-3.6-flash-low\n'))
        plain.emit('exit', 0)

        const result = await resultPromise
        expect(spawnMock).toHaveBeenCalledTimes(2)
        expect(spawnMock.mock.calls[1][1]).toEqual(['models'])
        expect(result.availableModels).toEqual([
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }
        ])
    })

    it('does not ask twice when the first probe already produced a listing', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()

        child.stdout.emit('data', Buffer.from(`${JSON_LISTING}\n`))
        child.emit('exit', 0)
        await resultPromise
        expect(spawnMock).toHaveBeenCalledTimes(1)
    })

    it('falls back to the printed table on agy releases that ignore the flag', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()

        child.stdout.emit('data', Buffer.from('gemini-3.6-flash-low\n'))
        child.emit('exit', 0)
        await expect(resultPromise).resolves.toMatchObject({
            success: true,
            availableModels: [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }]
        })
    })

    it('kills a timed-out PATH probe once and settles once despite a late exit', async () => {
        vi.useFakeTimers()
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()

        await vi.advanceTimersByTimeAsync(15_000)
        const result = await resultPromise
        expect(child.kill).toHaveBeenCalledTimes(1)
        expect(result.success).toBe(true)
        expect(result.availableModels?.length).toBeGreaterThan(0)
        child.emit('exit', 0)
        expect(child.kill).toHaveBeenCalledTimes(1)
    })

    it('settles once when spawn error races with exit', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()
        child.emit('error', new Error('missing'))
        child.emit('exit', 1)
        const result = await resultPromise
        expect(result.success).toBe(true)
        expect(result.availableModels?.length).toBeGreaterThan(0)
    })
})

describe('listAgyModels catalog cache', () => {
    const LIVE_A = 'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n'
    const LIVE_B = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
    const AUTH_FAILURE = 'Authentication required\n'
    const CATALOG_A = [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }]
    const CATALOG_B = [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }]

    function queueProbe() {
        const child = fakeChild()
        spawnMock.mockReturnValueOnce(child)
        return child
    }

    function finish(child: ReturnType<typeof fakeChild>, output: string) {
        child.stdout.emit('data', Buffer.from(output))
        child.emit('exit', 0)
    }

    async function primeCatalog(output = LIVE_A) {
        const child = queueProbe()
        const pending = listAgyModels()
        await Promise.resolve()
        finish(child, output)
        return await pending
    }

    it('probes agy when nothing is cached yet', async () => {
        vi.useFakeTimers()
        const result = await primeCatalog()

        expect(spawnMock).toHaveBeenCalledTimes(1)
        expect(result.availableModels).toEqual(CATALOG_A)
    })

    it('answers from the cache without probing again inside the fresh window', async () => {
        vi.useFakeTimers()
        await primeCatalog()

        await vi.advanceTimersByTimeAsync(9 * 60_000)
        const result = await listAgyModels()

        expect(spawnMock).toHaveBeenCalledTimes(1)
        expect(result.availableModels).toEqual(CATALOG_A)
    })

    it('answers from the stale catalog immediately and refreshes behind it', async () => {
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)
        await vi.advanceTimersByTimeAsync(11 * 60_000)

        const refresh = queueProbe()
        const stale = await listAgyModels()
        expect(stale.availableModels).toEqual(CATALOG_A)
        expect(spawnMock).toHaveBeenCalledTimes(2)

        finish(refresh, LIVE_B)
        await vi.advanceTimersByTimeAsync(0)

        const refreshed = await listAgyModels()
        expect(refreshed.availableModels).toEqual(CATALOG_B)
        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it('runs one probe for callers that arrive together with nothing cached', async () => {
        vi.useFakeTimers()
        const child = queueProbe()
        const first = listAgyModels()
        const second = listAgyModels()
        await Promise.resolve()
        finish(child, LIVE_A)

        const [a, b] = await Promise.all([first, second])
        expect(spawnMock).toHaveBeenCalledTimes(1)
        expect(a.availableModels).toEqual(CATALOG_A)
        expect(b.availableModels).toEqual(CATALOG_A)
    })

    it('keeps the last known catalog when the background refresh loses auth', async () => {
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)
        await vi.advanceTimersByTimeAsync(11 * 60_000)

        const failing = queueProbe()
        await listAgyModels()
        finish(failing, AUTH_FAILURE)
        await vi.advanceTimersByTimeAsync(0)

        const afterFailure = queueProbe()
        const result = await listAgyModels()
        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual(CATALOG_A)
        finish(afterFailure, AUTH_FAILURE)
        await vi.advanceTimersByTimeAsync(0)
    })

    it('stops serving a catalog older than a day and waits for the probe', async () => {
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)
        await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1_000)

        const child = queueProbe()
        const pending = listAgyModels()
        await Promise.resolve()
        finish(child, LIVE_B)

        const result = await pending
        expect(spawnMock).toHaveBeenCalledTimes(2)
        expect(result.availableModels).toEqual(CATALOG_B)
    })

    it('probes again on an explicit refresh even while the catalog is fresh', async () => {
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)

        const child = queueProbe()
        const pending = listAgyModels({ refresh: true })
        await Promise.resolve()
        finish(child, LIVE_B)

        const result = await pending
        expect(spawnMock).toHaveBeenCalledTimes(2)
        expect(result.availableModels).toEqual(CATALOG_B)
    })

    it('falls back to the last known catalog when a forced refresh cannot reach agy', async () => {
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)

        queueProbe()
        const pending = listAgyModels({ refresh: true })
        await vi.advanceTimersByTimeAsync(15_000)

        const result = await pending
        expect(result.success).toBe(true)
        expect(result.availableModels).toEqual(CATALOG_A)
    })

    it('answers from the hardcoded mirror without spawning agy again right after a failed probe', async () => {
        // Each probe on an unreachable machine costs the full timeout.
        vi.useFakeTimers()
        queueProbe()
        const firstPending = listAgyModels()
        await vi.advanceTimersByTimeAsync(15_000)
        const fallback = await firstPending
        expect(fallback.availableModels?.length).toBeGreaterThan(0)

        const backedOff = await listAgyModels()
        expect(spawnMock).toHaveBeenCalledTimes(1)
        expect(backedOff.availableModels?.length).toBeGreaterThan(0)

        await vi.advanceTimersByTimeAsync(60_000)
        const second = queueProbe()
        const secondPending = listAgyModels()
        await Promise.resolve()
        finish(second, LIVE_B)

        const live = await secondPending
        expect(spawnMock).toHaveBeenCalledTimes(2)
        expect(live.availableModels).toEqual(CATALOG_B)
    })

    it('does not let a forced refresh be answered by the probe that was already running', async () => {
        // The user signs in while a background revalidation is mid-flight; the
        // answer they get back has to come from a probe that started after that.
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)
        await vi.advanceTimersByTimeAsync(11 * 60_000)

        const stalled = queueProbe()
        await listAgyModels()
        expect(spawnMock).toHaveBeenCalledTimes(2)

        const forced = queueProbe()
        const pending = listAgyModels({ refresh: true })
        finish(stalled, AUTH_FAILURE)
        await vi.advanceTimersByTimeAsync(0)
        finish(forced, LIVE_B)

        const result = await pending
        expect(spawnMock).toHaveBeenCalledTimes(3)
        expect(result.availableModels).toEqual(CATALOG_B)
    })

    it('reports a sign-in failure alongside the catalog it can still serve', async () => {
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)

        const failing = queueProbe()
        const pending = listAgyModels({ refresh: true })
        await Promise.resolve()
        finish(failing, AUTH_FAILURE)

        const forced = await pending
        expect(forced.success).toBe(true)
        expect(forced.availableModels).toEqual(CATALOG_A)
        expect(forced.error).toContain('Authentication required')

        expect(await listAgyModels()).toMatchObject({ success: true, error: expect.stringContaining('Authentication required') })
    })

    it('keeps looking for a sign-in that came back, even while the catalog is fresh', async () => {
        // The user pressed Retry, it failed, then they signed in. Nothing else
        // would re-probe a catalog that is still inside its fresh window.
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)

        const failing = queueProbe()
        const retry = listAgyModels({ refresh: true })
        await Promise.resolve()
        finish(failing, AUTH_FAILURE)
        expect(await retry).toMatchObject({ error: expect.stringContaining('Authentication required') })
        expect(spawnMock).toHaveBeenCalledTimes(2)

        await listAgyModels()
        expect(spawnMock).toHaveBeenCalledTimes(2)

        await vi.advanceTimersByTimeAsync(60_000)
        const recovered = queueProbe()
        const served = await listAgyModels()
        expect(served.availableModels).toEqual(CATALOG_A)
        expect(spawnMock).toHaveBeenCalledTimes(3)

        finish(recovered, LIVE_B)
        await vi.advanceTimersByTimeAsync(0)
        const afterSignIn = await listAgyModels()
        expect(afterSignIn.availableModels).toEqual(CATALOG_B)
        expect(afterSignIn.error).toBeUndefined()
    })

    it('revalidates instead of trusting an entry the clock has thrown into the future', async () => {
        vi.useFakeTimers()
        await primeCatalog(LIVE_A)

        vi.setSystemTime(Date.now() - 2 * 24 * 60 * 60_000)
        const probe = queueProbe()
        const served = await listAgyModels()
        expect(served.availableModels).toEqual(CATALOG_A)
        expect(spawnMock).toHaveBeenCalledTimes(2)
        finish(probe, LIVE_B)
        await vi.advanceTimersByTimeAsync(0)
    })

    it('surfaces the auth failure when there is no catalog to fall back on', async () => {
        vi.useFakeTimers()
        const child = queueProbe()
        const pending = listAgyModels()
        await Promise.resolve()
        finish(child, AUTH_FAILURE)

        const result = await pending
        expect(result.success).toBe(false)
        expect(result.error).toContain('Authentication required')
    })
})
