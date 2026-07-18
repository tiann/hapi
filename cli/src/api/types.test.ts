import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import { AgentMessageSchema, MessageContentSchema } from './types'

describe('AgentMessageSchema', () => {
    it('accepts legacy output agent messages', () => {
        expect(AgentMessageSchema.safeParse({
            role: 'agent',
            content: {
                type: 'output',
                data: { text: 'hello' }
            },
            meta: { sentFrom: 'cli' }
        }).success).toBe(true)
    })

    it('accepts Codex agent payload messages emitted by ApiSessionClient.sendAgentMessage', () => {
        expect(AgentMessageSchema.safeParse({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'thread.started' }
            },
            meta: { sentFrom: 'cli' }
        }).success).toBe(true)
    })

    it('accepts and preserves explicit internal messageKind metadata', () => {
        const parsedBackground = AgentMessageSchema.safeParse({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'user' }
            },
            meta: { sentFrom: 'cli', messageKind: 'background_notification' }
        })
        expect(parsedBackground.success).toBe(true)
        expect(parsedBackground.success ? parsedBackground.data.meta?.messageKind : null).toBe('background_notification')

        const parsedToolResult = AgentMessageSchema.safeParse({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'user' }
            },
            meta: { sentFrom: 'cli', messageKind: 'internal_tool_result' }
        })
        expect(parsedToolResult.success).toBe(true)
        expect(parsedToolResult.success ? parsedToolResult.data.meta?.messageKind : null).toBe('internal_tool_result')

        const parsedPlanRestart = AgentMessageSchema.safeParse({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'user' }
            },
            meta: { sentFrom: 'cli', messageKind: 'internal_plan_restart' }
        })
        expect(parsedPlanRestart.success).toBe(true)
        expect(parsedPlanRestart.success ? parsedPlanRestart.data.meta?.messageKind : null).toBe('internal_plan_restart')
    })

    it('keeps rejecting unknown agent payload types', () => {
        expect(AgentMessageSchema.safeParse({
            role: 'agent',
            content: {
                type: 'unknown',
                data: {}
            }
        }).success).toBe(false)
    })

    it('allows Codex agent payloads through MessageContentSchema', () => {
        expect(MessageContentSchema.safeParse({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'turn.done' }
            }
        }).success).toBe(true)
    })
})
