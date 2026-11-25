import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    markMessagesConsumed,
    markMessagesDispatching,
    markMessagesIndeterminate,
} from '@/lib/message-window-store'
import { isQueuedOperationPending } from '@/lib/queued-edit-recovery'
import { QueuedMessagesBar } from './QueuedMessagesBar'

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }))
vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({ composer: () => ({ getState: () => ({ text: '' }) }) }),
    useAuiState: () => '',
}))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/toast-context', () => ({ useToast: () => ({ addToast }) }))

const sid = 'steer-feedback'
const localId = 'local-one'
const pendingState = { queuedLocalIds: ['local-two'], indeterminateLocalIds: [localId], dispatchingLocalIds: [localId], invokedLocalMessages: [] }
let finishRequest: (() => void) | undefined
function setup() {
    ingestIncomingMessages(sid, ['one', 'two'].map((id, i) => ({
        id: `server-${id}`, localId: `local-${id}`, seq: i + 1, createdAt: 1000 + i,
        invokedAt: null, status: 'sent', content: { role: 'user', content: { type: 'text', text: `Correction ${id}` } },
    } as DecryptedMessage)))
    let resolve!: (result: unknown) => void
    let reject!: (error: Error) => void
    const steerMessage = vi.fn(() => new Promise((yes, no) => {
        resolve = yes
        reject = no
        finishRequest = () => yes({ status: 'failed', localId })
    }))
    const getQueuedState = vi.fn().mockResolvedValue(pendingState)
    const api = { steerMessage, getQueuedState } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    render(<QueryClientProvider client={client}><QueuedMessagesBar sessionId={sid} api={api} canSteer deliveryActive pendingSchedule={null} pendingScheduleRevision={0} /></QueryClientProvider>)
    const row = (text: string) => within(screen.getByText(text).closest('li')!)
    const first = row('Correction one')
    const second = row('Correction two')
    const button = first.getByRole('button', { name: 'Steer queued message' })
    const otherButton = second.getByRole('button', { name: 'Steer queued message' })
    const click = async () => {
        fireEvent.click(button)
        await waitFor(() => expect(steerMessage).toHaveBeenCalledWith(sid, 'server-one'))
    }
    const reply = async (result: unknown) => {
        await act(async () => { resolve(result) })
        await waitFor(() => expect(isQueuedOperationPending(sid)).toBe(false))
    }
    return { first, second, button, otherButton, click, reply, reject: (error: Error) => reject(error), steerMessage, getQueuedState }
}
afterEach(async () => {
    await act(async () => finishRequest?.())
    await waitFor(() => expect(isQueuedOperationPending(sid)).toBe(false))
    finishRequest = undefined
    clearMessageWindow(sid)
    addToast.mockClear()
})

it('shows row-local request feedback before the reply and prevents repeated or competing actions', async () => {
    const view = setup()
    await view.click()
    expect(view.first.getByText('queuedMessages.steerRequesting')).toBeInTheDocument()
    expect(view.second.queryByText('queuedMessages.steerRequesting')).toBeNull()
    expect(screen.queryByText('queuedMessages.deliveryPending')).toBeNull()
    expect(getMessageWindowState(sid).messages.find(message => message.localId === localId)!.invokedAt).toBeNull()
    fireEvent.click(view.button)
    fireEvent.click(view.otherButton)
    for (const name of ['Edit queued message', 'Cancel queued message']) {
        expect(view.second.getByRole('button', { name })).toBeDisabled()
    }
    expect(view.steerMessage).toHaveBeenCalledTimes(1)
    await view.reply({ status: 'steered', localId })
    expect(view.first.queryByText('queuedMessages.steerRequesting')).toBeNull()
    expect(view.first.getByText('queuedMessages.deliveryPending')).toBeInTheDocument()
    expect(getMessageWindowState(sid).messages.find(message => message.localId === localId)!.invokedAt).toBeNull()
    act(() => markMessagesConsumed(sid, [localId], 2000, true))
    await waitFor(() => expect(screen.queryByText('Correction one')).toBeNull())
    expect(getMessageWindowState(sid).messages.find(message => message.localId === localId)!.invokedAt).toBe(2000)
})

it('lets pending and actual pickup events supersede an outstanding HTTP reply', async () => {
    const view = setup()
    await view.click()
    act(() => markMessagesDispatching(sid, [localId]))
    expect(view.first.queryByText('queuedMessages.steerRequesting')).toBeNull()
    expect(view.first.getByText('queuedMessages.deliveryPending')).toBeInTheDocument()
    act(() => markMessagesConsumed(sid, [localId], 2000, true))
    await waitFor(() => expect(screen.queryByText('Correction one')).toBeNull())
    await view.reply({ status: 'steered', localId })
    expect(view.getQueuedState).not.toHaveBeenCalled()
    expect(screen.queryByText('queuedMessages.steerRequesting')).toBeNull()
    expect(screen.queryByText('queuedMessages.deliveryPending')).toBeNull()
})

it('preserves a genuine unknown event and explicit resolution after the request completes', async () => {
    const view = setup()
    await view.click()
    act(() => markMessagesIndeterminate(sid, [localId]))
    expect(view.first.queryByText('queuedMessages.steerRequesting')).toBeNull()
    expect(view.first.getByText('queuedMessages.steerOutcomeUnknown')).toBeInTheDocument()
    await view.reply({ status: 'steered', localId })
    expect(view.getQueuedState).not.toHaveBeenCalled()
    expect(view.first.getByRole('button', { name: 'queuedMessages.retryOutcome' })).toBeEnabled()
    expect(view.first.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
})

it.each(['failed', 'network'])('clears request feedback after %s without claiming pickup', async (failure) => {
    const view = setup()
    await view.click()
    expect(view.first.getByText('queuedMessages.steerRequesting')).toBeInTheDocument()
    if (failure === 'failed') {
        await view.reply({ status: 'failed', localId, error: 'No active turn' })
    } else {
        await act(async () => view.reject(new Error('offline')))
        await waitFor(() => expect(isQueuedOperationPending(sid)).toBe(false))
    }
    expect(view.first.queryByText('queuedMessages.steerRequesting')).toBeNull()
    expect(view.first.getByRole('button', { name: 'Steer queued message' })).toBeEnabled()
    expect(getMessageWindowState(sid).messages.find(message => message.localId === localId)!.invokedAt).toBeNull()
    expect(addToast).toHaveBeenCalledTimes(1)
})
