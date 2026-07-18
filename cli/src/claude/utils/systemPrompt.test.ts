import { describe, expect, it } from 'vitest'
import { systemPrompt, TASK_NOTIFICATION_GUARD } from './systemPrompt'

describe('Claude systemPrompt', () => {
    it('tells Claude that task-notification is an internal background notification, not a user request', () => {
        expect(systemPrompt).toContain('<task-notification>')
        expect(systemPrompt).toContain('internal background task notification')
        expect(systemPrompt).toContain('not a user request')
        expect(systemPrompt).toContain('Do not start new tasks')
        expect(systemPrompt).toContain('wait for a real user message')
    })

    it('keeps the task-notification guard compact', () => {
        expect(TASK_NOTIFICATION_GUARD.length).toBeLessThanOrEqual(390)
    })
})
