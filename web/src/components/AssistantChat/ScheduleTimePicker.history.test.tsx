import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTaskRun } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { EMPTY_QUEUE_DRAFT, EMPTY_REPEAT_DRAFT } from '@/lib/sessionTasks'
import { ScheduleTimePicker, type SessionTaskDrafts } from './ScheduleTimePicker'

const MINUTE = 60_000

function run(overrides: Partial<SessionTaskRun> = {}): SessionTaskRun {
    return {
        id: 'run-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        taskKind: 'queue',
        runNumber: 1,
        outcome: 'sent',
        scheduledFor: Date.now() - 30 * MINUTE,
        recordedAt: Date.now() - 30 * MINUTE,
        takenAt: null,
        detail: null,
        preview: 'first prompt',
        ...overrides
    }
}

type HubOptions = {
    runs?: SessionTaskRun[]
    /** Rejects the history with this error, every time. */
    historyError?: unknown
    /** Lets the first history call through, then rejects the refetch. */
    historyFailsAfterFirst?: unknown
    /** Stands in for the hub's create; resolves at once by default. */
    createTask?: () => Promise<void>
}

function fakeHub(options: HubOptions = {}) {
    let historyCalls = 0
    const api = {
        listSessionTaskRuns: vi.fn(async () => {
            historyCalls += 1
            if (options.historyError) throw options.historyError
            if (options.historyFailsAfterFirst && historyCalls > 1) throw options.historyFailsAfterFirst
            return { runs: options.runs ?? [] }
        }),
    }
    return { api, historyCalls: () => historyCalls }
}

type Hub = ReturnType<typeof fakeHub>

type Controls = {
    /** Closes the panel the way a tap outside does; the panel unmounts with it. */
    close: () => void
    reopen: () => void
    anchor: HTMLButtonElement
    queryClient: QueryClient
}

/** Like ComposerButtons: the panel is mounted while open and gone when closed; the drafts outlive it. */
function mount(hub: Hub, createTask?: () => Promise<void>) {
    const onClose = vi.fn()
    const controls = {} as Controls
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    function Host() {
        const [open, setOpen] = useState(true)
        const [drafts, setDrafts] = useState<SessionTaskDrafts>({ repeat: EMPTY_REPEAT_DRAFT, queue: EMPTY_QUEUE_DRAFT })
        const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
        const close = () => {
            onClose()
            setOpen(false)
        }
        controls.close = close
        controls.reopen = () => setOpen(true)
        if (anchor) controls.anchor = anchor
        return (
            <>
                <input aria-label="outside" />
                <button ref={setAnchor} type="button">clock</button>
                {open ? (
                    <ScheduleTimePicker
                        anchorRef={{ current: anchor }}
                        onSchedule={vi.fn()}
                        onClose={close}
                        pendingSchedule={null}
                        tasks={{
                            composerDraft: '',
                            createTask: createTask ?? vi.fn(async () => undefined),
                            consumeComposerDraft: vi.fn(),
                            drafts,
                            onDraftsChange: setDrafts,
                            history: { api: hub.api as unknown as ApiClient, sessionId: 'session-1' }
                        }}
                    />
                ) : null}
            </>
        )
    }
    render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <Host />
            </I18nProvider>
        </QueryClientProvider>
    )
    return { onClose, controls, queryClient }
}

const originalMatchMedia = window.matchMedia
beforeEach(() => {
    // A desktop pointer: the panel moves focus for keyboard users.
    window.matchMedia = ((query: string) => ({
        matches: query.includes('pointer: fine'),
        media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
        dispatchEvent: () => false,
    })) as typeof window.matchMedia
})
afterEach(() => {
    window.matchMedia = originalMatchMedia
    cleanup()
})

describe('ScheduleTimePicker history', () => {
    it('fetches the history only once it is opened, shows the runs, and closes back to the forms', async () => {
        const hub = fakeHub({ runs: [run({ id: 'r2', recordedAt: Date.now() - MINUTE, preview: 'second' }), run({ id: 'r1', recordedAt: Date.now() - 2 * MINUTE, preview: 'first' })] })
        mount(hub)
        const toggle = await screen.findByRole('button', { name: 'History' })
        // Opening the clock panel costs no request: the runs are asked for when they are shown, not before.
        expect(toggle).toHaveAttribute('aria-pressed', 'false')
        expect(hub.historyCalls()).toBe(0)
        expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy()

        fireEvent.click(toggle)
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalledWith('session-1', 50))
        const history = await screen.findByRole('list', { name: 'History' })
        expect(within(history).getAllByRole('listitem')).toHaveLength(2)
        expect(history.textContent).toContain('second')
        expect(history.textContent).toContain('first')
        expect(toggle).toHaveAttribute('aria-pressed', 'true')
        // The runs replace the forms and the mode switch, not the header.
        expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
        expect(screen.queryByRole('button', { name: /relative/i })).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Schedule send' })).toBeTruthy()

        fireEvent.click(toggle)
        await waitFor(() => expect(screen.queryByRole('list', { name: 'History' })).toBeNull())
        expect(toggle).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy()
        expect(screen.getByRole('button', { name: /relative/i })).toBeTruthy()
        // Back once more, the runs are still there, without a second request.
        fireEvent.click(toggle)
        expect(await screen.findByRole('list', { name: 'History' })).toBeTruthy()
        expect(hub.historyCalls()).toBe(1)
    })

    it('shows each run with its outcome', async () => {
        const now = Date.now()
        const hub = fakeHub({
            runs: [
                run({ id: 'r5', recordedAt: now - MINUTE, runNumber: 3, preview: 'third' }),
                run({ id: 'r4', recordedAt: now - 2 * MINUTE, runNumber: 2, takenAt: now - 90_000, preview: 'second' }),
                run({ id: 'r3', recordedAt: now - 3 * MINUTE, outcome: 'skipped', detail: 'previous_prompt_waiting', runNumber: null, preview: null, taskKind: 'repeat' }),
                run({ id: 'r2', recordedAt: now - 4 * MINUTE, outcome: 'failed', detail: 'machine_offline', runNumber: null, preview: null }),
                run({ id: 'r1', recordedAt: now - 5 * MINUTE, outcome: 'cancelled', runNumber: 1, preview: 'first' })
            ]
        })
        mount(hub)
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        const history = await screen.findByRole('list', { name: 'History' })
        const entries = within(history).getAllByRole('listitem')
        expect(entries).toHaveLength(5)
        expect(entries[0].textContent).toContain('third')
        expect(entries[0].textContent).toContain('Sent, waiting for the agent')
        expect(entries[1].textContent).toContain('Taken by the agent')
        expect(entries[1].textContent).toContain('second')
        expect(entries[2].textContent).toContain('Skipped: the previous prompt was still waiting')
        expect(entries[2].textContent).toContain('Repeat')
        expect(entries[3].textContent).toContain('Failed: the machine was offline')
        expect(entries[4].textContent).toContain('Cancelled')
        expect(entries[4].textContent).toContain('Queue #1')
    })

    it('gives a failed run the reason it failed, not the row\'s sentence for a task still held up', async () => {
        const now = Date.now()
        const hub = fakeHub({
            runs: [
                run({ id: 'r4', recordedAt: now - MINUTE, outcome: 'failed', detail: 'send_failed', runNumber: null, preview: null }),
                run({ id: 'r3', recordedAt: now - 2 * MINUTE, outcome: 'failed', detail: 'session_archived', runNumber: null, preview: null }),
                run({ id: 'r2', recordedAt: now - 3 * MINUTE, outcome: 'failed', detail: 'session_unavailable', runNumber: null, preview: null }),
                run({ id: 'r1', recordedAt: now - 4 * MINUTE, outcome: 'failed', detail: 'machine_offline', runNumber: null, preview: null })
            ]
        })
        mount(hub)
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        const history = await screen.findByRole('list', { name: 'History' })
        const entries = within(history).getAllByRole('listitem')
        expect(entries.map((entry) => entry.textContent)).toEqual([
            expect.stringContaining('Failed: the send failed'),
            expect.stringContaining('Failed: the session was archived'),
            expect.stringContaining('Failed: the session could not be resumed'),
            expect.stringContaining('Failed: the machine was offline')
        ])
        // A run is over: nothing of "retrying" or of what the task does once the machine is back.
        expect(history.textContent).not.toContain('retrying')
        expect(history.textContent).not.toContain('Sends once the machine is back online')
        expect(history.textContent).not.toContain('nothing runs until it is reopened')
    })

    it('notes a cancel the hub could not confirm on that run alone, and drops the note once the hub confirms it', async () => {
        const now = Date.now()
        const hub = fakeHub({
            runs: [
                // Removed by the hub itself, no CLI confirming it yet.
                run({ id: 'r3', recordedAt: now - MINUTE, outcome: 'cancelled', detail: 'cancel_unconfirmed', preview: 'third' }),
                // Still waiting in the queue, the cancel not confirmed.
                run({ id: 'r2', recordedAt: now - 2 * MINUTE, outcome: 'sent', takenAt: null, detail: 'cancel_unconfirmed', runNumber: 2, preview: 'second' }),
                run({ id: 'r1', recordedAt: now - 3 * MINUTE, outcome: 'cancelled', runNumber: 1, preview: 'first' })
            ]
        })
        const { queryClient } = mount(hub)
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        const history = await screen.findByRole('list', { name: 'History' })
        let entries = within(history).getAllByRole('listitem')
        expect(entries).toHaveLength(3)
        expect(entries[0].textContent).toContain('Cancelled')
        expect(entries[0].textContent).toContain('Cancel not confirmed yet')
        expect(entries[1].textContent).toContain('Sent, waiting for the agent')
        expect(entries[1].textContent).toContain('Cancel not confirmed yet')
        expect(entries[2].textContent).toContain('Cancelled')
        expect(entries[2].textContent).not.toContain('Cancel not confirmed yet')
        expect(within(history).getAllByText('Cancel not confirmed yet')).toHaveLength(2)

        // The hub asks the CLI again and, once the cancel is confirmed, clears the detail and announces the change.
        vi.mocked(hub.api.listSessionTaskRuns).mockResolvedValue({ runs: [
            run({ id: 'r3', recordedAt: now - MINUTE, outcome: 'cancelled', preview: 'third' }),
            run({ id: 'r2', recordedAt: now - 2 * MINUTE, outcome: 'sent', takenAt: null, runNumber: 2, preview: 'second' }),
            run({ id: 'r1', recordedAt: now - 3 * MINUTE, outcome: 'cancelled', runNumber: 1, preview: 'first' })
        ] })
        await act(async () => {
            await queryClient.invalidateQueries({ queryKey: ['session-tasks', 'session-1'] })
        })
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(screen.queryByText('Cancel not confirmed yet')).toBeNull())
        expect(within(history).getAllByRole('listitem')).toHaveLength(3)
    })

    it('offers History only on a hub that has the route: once it answered 404, the toggle goes and the forms are back', async () => {
        const hub = fakeHub({ historyError: new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404) })
        const { controls } = mount(hub)
        const toggle = await screen.findByRole('button', { name: 'History' })
        expect(hub.historyCalls()).toBe(0)

        fireEvent.click(toggle)
        await waitFor(() => expect(hub.api.listSessionTaskRuns).toHaveBeenCalledWith('session-1', 50))
        // Nothing behind the toggle could work on this hub: it is gone, the forms are back, and no error claims a failed load.
        await waitFor(() => expect(screen.queryByRole('button', { name: 'History' })).toBeNull())
        expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy()
        expect(screen.queryByRole('list', { name: 'History' })).toBeNull()
        expect(screen.queryByRole('alert')).toBeNull()

        // Known for the session: a reopened panel does not offer it again.
        controls.close()
        controls.reopen()
        await screen.findByRole('dialog', { name: 'Schedule send' })
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
        expect(hub.historyCalls()).toBe(1)
    })

    it('says when there are no runs yet, and when the history could not be loaded, with a retry', async () => {
        const hub = fakeHub({ runs: [] })
        mount(hub)
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        expect(await screen.findByText('No runs recorded yet.')).toBeTruthy()
        cleanup()

        const failing = fakeHub({ historyError: new ApiError('HTTP 502 Bad Gateway', 502) })
        mount(failing)
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        const alert = await screen.findByRole('alert', {}, { timeout: 6000 })
        expect(within(alert).getByText('The history could not be loaded.')).toBeTruthy()
        // The query's own policy tried the 5xx twice more before the panel gave up.
        expect(failing.historyCalls()).toBe(3)
        // A failed load is not a missing route: the toggle stays, so the runs can be asked for again.
        expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true')

        vi.mocked(failing.api.listSessionTaskRuns).mockResolvedValue({ runs: [run()] })
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
        const history = await screen.findByRole('list', { name: 'History' })
        expect(within(history).getAllByRole('listitem')).toHaveLength(1)
        expect(history.textContent).toContain('first prompt')
        expect(screen.queryByRole('alert')).toBeNull()
        expect(failing.api.listSessionTaskRuns).toHaveBeenCalledTimes(4)
    })

    it('forgets the history view when the panel closes', async () => {
        const hub = fakeHub({ runs: [run()] })
        const { controls } = mount(hub)
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        await screen.findByRole('list', { name: 'History' })

        controls.close()
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        controls.reopen()
        await screen.findByRole('dialog', { name: 'Schedule send' })
        // The forms are what the panel opens on, every time; the runs wait behind the toggle.
        expect(screen.queryByRole('list', { name: 'History' })).toBeNull()
        expect(screen.getByRole('button', { name: /relative/i })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'false')
    })

    it('takes the keyboard to the first mode button, not the History toggle, and closes on Escape from the history with focus back on the clock', async () => {
        const hub = fakeHub({ runs: [run()] })
        const { onClose, controls } = mount(hub)
        const dialog = screen.getByRole('dialog', { name: 'Schedule send' })
        expect(dialog.contains(document.activeElement)).toBe(true)
        expect(document.activeElement).toBe(within(dialog).getAllByRole('button').find((button) => button.textContent === 'Send later'))

        const toggle = screen.getByRole('button', { name: 'History' })
        // A click on a button focuses it, which fireEvent does not; the forms under the toggle are gone.
        fireEvent.click(toggle)
        toggle.focus()
        await screen.findByRole('list', { name: 'History' })
        expect(document.activeElement).toBe(toggle)
        // The Escape that dismisses an IME candidate list is not the one that closes the panel.
        fireEvent.keyDown(toggle, { key: 'Escape', isComposing: true })
        expect(onClose).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', { name: 'Schedule send' })).toBeTruthy()

        fireEvent.keyDown(toggle, { key: 'Escape' })
        expect(onClose).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.activeElement).toBe(controls.anchor)
    })

    it('closes on a tap outside from the history view, leaving focus where the user tapped', async () => {
        const hub = fakeHub({ runs: [run()] })
        const { onClose } = mount(hub)
        fireEvent.click(await screen.findByRole('button', { name: 'History' }))
        await screen.findByRole('list', { name: 'History' })

        const outside = screen.getByLabelText('outside')
        fireEvent.pointerDown(outside)
        outside.focus()
        expect(onClose).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.activeElement).toBe(outside)
    })

    it('keeps the History toggle still while a create is in flight, like the mode switch', async () => {
        let answerCreate!: () => void
        const hub = fakeHub()
        mount(hub, () => new Promise<void>((resolve) => { answerCreate = resolve }))
        fireEvent.click(await screen.findByRole('button', { name: 'Repeat' }))
        fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'check progress' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        // Switching to the runs would unmount the form whose answer is on its way.
        expect(screen.getByRole('button', { name: 'History' })).toBeDisabled()
        await act(async () => {
            answerCreate()
            await Promise.resolve()
        })
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('offers no History where tasks cannot be created, nor without a place to read the runs from', () => {
        render(
            <I18nProvider>
                <ScheduleTimePicker
                    anchorRef={{ current: document.createElement('button') }}
                    onSchedule={vi.fn()}
                    onClose={vi.fn()}
                    pendingSchedule={null}
                />
            </I18nProvider>
        )
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
        cleanup()
        // No history source, so no history query either: the panel needs no query client here.
        render(
            <I18nProvider>
                <ScheduleTimePicker
                    anchorRef={{ current: document.createElement('button') }}
                    onSchedule={vi.fn()}
                    onClose={vi.fn()}
                    pendingSchedule={null}
                    tasks={{
                        composerDraft: '',
                        createTask: vi.fn(async () => undefined),
                        consumeComposerDraft: vi.fn(),
                        drafts: { repeat: EMPTY_REPEAT_DRAFT, queue: EMPTY_QUEUE_DRAFT },
                        onDraftsChange: vi.fn()
                    }}
                />
            </I18nProvider>
        )
        expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
    })
})
