import { describe, expect, it } from 'vitest'
import { classifyInternalMessage, isExternalUserMessage } from './apiSession'
import { PLAN_FAKE_RESTART } from '../claude/sdk/prompts'

describe('isExternalUserMessage', () => {
    const baseUserMsg = {
        type: 'user' as const,
        uuid: 'test-uuid',
        userType: 'external' as const,
        isSidechain: false,
        message: { role: 'user', content: 'hello' },
    }

    it('returns true for a real user text message', () => {
        expect(isExternalUserMessage(baseUserMsg)).toBe(true)
    })

    it('returns false when isMeta is true (skill injections)', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isMeta: true })).toBe(false)
    })

    it('returns false when isSidechain is true', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isSidechain: true })).toBe(false)
    })

    it('returns false when content is an array (tool results)', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
            } as never)
        ).toBe(false)
    })

    it('returns false for assistant messages', () => {
        expect(
            isExternalUserMessage({
                type: 'assistant',
                uuid: 'test-uuid',
                message: { role: 'assistant', content: 'hi' },
            } as never)
        ).toBe(false)
    })

    // System-injected content detection
    it('returns false for <task-notification> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<task-notification>\n<task-id>abc123</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })

    it('returns false for <command-name> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<command-name>/clear</command-name>' },
            })
        ).toBe(false)
    })

    it('returns false for <local-command-caveat> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' },
            })
        ).toBe(false)
    })

    it('returns false for <system-reminder> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<system-reminder>\nToday is 2026.\n</system-reminder>' },
            })
        ).toBe(false)
    })

    it('returns true for user text that mentions XML-like strings but is not injected', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: 'How do I use the <task-notification> tag?' },
            })
        ).toBe(true)
    })

    it('returns false for <task-notification> with leading whitespace', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '  \n<task-notification>\n<task-id>x</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })
})


describe('classifyInternalMessage', () => {
    const baseUserMsg = {
        type: 'user' as const,
        uuid: 'test-uuid',
        userType: 'external' as const,
        isSidechain: false,
        message: { role: 'user', content: 'hello' },
    }

    it('returns null for a real user text message', () => {
        expect(classifyInternalMessage(baseUserMsg)).toBeNull()
    })

    it('labels task notifications as background_notification', () => {
        expect(classifyInternalMessage({
            ...baseUserMsg,
            message: { role: 'user', content: '  <task-notification><summary>Done</summary></task-notification>' },
        })).toBe('background_notification')
    })

    it('labels plan restart control prompts as internal_plan_restart', () => {
        expect(classifyInternalMessage({
            ...baseUserMsg,
            message: { role: 'user', content: PLAN_FAKE_RESTART },
        })).toBe('internal_plan_restart')
    })

    it('labels tool result arrays as internal_tool_result', () => {
        expect(classifyInternalMessage({
            ...baseUserMsg,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
        } as never)).toBe('internal_tool_result')
    })

    it('labels sidechain and meta user messages without treating them as external users', () => {
        expect(classifyInternalMessage({ ...baseUserMsg, isSidechain: true })).toBe('internal_sidechain')
        expect(classifyInternalMessage({ ...baseUserMsg, isMeta: true })).toBe('internal_meta')
    })

    it('labels other Claude user-role injections by tag', () => {
        expect(classifyInternalMessage({
            ...baseUserMsg,
            message: { role: 'user', content: '<command-name>/clear</command-name>' },
        })).toBe('internal_command_name')
        expect(classifyInternalMessage({
            ...baseUserMsg,
            message: { role: 'user', content: '<local-command-caveat>caveat</local-command-caveat>' },
        })).toBe('internal_local_command_caveat')
        expect(classifyInternalMessage({
            ...baseUserMsg,
            message: { role: 'user', content: '<system-reminder>note</system-reminder>' },
        })).toBe('internal_system_reminder')
    })

    it('does not label real user text that only mentions an internal tag', () => {
        expect(classifyInternalMessage({
            ...baseUserMsg,
            message: { role: 'user', content: 'How do I use the <task-notification> tag?' },
        })).toBeNull()
    })
})
