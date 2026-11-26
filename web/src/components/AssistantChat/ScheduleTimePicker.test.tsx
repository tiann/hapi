import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
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

describe('ScheduleTimePicker task modes', () => {
    function renderPicker(options: Partial<SessionTaskPickerBridge> | null = {}) {
        const anchorRef = { current: document.createElement('button') }
        const onClose = vi.fn()
        const createTask = vi.fn(async () => undefined)
        const consumeComposerDraft = vi.fn()
        const onDraftsChange = vi.fn()
        const initialDrafts: SessionTaskDrafts = options?.drafts ?? { repeat: EMPTY_REPEAT_DRAFT, queue: EMPTY_QUEUE_DRAFT }

        // Stands in for ComposerButtons, which owns the drafts and feeds every edit back in.
        function Host() {
            const [drafts, setDrafts] = useState(initialDrafts)
            return (
                <ScheduleTimePicker
                    anchorRef={anchorRef}
                    onSchedule={vi.fn()}
                    onClose={onClose}
                    pendingSchedule={null}
                    tasks={options === null ? undefined : {
                        composerDraft: '',
                        ...options,
                        createTask: options.createTask ?? createTask,
                        consumeComposerDraft,
                        drafts,
                        onDraftsChange: (next) => {
                            onDraftsChange(next)
                            setDrafts(next)
                        }
                    }}
                />
            )
        }
        render(
            <I18nProvider>
                <Host />
            </I18nProvider>
        )
        return { onClose, createTask: options?.createTask ?? createTask, consumeComposerDraft, onDraftsChange }
    }

    it('offers only scheduled send where tasks cannot be created', () => {
        renderPicker(null)
        expect(screen.getByRole('button', { name: /relative/i })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
    })

    it('creates a repeat task from the composer draft and hands the draft over', async () => {
        const picker = renderPicker({ composerDraft: 'check progress' })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith({
            kind: 'repeat',
            text: 'check progress',
            intervalMs: 600_000
        }))
        expect(picker.consumeComposerDraft).toHaveBeenCalledTimes(1)
        expect(picker.onClose).toHaveBeenCalledTimes(1)
    })

    it('leaves the composer alone when the message was typed in the form', async () => {
        const picker = renderPicker({ composerDraft: 'composer text' })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'typed in the form' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith({
            kind: 'repeat',
            text: 'typed in the form',
            intervalMs: 600_000
        }))
        // The owner was told about the typed text, then that the form was used up.
        expect(picker.onDraftsChange).toHaveBeenCalledWith({
            repeat: { ...EMPTY_REPEAT_DRAFT, text: 'typed in the form' },
            queue: EMPTY_QUEUE_DRAFT
        })
        expect(picker.onDraftsChange).toHaveBeenLastCalledWith({ repeat: EMPTY_REPEAT_DRAFT, queue: EMPTY_QUEUE_DRAFT })
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

    it('starts a queue with one prompt per line and the chosen interval', async () => {
        const picker = renderPicker()

        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        fireEvent.change(screen.getByLabelText('Messages'), { target: { value: 'first\n你好\n\n吃饭了吗？' } })
        expect(screen.getByText('3 messages, sent in this order')).toBeTruthy()
        fireEvent.change(screen.getByLabelText('Interval'), { target: { value: '10' } })
        fireEvent.click(screen.getByRole('button', { name: 'Start queue' }))

        await waitFor(() => expect(picker.createTask).toHaveBeenCalledWith({
            kind: 'queue',
            items: [{ text: 'first' }, { text: '你好' }, { text: '吃饭了吗？' }],
            intervalMs: 600_000
        }))
        expect(picker.consumeComposerDraft).not.toHaveBeenCalled()
        expect(picker.onClose).toHaveBeenCalledTimes(1)
    })

    it('shows the form text its owner kept from an earlier visit', () => {
        renderPicker({
            drafts: {
                repeat: { ...EMPTY_REPEAT_DRAFT, text: 'kept' },
                queue: { ...EMPTY_QUEUE_DRAFT, prompts: 'kept prompt' }
            }
        })

        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        expect((screen.getByLabelText('Messages') as HTMLTextAreaElement).value).toBe('kept prompt')
        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('kept')
    })

    it('stays open and says so when the hub rejects the task', async () => {
        const picker = renderPicker({ composerDraft: 'ping', createTask: vi.fn(async () => { throw new Error('HTTP 500') }) })

        fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
        fireEvent.click(screen.getByRole('button', { name: 'Create repeat task' }))

        expect((await screen.findByRole('alert')).textContent).toBe('The task could not be created.')
        expect(picker.onClose).not.toHaveBeenCalled()
    })
})
