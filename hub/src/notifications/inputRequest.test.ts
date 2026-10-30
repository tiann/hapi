import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { composeInputRequestNotification, formatInputRequestPreview, getFirstPendingRequest, isInputRequestTool } from './inputRequest'
import { NativeNotificationComposer } from './nativeNotificationComposer'
import { formatToolArgumentsCompact, formatToolArgumentsDetailed } from './toolArgs'

function session(args: unknown, tool = 'request_user_input', name = '查看 PR #1842 的改动'): Session {
    return {
        id: 'session-1', active: true, namespace: 'default',
        seq: 1, createdAt: 0, updatedAt: 0, activeAt: 0,
        metadataVersion: 0, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        model: null, modelReasoningEffort: null, effort: null, serviceTier: null,
        metadata: { name, flavor: 'codex', path: '/project', host: 'test' },
        agentState: { requests: { 'request-map-key': { tool, toolCallId: 'different-tool-id', arguments: args } } }
    }
}

describe('input request notifications', () => {
    it.each(['request_user_input', 'AskUserQuestion', 'ask_user_question', 'CursorAskQuestion', 'functions.request_user_input'])(
        'recognizes %s as a question, not approval', (tool) => {
            expect(isInputRequestTool(tool)).toBe(true)
            const notification = new NativeNotificationComposer().composePermissionRequest(session({
                threadId: 'internal-thread', turnId: 'internal-turn', itemId: 'internal-item',
                questions: [{ id: 'internal-question', question: '需要检查安全性吗？', header: '安全性',
                    options: [{ label: 'private-option', description: 'private-description' }], prefill: 'private-prefill' }]
            }, tool))
            expect(notification).toEqual({
                type: 'input-request', title: 'Codex needs your input',
                body: '需要检查安全性吗？\n查看 PR #1842 的改动',
                sessionId: 'session-1', sessionName: '查看 PR #1842 的改动',
                requestId: 'request-map-key', url: '/sessions/session-1',
                tag: 'input-request-session-1', severity: 'info'
            })
        }
    )

    it.each(['ExitPlanMode', 'exit_plan_mode', 'Bash', 'Edit', 'request_user_input_async', 'mcp__server__request_user_input', 'other.request_user_input'])(
        'keeps %s out of question classification', (tool) => {
            expect(isInputRequestTool(tool)).toBe(false)
            expect(composeInputRequestNotification(session({}, tool))).toBeNull()
            expect(new NativeNotificationComposer().composePermissionRequest(session({}, tool)).type).toBe('permission-request')
        }
    )

    it('shows only the first readable question, then the remaining question count', () => {
        expect(formatInputRequestPreview({ questions: [null, {}, 3, { question: '  第一题\n\t内容  ' },
            { question: '', header: ' 第二题标题 ' }, { question: '第三题' }] })).toBe('第一题 内容\n+2 more questions')
        expect(formatInputRequestPreview({ questions: [{ question: 'First?' }, { question: 'Second?' }] }))
            .toBe('First?\n+1 more question')
    })

    it.each([null, undefined, [], 'raw arguments', 3, {}, { questions: 'invalid' },
        { questions: [null, [], { question: 3, header: false, id: 'internal-id', prefill: 'secret' }] }].map(args => ({ args })))(
        'uses a safe fallback for malformed input %#', ({ args }) => {
            const expected = 'Open the session to view and answer the question.'
            expect(formatInputRequestPreview(args)).toBe(expected)
            expect(formatToolArgumentsDetailed('request_user_input', args)).toBe(expected)
            expect(formatToolArgumentsCompact('request_user_input', args)).toBe(expected)
        }
    )

    it('reserves room for context and count without breaking graphemes', () => {
        const emoji = '👩🏽‍💻'
        const notification = composeInputRequestNotification(session({ questions: [
            { question: emoji.repeat(150) }, { question: 'Second?' }
        ] }, 'request_user_input', '会话'.repeat(100)))!
        expect(Array.from(notification.body).length).toBeLessThanOrEqual(280)
        expect(Array.from(notification.sessionName).length).toBeLessThanOrEqual(80)
        const [preview, count, context] = notification.body.split('\n')
        expect(preview).toMatch(/^(👩🏽‍💻)+…$/u)
        expect(count).toBe('+1 more question')
        expect(context).toBe(notification.sessionName)
        expect(formatInputRequestPreview({ questions: [{ question: 'e\u0301'.repeat(50) }] }, 6)).toBe('e\u0301e\u0301…')
    })

    it('makes compact/detailed tool previews question-aware without leaking options', () => {
        const args = { threadId: 'private-id', questions: [
            { question: '中'.repeat(200), options: [{ label: 'private-option' }] }, { question: 'More?' }
        ] }
        const compact = formatToolArgumentsCompact('request_user_input', args)
        const detailed = formatToolArgumentsDetailed('request_user_input', args, { maxArgLength: 120 })
        expect(compact).not.toContain('\n')
        expect(Array.from(compact).length).toBeLessThanOrEqual(60)
        expect(Array.from(detailed).length).toBeLessThanOrEqual(120)
        expect(detailed).toEndWith('\n+1 more question')
        expect(`${compact}${detailed}`).not.toContain('private')
        expect(formatInputRequestPreview(args, 0)).toBe('')
    })

    it('does not change request selection or mutate the source arguments', () => {
        const source = session({ questions: [{ question: 'First?' }] })
        source.agentState!.requests!['second-request'] = { tool: 'Bash', arguments: { command: 'echo second' } }
        const before = JSON.stringify(source)
        expect(getFirstPendingRequest(source)?.requestId).toBe('request-map-key')
        expect(composeInputRequestNotification(source)?.requestId).toBe('request-map-key')
        expect(JSON.stringify(source)).toBe(before)
        source.agentState!.requests = { approval: { tool: 'Bash', arguments: {} }, ...source.agentState!.requests }
        expect(composeInputRequestNotification(source)).toBeNull()
        expect(getFirstPendingRequest({ ...source, agentState: null })).toBeNull()
    })
})
