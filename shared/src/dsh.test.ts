import { describe, expect, it } from 'bun:test'
import {
    DshActionSchema,
    DshApprovalRespondRequestSchema,
    DshFeedbackRequestSchema,
    DshModelsResponseSchema,
    DshStateSnapshotSchema
} from './dsh'

describe('DshActionSchema (allowlisted typed protocol)', () => {
    it('accepts every documented action with its typed payload', () => {
        const valid: unknown[] = [
            { type: 'prompt', mode: 'queue', text: 'hello' },
            { type: 'prompt', mode: 'steer', text: 'now' },
            { type: 'interrupt' },
            { type: 'approval.respond', approvalId: 'a-1', outcome: 'allowed-once' },
            { type: 'approval.respond', approvalId: 'a-1', outcome: 'rejected' },
            { type: 'question.respond', questionRpcId: 'rpc-1', answer: { answers: [{ id: 'q1', selected: ['yes'] }] } },
            { type: 'queue.action', itemId: 'm-1', action: { kind: 'remove' } },
            { type: 'queue.action', itemId: 'm-1', action: { kind: 'steer' } },
            { type: 'queue.action', itemId: 'm-1', action: { kind: 'edit', text: 'edited' } },
            { type: 'model.select', provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high' },
            { type: 'goal', action: 'create', objective: 'ship it', maxGoalRounds: 5 },
            { type: 'goal', action: 'clear', refId: 'g-1', revision: 2 },
            { type: 'subagent', action: 'list' },
            { type: 'subagent', action: 'interrupt', childSessionId: 's-2', mode: 'continuable' },
            { type: 'agentPresets', action: 'list' },
            { type: 'agentPresets', action: 'select', agentPreset: 'standard' },
            { type: 'nativeHistory', beforeSeq: 10, maxMessages: 50 },
            { type: 'fork', atSeq: 42 },
            { type: 'feedback', action: 'put', messageId: 'm-9', rating: 'positive', note: 'nice', ifVersion: null }
        ]
        for (const action of valid) {
            expect(DshActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true)
        }
    })

    it('rejects unknown actions and malformed payloads', () => {
        const invalid: unknown[] = [
            { type: 'not-an-action' },
            { type: 'prompt', mode: 'teleport', text: 'x' },
            { type: 'prompt', mode: 'queue' },
            { type: 'approval.respond', approvalId: 'a-1', outcome: 'allowed-forever' },
            { type: 'queue.action', itemId: 'm-1', action: { kind: 'explode' } },
            { type: 'goal', action: 'create' },
            { type: 'subagent', action: 'prompt', childSessionId: 's-2' },
            { type: 'agentPresets', action: 'select' },
            { type: 'feedback', action: 'put', messageId: 'm-1' },
            { type: 'fork', atSeq: -1 },
            'interrupt',
            null,
            42
        ]
        for (const action of invalid) {
            expect(DshActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(false)
        }
    })

    it('the approval vocabulary matches the official two-outcome client contract', () => {
        const parsed = DshApprovalRespondRequestSchema.safeParse({ approvalId: 'a', outcome: 'allowed-once' })
        expect(parsed.success).toBe(true)
        expect(DshApprovalRespondRequestSchema.safeParse({ approvalId: 'a', outcome: 'unavailable' }).success).toBe(false)
    })

    it('feedback uses the official positive/negative rating vocabulary', () => {
        expect(DshFeedbackRequestSchema.safeParse({ action: 'put', messageId: 'm', rating: 'positive', ifVersion: null }).success).toBe(true)
        expect(DshFeedbackRequestSchema.safeParse({ action: 'put', messageId: 'm', rating: 'up', ifVersion: null }).success).toBe(false)
    })
})

describe('DSH view schemas', () => {
    it('DshModelsResponse accepts the official session.models shape', () => {
        const value = {
            current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
            routable: true,
            groups: [{
                id: 'deepseek-official',
                name: 'DeepSeek',
                models: [{
                    id: 'deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                    efforts: [{ id: 'high', name: 'High', description: 'Deep thinking' }],
                    defaultEffort: 'high'
                }]
            }],
            failures: [{ id: 'other', name: 'Other', message: 'timeout' }]
        }
        expect(DshModelsResponseSchema.safeParse(value).success).toBe(true)
    })

    it('DshStateSnapshot folds queue/jobs/goal/questions', () => {
        const snapshot = {
            seq: 12,
            queue: { items: [{ id: 'q1', placement: 'queued', text: 'hi' }] },
            jobs: { jobs: [{ id: 'bash-1', kind: 'bash', label: 'ls', status: 'running', startedAt: 1 }] },
            goal: { objective: 'ship', status: 'active', revision: 1 },
            questions: { questionRpcId: 'rpc-9', items: [{ id: 'q', question: 'Which?' }] },
            approvals: [{ approvalId: 'a-1', toolName: 'bash' }],
            running: true
        }
        expect(DshStateSnapshotSchema.safeParse(snapshot).success).toBe(true)
    })
})
