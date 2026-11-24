import { describe, expect, it } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { enqueueHermesUserMessage, isHermesSlashCommand } from './runHermes'
import type { HermesMode } from './types'

const defaultMode: HermesMode = { permissionMode: 'default' }

describe('enqueueHermesUserMessage', () => {
    it('recognizes Hermes built-in slash commands', () => {
        expect(isHermesSlashCommand('/compact')).toBe(true)
        expect(isHermesSlashCommand('  /reset  ')).toBe(true)
        expect(isHermesSlashCommand('/model openrouter:openai/gpt-5')).toBe(true)
        expect(isHermesSlashCommand('normal prompt')).toBe(false)
        expect(isHermesSlashCommand('/unknown-command')).toBe(false)
    })

    it('keeps a queued Hermes slash command separate from a following normal prompt', async () => {
        const queue = new MessageQueue2<HermesMode>((mode) => JSON.stringify(mode))
        enqueueHermesUserMessage(queue, '/compact', '/compact', defaultMode, 'cmd-1')
        enqueueHermesUserMessage(queue, 'follow-up question', 'follow-up question', defaultMode, 'msg-2')

        const first = await queue.waitForMessagesAndGetAsString()
        expect(first?.message).toBe('/compact')
        expect(first?.isolate).toBe(true)
        expect(first?.items.map((item) => item.localId)).toEqual(['cmd-1'])

        const second = await queue.waitForMessagesAndGetAsString()
        expect(second?.message).toBe('follow-up question')
        expect(second?.isolate).toBe(false)
        expect(second?.items.map((item) => item.localId)).toEqual(['msg-2'])
    })

    it('keeps an earlier normal prompt separate from a later queued slash command', async () => {
        const queue = new MessageQueue2<HermesMode>((mode) => JSON.stringify(mode))
        enqueueHermesUserMessage(queue, 'first work', 'first work', defaultMode, 'msg-1')
        enqueueHermesUserMessage(queue, '/reset', '/reset', defaultMode, 'cmd-2')
        enqueueHermesUserMessage(queue, 'after reset', 'after reset', defaultMode, 'msg-3')

        const first = await queue.waitForMessagesAndGetAsString()
        expect(first?.message).toBe('first work')
        expect(first?.isolate).toBe(false)

        const second = await queue.waitForMessagesAndGetAsString()
        expect(second?.message).toBe('/reset')
        expect(second?.isolate).toBe(true)

        const third = await queue.waitForMessagesAndGetAsString()
        expect(third?.message).toBe('after reset')
        expect(third?.isolate).toBe(false)
    })
})
