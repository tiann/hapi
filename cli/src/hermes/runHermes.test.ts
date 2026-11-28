import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import {
    createHermesModelPreferenceController,
    enqueueHermesUserMessage,
    isHermesSlashCommand
} from './runHermes'
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

describe('createHermesModelPreferenceController', () => {
    it('ignores stale rollback and startup discovery updates after a newer model preference is applied', () => {
        const synced: Array<string | null> = []
        const controller = createHermesModelPreferenceController('model-a', (model) => {
            synced.push(model)
        })

        expect(controller.getRevision()).toBe(0)
        // Simulate user selecting model-b while model-a or startup discovery is in flight.
        const revB = controller.applyConfigModel('model-b')
        expect(revB).toBe(1)
        expect(controller.getModel()).toBe('model-b')

        // Stale discovery from rev 0 must not overwrite model-b.
        expect(controller.applyDiscoveredModel('discovered-default', 0)).toBe(false)
        expect(controller.getModel()).toBe('model-b')

        // Stale rollback from rev 0 must not clobber model-b.
        expect(controller.rollbackModel('model-a', 0)).toBe(false)
        expect(controller.getModel()).toBe('model-b')
        expect(synced).toEqual([])

        // Matching revision rollback still restores cleanly and syncs.
        expect(controller.rollbackModel('model-a', revB)).toBe(true)
        expect(controller.getModel()).toBe('model-a')
        expect(synced).toEqual(['model-a'])

        // Backend-driven /model change advances revision and syncs new model.
        const revSlash = controller.applyBackendModelChange('model-c')
        expect(revSlash).toBe(2)
        expect(controller.getModel()).toBe('model-c')
        expect(synced).toEqual(['model-a', 'model-c'])
    })
})
