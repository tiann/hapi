import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_MODE_LABELS } from '@hapi/protocol'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { EMPTY_QUEUE_DRAFT, EMPTY_REPEAT_DRAFT } from '@/lib/sessionTasks'
import { ScheduleTimePicker, type SessionTaskDrafts, type SessionTaskPickerBridge } from './ScheduleTimePicker'

describe('ScheduleTimePicker interactions', () => {
    it('submits the specific datetime when Enter is pressed in the datetime input', () => {
        const anchorRef = { current: document.createElement('button') }
        const onSchedule = vi.fn()
        const onClose = vi.fn()
        const future = new Date(Date.now() + 60 * 60 * 1000)
        const pad = (n: number) => String(n).padStart(2, '0')
        const value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`

        const onParentKeyDown = vi.fn()

        render(
            <I18nProvider>
                <div onKeyDown={onParentKeyDown}>
                    <ScheduleTimePicker
                        anchorRef={anchorRef}
                        onSchedule={onSchedule}
                        onClose={onClose}
                        pendingSchedule={null}
                    />
                </div>
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /specific/i }))
        const input = screen.getByDisplayValue('')
        fireEvent.change(input, { target: { value } })

        const defaultNotPrevented = fireEvent.keyDown(input, { key: 'Enter' })

        expect(defaultNotPrevented).toBe(false)
        expect(onParentKeyDown).not.toHaveBeenCalled()
        expect(onSchedule).toHaveBeenCalledWith({ type: 'absolute', ms: new Date(value).getTime() })
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})

type PickerOptions = Partial<Omit<SessionTaskPickerBridge, 'drafts' | 'onDraftsChange'>> & {
    drafts?: SessionTaskDrafts
    /** Stands in for the hub: createTask by default resolves at once. */
    createTask?: SessionTaskPickerBridge['createTask']
}

type Controls = {
    /** Closes the panel the way a tap outside does; the form inside unmounts with it. */
    close: () => void
    reopen: () => void
    composerDraft: (text: string) => void
    composerText: () => string
    drafts: () => SessionTaskDrafts
    anchor: HTMLButtonElement
}

describe('ScheduleTimePicker task modes', () => {
    function renderPicker(options: PickerOptions | null = {}) {
        const onClose = vi.fn()
        const createTask = options?.createTask ?? vi.fn(async () => undefined)
        const initialDrafts: SessionTaskDrafts = options?.drafts ?? { repeat: EMPTY_REPEAT_DRAFT, queue: EMPTY_QUEUE_DRAFT }
        const controls = {} as Controls
        // Like HappyComposer: the composer is emptied only while it still holds the text the task was made of.
        let composerText = options?.composerDraft ?? ''
        let setComposerText: (text: string) => void = () => {}
        const consumeComposerDraft = vi.fn((text: string) => {
            if (composerText === text) setComposerText('')
        })
        controls.composerText = () => composerText

        // Stands in for ComposerButtons, which owns the drafts and feeds every edit back in.
        function Host() {
            const [open, setOpen] = useState(true)
            const [drafts, setDrafts] = useState(initialDrafts)
            const [, setVersion] = useState(0)
            setComposerText = (text: string) => {
                composerText = text
                setVersion((version) => version + 1)
            }
            const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
            // Like ComposerButtons: closing the panel unmounts it, drafts and all.
            const close = () => {
                onClose()
                setOpen(false)
            }
            controls.close = close
            controls.reopen = () => setOpen(true)
            controls.composerDraft = setComposerText
            controls.drafts = () => drafts
            if (anchor) controls.anchor = anchor
            return (
                <>
                    <button ref={setAnchor} type="button">clock</button>
                    {open ? (
                        <ScheduleTimePicker
                            anchorRef={{ current: anchor }}
                            onSchedule={vi.fn()}
                            onClose={close}
                            pendingSchedule={null}
                            tasks={{
                                composerDraft: composerText,
                                createTask,
                                consumeComposerDraft,
                                drafts,
                                onDraftsChange: setDrafts,
                                permissionMode: options?.permissionMode
                            }}
                        />
                    ) : null}
                </>
            )
        }
        render(
            <I18nProvider>
                <Host />
            </I18nProvider>
        )
        return { onClose, createTask, consumeComposerDraft, controls }
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
        vi.useRealTimers()
    })

    it('offers only scheduled send where tasks cannot be created', () => {
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
        expect(screen.getByRole('button', { name: /relative/i })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Schedule send' })).toBeTruthy()
    })

    it('names the dialog after the active mode', () => {
        renderPicker()
        expect(screen.getByRole('dialog', { name: 'Schedule send' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        expect(screen.getByRole('dialog', { name: 'Repeat' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        expect(screen.getByRole('dialog', { name: 'Queue' })).toBeTruthy()
    })

    it.each(['yolo', 'bypassPermissions', 'always-proceed', 'safe-yolo'] as const)(
        'says in the Repeat and Queue forms that a task runs with a %s permission mode, which does not ask first',
        (permissionMode) => {
            renderPicker({ permissionMode })
            fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
            const hint = screen.getByText(`Runs with this session's permission mode (${PERMISSION_MODE_LABELS[permissionMode]}), which acts without asking first.`)
            expect(hint).toHaveClass('text-[var(--app-warning-text)]')
            // Not a validation error: nothing was submitted.
            expect(screen.queryByRole('alert')).toBeNull()
            fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
            expect(screen.getByText(`Runs with this session's permission mode (${PERMISSION_MODE_LABELS[permissionMode]}), which acts without asking first.`)).toBeTruthy()
            // Scheduled send has no such line: it is not a form that hands prompts to the hub on its own.
            fireEvent.click(screen.getByRole('button', { name: 'Send later' }))
            expect(screen.queryByText(/permission mode/)).toBeNull()
        }
    )

    it.each([undefined, 'default', 'acceptEdits', 'plan'] as const)(
        'says nothing about permissions in the task forms with a %s permission mode',
        (permissionMode) => {
            renderPicker({ permissionMode })
            fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
            expect(screen.getByRole('dialog', { name: 'Repeat' })).toBeTruthy()
            expect(screen.queryByText(/permission mode/)).toBeNull()
            fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
            expect(screen.getByRole('dialog', { name: 'Queue' })).toBeTruthy()
            expect(screen.queryByText(/permission mode/)).toBeNull()
        }
    )

    it('associates the form\'s labels and groups with their fields', () => {
        renderPicker({ composerDraft: 'check progress' })
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        // "Every" names the number input, "First run" names the group, and the
        // datetime input has a name of its own instead of sharing the toggle's.
        expect(screen.getByLabelText('Every')).toHaveProperty('type', 'number')
        const group = screen.getByRole('group', { name: 'First run' })
        fireEvent.click(within(group).getByRole('button', { name: 'At a set time' }))
        expect(screen.getByLabelText('First run date and time')).toHaveProperty('type', 'datetime-local')
        expect(within(group).getByRole('button', { name: 'At a set time' })).toHaveAttribute('aria-pressed', 'true')
        // Queue prompts are named per row.
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        expect(screen.getByLabelText('Message 1')).toHaveProperty('tagName', 'TEXTAREA')
    })

    it('creates a repeat task from the composer draft and hands the draft over', async () => {
        const picker = renderPicker({ composerDraft: 'check progress' })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'repeat',
            text: 'check progress',
            intervalMs: 600_000
        })))
        expect(picker.consumeComposerDraft).toHaveBeenCalledWith('check progress')
        expect(picker.onClose).toHaveBeenCalledTimes(1)
    })

    it('leaves the composer alone when the message was typed in the form', async () => {
        const picker = renderPicker({ composerDraft: 'composer text' })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'typed in the form' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'repeat',
            text: 'typed in the form',
            intervalMs: 600_000
        })))
        // The owner was told about the typed text, then that the form was used up.
        expect(picker.controls.drafts()).toEqual({ repeat: EMPTY_REPEAT_DRAFT, queue: EMPTY_QUEUE_DRAFT })
        expect(picker.consumeComposerDraft).not.toHaveBeenCalled()
    })

    it('refuses to create a repeat task with nothing to send', async () => {
        const picker = renderPicker({ composerDraft: '   ' })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        expect((await screen.findByRole('alert')).textContent).toBe('Enter a message to send.')
        expect(picker.createTask).not.toHaveBeenCalled()
        expect(picker.onClose).not.toHaveBeenCalled()
    })

    it('refuses an interval over 30 days, a first run too far out, and a run limit below the form\'s own minimum', async () => {
        const picker = renderPicker({ composerDraft: 'ping' })
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        const alert = async (text: string) => {
            await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text))
            expect(picker.createTask).not.toHaveBeenCalled()
        }
        fireEvent.change(screen.getByLabelText('Every'), { target: { value: '31' } })
        fireEvent.change(screen.getByLabelText('Interval unit'), { target: { value: 'days' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        await alert('The interval cannot exceed 30 days.')

        fireEvent.change(screen.getByLabelText('Interval unit'), { target: { value: 'minutes' } })
        fireEvent.change(screen.getByLabelText('Every'), { target: { value: '10' } })
        fireEvent.change(screen.getByLabelText('Runs'), { target: { value: '0' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        await alert('Enter a whole number of runs (1-10000).')

        fireEvent.change(screen.getByLabelText('Runs'), { target: { value: '' } })
        const group = screen.getByRole('group', { name: 'First run' })
        fireEvent.click(within(group).getByRole('button', { name: 'At a set time' }))
        const far = new Date(Date.now() + 367 * 24 * 60 * 60 * 1000)
        const pad = (n: number) => String(n).padStart(2, '0')
        fireEvent.change(screen.getByLabelText('First run date and time'), {
            target: { value: `${far.getFullYear()}-${pad(far.getMonth() + 1)}-${pad(far.getDate())}T${pad(far.getHours())}:${pad(far.getMinutes())}` }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        await alert('The first run cannot be more than 366 days ahead.')
    })

    it('offers a "set time" default that is still in the future when the form is submitted half a minute later', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 45))
        const picker = renderPicker({ composerDraft: 'ping' })
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        const group = screen.getByRole('group', { name: 'First run' })
        fireEvent.click(within(group).getByRole('button', { name: 'At a set time' }))
        const input = screen.getByLabelText('First run date and time') as HTMLInputElement
        expect(input.value).toBe('2026-01-15T12:02')
        expect(input.min).toBe('2026-01-15T12:02')
        vi.setSystemTime(new Date(2026, 0, 15, 12, 1, 5))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        await act(async () => {
            await Promise.resolve()
        })
        expect(picker.createTask).toHaveBeenCalledWith(expect.objectContaining({
            startAt: new Date(2026, 0, 15, 12, 2).getTime()
        }))
    })

    it('keeps "At a set time" while the date is incomplete, and refuses to create until it is complete', async () => {
        const picker = renderPicker({ composerDraft: 'ping' })
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        const group = screen.getByRole('group', { name: 'First run' })
        fireEvent.click(within(group).getByRole('button', { name: 'At a set time' }))
        const input = screen.getByLabelText('First run date and time') as HTMLInputElement
        expect(input.value).not.toBe('')

        // A segment cleared to retype it: the browser reports an empty value until the date is complete.
        fireEvent.change(input, { target: { value: '' } })
        expect(screen.getByLabelText('First run date and time')).toBe(input)
        expect(within(group).getByRole('button', { name: 'At a set time' })).toHaveAttribute('aria-pressed', 'true')
        expect(within(group).getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'false')
        // The form does not take the gap for "now": nothing is created until the time is whole.
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        expect((await screen.findByRole('alert')).textContent).toBe('The first run must be in the future.')
        expect(picker.createTask).not.toHaveBeenCalled()

        const at = new Date(Date.now() + 2 * 60 * 60 * 1000)
        const pad = (n: number) => String(n).padStart(2, '0')
        const value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
        fireEvent.change(input, { target: { value } })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        // The task starts at the retyped time (to the minute), not at once.
        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith(expect.objectContaining({ startAt: new Date(value).getTime() })))
    })

    it('goes back to "now" only through its own button', async () => {
        const picker = renderPicker({ composerDraft: 'ping' })
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        fireEvent.change(screen.getByLabelText('Message 1'), { target: { value: 'first' } })
        const group = screen.getByRole('group', { name: 'First run' })
        fireEvent.click(within(group).getByRole('button', { name: 'At a set time' }))
        fireEvent.change(screen.getByLabelText('First run date and time'), { target: { value: '' } })
        fireEvent.click(within(group).getByRole('button', { name: 'Now' }))

        expect(screen.queryByLabelText('First run date and time')).toBeNull()
        expect(within(group).getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Start queue' }))
        await waitFor(() => expect(picker.createTask).toHaveBeenCalledTimes(1))
        expect(picker.createTask.mock.calls[0]?.[0]).not.toHaveProperty('startAt')
    })

    it('edits a queue one prompt per row, each free to span several lines', async () => {
        const picker = renderPicker()

        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        const first = screen.getByLabelText('Message 1') as HTMLTextAreaElement
        fireEvent.change(first, { target: { value: 'first\nwith a second line' } })
        // Enter is left to the textarea: nothing is submitted, the key is not intercepted.
        expect(fireEvent.keyDown(first, { key: 'Enter' })).toBe(true)
        expect(picker.createTask).not.toHaveBeenCalled()
        expect(screen.getByText('1 message, sent in this order')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: 'Add message' }))
        fireEvent.change(screen.getByLabelText('Message 2'), { target: { value: 'second' } })
        fireEvent.click(screen.getByRole('button', { name: 'Add message' }))
        fireEvent.change(screen.getByLabelText('Message 3'), { target: { value: 'third' } })
        expect(screen.getByText('3 messages, sent in this order')).toBeTruthy()
        // Blank rows are ignored in the count.
        fireEvent.click(screen.getByRole('button', { name: 'Add message' }))
        expect(screen.getByText('3 messages, sent in this order')).toBeTruthy()

        // Reorder, then drop a row: the prompts keep their text.
        fireEvent.click(screen.getByRole('button', { name: 'Move message 3 up' }))
        expect((screen.getByLabelText('Message 2') as HTMLTextAreaElement).value).toBe('third')
        fireEvent.click(screen.getByRole('button', { name: 'Move message 2 down' }))
        expect((screen.getByLabelText('Message 3') as HTMLTextAreaElement).value).toBe('third')
        fireEvent.click(screen.getByRole('button', { name: 'Remove message 2' }))
        expect(screen.queryByLabelText('Message 4')).toBeNull()
        expect((screen.getByLabelText('Message 2') as HTMLTextAreaElement).value).toBe('third')

        // The first row cannot move up, the last cannot move down.
        expect(screen.getByRole('button', { name: 'Move message 1 up' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Move message 3 down' })).toBeDisabled()
        // Rows go down to one; removing the last one only blanks it, so there is always a field.
        fireEvent.click(screen.getByRole('button', { name: 'Remove message 3' }))
        fireEvent.click(screen.getByRole('button', { name: 'Remove message 2' }))
        expect(screen.getAllByRole('textbox')).toHaveLength(1)
        expect((screen.getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('first\nwith a second line')
        fireEvent.click(screen.getByRole('button', { name: 'Remove message 1' }))
        expect((screen.getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('')
        fireEvent.change(screen.getByLabelText('Message 1'), { target: { value: 'first\nwith a second line' } })
        fireEvent.click(screen.getByRole('button', { name: 'Add message' }))

        // A queue's interval is a gap after the agent takes a prompt, and the form says so.
        fireEvent.change(screen.getByLabelText('Gap'), { target: { value: '2' } })
        fireEvent.change(screen.getByLabelText('Interval unit'), { target: { value: 'hours' } })
        expect(screen.getByText('Each message goes out 2 hours after the agent takes the previous one.')).toBeTruthy()
        fireEvent.change(screen.getByLabelText('Message 2'), { target: { value: 'second' } })
        fireEvent.click(screen.getByRole('button', { name: 'Start queue' }))

        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'queue',
            items: [{ text: 'first\nwith a second line' }, { text: 'second' }],
            intervalMs: 7_200_000
        })))
        expect(picker.consumeComposerDraft).not.toHaveBeenCalled()
        expect(picker.onClose).toHaveBeenCalledTimes(1)
    })

    it('refuses an empty queue and stops adding rows at the hub\'s limit of 50', async () => {
        const picker = renderPicker()
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        fireEvent.click(screen.getByRole('button', { name: 'Start queue' }))
        expect((await screen.findByRole('alert')).textContent).toBe('Enter at least one message.')
        expect(picker.createTask).not.toHaveBeenCalled()
        cleanup()

        const kept = Array.from({ length: 49 }, (_, index) => `m${index + 1}`)
        const full = renderPicker({ drafts: { repeat: EMPTY_REPEAT_DRAFT, queue: { ...EMPTY_QUEUE_DRAFT, items: kept } } })
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        fireEvent.click(screen.getByRole('button', { name: 'Add message' }))
        fireEvent.change(screen.getByLabelText('Message 50'), { target: { value: 'm50' } })
        // No 51st row can be added, so the editor never builds a list the hub refuses.
        expect(screen.getByRole('button', { name: 'Add message' })).toBeDisabled()
        expect(screen.getByText('50 messages, sent in this order')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Start queue' }))
        await waitFor(() => expect(full.createTask).toHaveBeenCalledTimes(1))
        expect(full.createTask.mock.calls[0]?.[0]).toMatchObject({ kind: 'queue' })
        expect((full.createTask.mock.calls[0]?.[0] as { items: unknown[] }).items).toHaveLength(50)
    })

    it('offers the composer text as the first prompt of a queue and consumes it once the queue exists', async () => {
        const picker = renderPicker({ composerDraft: 'from the composer' })
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        const first = screen.getByLabelText('Message 1') as HTMLTextAreaElement
        expect(first.placeholder).toBe('from the composer')
        fireEvent.click(screen.getByRole('button', { name: 'Add message' }))
        fireEvent.change(screen.getByLabelText('Message 2'), { target: { value: 'typed second' } })
        // The composer text counts as the first prompt while the first row is blank.
        expect(screen.getByText('2 messages, sent in this order')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Start queue' }))

        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'queue',
            items: [{ text: 'from the composer' }, { text: 'typed second' }]
        })))
        expect(picker.consumeComposerDraft).toHaveBeenCalledWith('from the composer')

        // A prompt typed in the first row wins over the composer text.
        act(() => { picker.controls.composerDraft('new composer text') })
        act(() => { picker.controls.reopen() })
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        fireEvent.change(screen.getByLabelText('Message 1'), { target: { value: 'typed first' } })
        fireEvent.click(screen.getByRole('button', { name: 'Start queue' }))
        await waitFor(() => expect(picker.createTask).toHaveBeenLastCalledWith(expect.objectContaining({
            items: [{ text: 'typed first' }]
        })))
        expect(picker.consumeComposerDraft).toHaveBeenCalledTimes(1)
    })

    it('shows the form text its owner kept from an earlier visit', () => {
        renderPicker({
            drafts: {
                repeat: { ...EMPTY_REPEAT_DRAFT, text: 'kept' },
                queue: { ...EMPTY_QUEUE_DRAFT, items: ['kept prompt', 'and this'] }
            }
        })

        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        expect((screen.getByLabelText('Message 1') as HTMLTextAreaElement).value).toBe('kept prompt')
        expect((screen.getByLabelText('Message 2') as HTMLTextAreaElement).value).toBe('and this')
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('kept')
    })

    it('stays open and says so when the hub rejects the task', async () => {
        const picker = renderPicker({ composerDraft: 'ping', createTask: vi.fn(async () => { throw new Error('HTTP 500') }) })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        expect((await screen.findByRole('alert')).textContent).toBe('The task could not be created.')
        expect(picker.onClose).not.toHaveBeenCalled()
        // The form is usable again for a retry.
        expect(screen.getByRole('button', { name: 'Create repeat task' })).not.toBeDisabled()
    })

    it('names the hub\'s reasons for refusing a task', async () => {
        const createTask = vi.fn()
            .mockRejectedValueOnce(new ApiError('HTTP 400 Bad Request: {"code":"too_many_tasks"}', 400, 'too_many_tasks'))
            .mockRejectedValueOnce(new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404))
            .mockRejectedValueOnce(new ApiError('HTTP 400 Bad Request: {"error":"Rate limited by policy"}', 400, undefined, '{"error":"Rate limited by policy"}'))
        const picker = renderPicker({ composerDraft: 'ping', createTask })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        expect((await screen.findByRole('alert')).textContent).toBe('This session already has 20 active tasks; pause or delete one first.')

        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This hub has no task routes; update it to use repeat and queue tasks.'))

        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Rate limited by policy'))
        expect(picker.onClose).not.toHaveBeenCalled()
    })

    it('keeps the mode switch still while a create is in flight', async () => {
        let resolve!: () => void
        const createTask = vi.fn(() => new Promise<void>((done) => { resolve = done }))
        renderPicker({ composerDraft: 'ping', createTask })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        expect(screen.getByRole('button', { name: 'Queue' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Send later' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Create repeat task' })).toBeDisabled()

        await act(async () => {
            resolve()
            await Promise.resolve()
        })
        expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
    })

    it('does not touch the composer, the drafts or the panel when the create answer arrives after the panel closed', async () => {
        let resolve!: () => void
        const createTask = vi.fn(() => new Promise<void>((done) => { resolve = done }))
        const picker = renderPicker({ composerDraft: 'report status', createTask })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        expect(createTask).toHaveBeenCalledTimes(1)

        // A tap outside closes the panel; the user goes on typing a new message.
        act(() => { picker.controls.close() })
        act(() => { picker.controls.composerDraft('a new message') })
        expect(picker.onClose).toHaveBeenCalledTimes(1)

        await act(async () => {
            resolve()
            await Promise.resolve()
        })
        // The owner was asked about the submitted text only; the new message stays.
        expect(picker.consumeComposerDraft).toHaveBeenCalledWith('report status')
        expect(picker.controls.composerText()).toBe('a new message')
        expect(picker.onClose).toHaveBeenCalledTimes(1)
        expect(picker.controls.drafts()).toEqual({ repeat: EMPTY_REPEAT_DRAFT, queue: EMPTY_QUEUE_DRAFT })
    })

    it('consumes the composer text it used when the panel closed without a new draft', async () => {
        let resolve!: () => void
        const createTask = vi.fn(() => new Promise<void>((done) => { resolve = done }))
        const picker = renderPicker({ composerDraft: 'report status', createTask })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))
        act(() => { picker.controls.close() })
        await act(async () => {
            resolve()
            await Promise.resolve()
        })
        expect(picker.consumeComposerDraft).toHaveBeenCalledWith('report status')
        expect(picker.controls.composerText()).toBe('')
    })

    it('clears only the mode that was submitted, leaving the other mode\'s newer draft alone', async () => {
        let resolve!: () => void
        const createTask = vi.fn(() => new Promise<void>((done) => { resolve = done }))
        const picker = renderPicker({ composerDraft: 'ping', createTask })

        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        fireEvent.change(screen.getByLabelText('Message 1'), { target: { value: 'a queue being typed' } })
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'repeat text' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        // The panel closes while the request is out; the queue draft gets another prompt meanwhile.
        act(() => { picker.controls.close() })
        act(() => {
            picker.controls.reopen()
        })
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        fireEvent.click(screen.getByRole('button', { name: 'Add message' }))
        fireEvent.change(screen.getByLabelText('Message 2'), { target: { value: 'added later' } })

        await act(async () => {
            resolve()
            await Promise.resolve()
        })
        // The late answer neither closed the reopened panel nor rewrote the queue draft.
        expect(screen.getByRole('dialog', { name: 'Queue' })).toBeTruthy()
        expect(picker.controls.drafts()).toMatchObject({
            repeat: { text: 'repeat text' },
            queue: { items: ['a queue being typed', 'added later'] }
        })
    })

    it('moves focus into the panel on open and back to the clock button on Escape', () => {
        const picker = renderPicker()
        const clock = picker.controls.anchor
        // A desktop keyboard user lands on the first control of the panel.
        const dialog = screen.getByRole('dialog', { name: 'Schedule send' })
        expect(dialog.contains(document.activeElement)).toBe(true)
        expect(document.activeElement).toBe(within(dialog).getAllByRole('button')[0])

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
        expect(picker.onClose).toHaveBeenCalledTimes(1)
        expect(document.activeElement).toBe(clock)
    })

    it('closes on Escape from a prompt field, keeping the typed draft', () => {
        const picker = renderPicker({ composerDraft: 'ping' })
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        const message = screen.getByLabelText('Message')
        fireEvent.change(message, { target: { value: 'half typed' } })
        fireEvent.keyDown(message, { key: 'Escape' })
        expect(picker.onClose).toHaveBeenCalledTimes(1)
        expect(picker.controls.drafts().repeat.text).toBe('half typed')
        expect(document.activeElement).toBe(picker.controls.anchor)
    })

    it('stays open on the Escape that dismisses an IME candidate list', () => {
        const picker = renderPicker({ composerDraft: 'ping' })
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        const message = screen.getByLabelText('Message')
        fireEvent.change(message, { target: { value: '進捗を確認' } })
        message.focus()
        // While a candidate list is up, Chrome reports keydown Escape with isComposing set.
        fireEvent.keyDown(message, { key: 'Escape', isComposing: true })
        expect(picker.onClose).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', { name: 'Repeat' })).toBeTruthy()
        expect(document.activeElement).toBe(message)
        // The Escape after the composition is the one that closes.
        fireEvent.keyDown(message, { key: 'Escape' })
        expect(picker.onClose).toHaveBeenCalledTimes(1)
        expect(picker.controls.drafts().repeat.text).toBe('進捗を確認')
    })

    it('lifts the mobile sheet above the software keyboard', () => {
        const fine = window.matchMedia
        window.matchMedia = ((query: string) => ({
            matches: query.includes('max-width: 640px') || query.includes('pointer: fine'),
            media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
            dispatchEvent: () => false,
        })) as typeof window.matchMedia
        try {
            renderPicker()
            const dialog = screen.getByRole('dialog', { name: 'Schedule send' })
            // The layout viewport does not shrink for the iOS keyboard; the
            // visual one does, and the sheet sits on top of the difference.
            expect(dialog.className).toContain('bottom-[calc(env(safe-area-inset-bottom)+12px+(100dvh-var(--app-viewport-height,100dvh)))]')
        } finally {
            window.matchMedia = fine
        }
    })
})

describe('ScheduleTimePicker focus effects', () => {
    it('does not move focus for a coarse pointer, and leaves focus where the user put it when they tap outside', () => {
        const original = window.matchMedia
        window.matchMedia = ((query: string) => ({
            matches: query.includes('pointer: coarse'),
            media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
            dispatchEvent: () => false,
        })) as typeof window.matchMedia
        try {
            const onClose = vi.fn()
            function Host() {
                const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
                useEffect(() => { anchor?.focus() }, [anchor])
                return (
                    <>
                        <button ref={setAnchor} type="button">clock</button>
                        <input aria-label="outside" />
                        <ScheduleTimePicker anchorRef={{ current: anchor }} onSchedule={vi.fn()} onClose={onClose} pendingSchedule={null} />
                    </>
                )
            }
            render(<I18nProvider><Host /></I18nProvider>)
            expect(document.activeElement).toBe(screen.getByRole('button', { name: 'clock' }))

            // A tap on the page outside the panel: focus goes to what was tapped, not back to the clock.
            const outside = screen.getByLabelText('outside')
            fireEvent.pointerDown(outside)
            outside.focus()
            expect(onClose).toHaveBeenCalledTimes(1)
            expect(document.activeElement).toBe(outside)
        } finally {
            window.matchMedia = original
        }
    })
})
