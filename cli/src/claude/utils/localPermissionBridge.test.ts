import { describe, expect, it } from 'vitest'
import type { AgentState } from '@hapi/protocol/schemas'
import type { PermissionHandlerClient } from '@/modules/common/permission/BasePermissionHandler'
import { LocalPermissionBridge } from './localPermissionBridge'
import type { PermissionRequestHook } from './localPermissionProtocol'

const questionInput = {
    questions: [
        { question: 'Which colors?', header: 'Color', multiSelect: true, options: [{ label: 'Blue' }, { label: 'Green' }] },
        { question: 'Which platform?', header: 'Platform', options: [{ label: 'Mac' }, { label: 'Linux' }] }
    ]
}
const question: PermissionRequestHook = {
    hook_event_name: 'PermissionRequest', session_id: 'native-1', prompt_id: 'prompt-1',
    tool_name: 'AskUserQuestion', tool_input: questionInput
}

function setup() {
    let state: AgentState = { controlledByUser: true }
    let reply: (data: unknown) => unknown = () => { throw new Error('No handler') }
    const client: PermissionHandlerClient = {
        updateAgentState: update => { state = update(state) },
        rpcHandlerManager: {
            registerHandler: <TRequest, TResponse>(_method: string, handler: (data: TRequest) => TResponse | Promise<TResponse>) => {
                reply = data => handler(data as TRequest)
            }
        }
    }
    const bridge = new LocalPermissionBridge(client)
    bridge.start('native-1')
    const observe = (id = 'tool-1', data = question) => bridge.onHook({ ...data, hook_event_name: 'PreToolUse', tool_use_id: id })
    const request = (data = question, signal = new AbortController().signal) => bridge.request(data, signal)
    const finish = (result: unknown = {}, id = 'tool-1') => bridge.onHook({ ...question, hook_event_name: 'PostToolUse', tool_use_id: id, tool_response: result })
    return { bridge, observe, request, finish, state: () => state, reply: (data: unknown) => reply(data), id: () => Object.keys(state.requests ?? {})[0] }
}

describe('LocalPermissionBridge', () => {
    it('uses independent reply ids and returns all answers without switching modes or fabricating acceptance', async () => {
        const h = setup()
        h.observe()
        const decision = h.request()
        const id = h.id()
        expect(id).not.toBe('tool-1')
        expect(h.state().requests?.[id]).toMatchObject({ toolCallId: 'tool-1', arguments: questionInput })
        h.reply({ id, approved: true, answers: { '0': ['Blue', 'Green'], '1': ['Custom platform'] } })
        expect(await decision).toEqual({ behavior: 'allow', updatedInput: {
            ...questionInput, answers: { 'Which colors?': 'Blue,Green', 'Which platform?': 'Custom platform' }
        } })
        expect(h.state().requests).toEqual({})
        expect(h.state().completedRequests?.[id]).toBeUndefined()
        expect(h.state().controlledByUser).toBe(true)
        expect(() => h.reply({ id, approved: true })).toThrow('no longer answerable')
        h.finish({ answers: { 'Which colors?': 'Blue,Green', 'Which platform?': 'Custom platform' } })
        expect(h.state().completedRequests?.[id]).toMatchObject({ status: 'approved', answers: { '0': ['Blue,Green'], '1': ['Custom platform'] } })
        h.bridge.stop()
    })

    it('lets the native dialog win and rejects a late web response', async () => {
        const h = setup()
        h.observe()
        const decision = h.request()
        const id = h.id()
        h.finish({ answers: { 'Which colors?': 'Green', 'Which platform?': 'Linux' } })
        expect(await decision).toBeNull()
        expect(() => h.reply({ id, approved: true, answers: { '0': ['Blue'] } })).toThrow('no longer answerable')
        expect(h.state().completedRequests?.[id]?.answers).toEqual({ '0': ['Green'], '1': ['Linux'] })
        h.bridge.stop()
    })

    it('uses the actual native result even if it differs from the submitted web answer', async () => {
        const h = setup()
        h.observe()
        const decision = h.request()
        const id = h.id()
        h.reply({ id, approved: true, answers: { '0': ['Blue'], '1': ['Mac'] } })
        await decision
        h.finish({ answers: { 'Which colors?': 'Green', 'Which platform?': 'Linux' } })
        expect(h.state().completedRequests?.[id]?.answers).toEqual({ '0': ['Green'], '1': ['Linux'] })
        h.bridge.stop()
    })

    it('detects Esc cancellation from the transcript even without completion hooks', async () => {
        const h = setup()
        h.observe()
        const decision = h.request()
        const id = h.id()
        h.bridge.onTranscript({ type: 'user', sessionId: 'native-1', message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'User declined' }]
        } })
        expect(await decision).toBeNull()
        expect(h.state().requests).toEqual({})
        expect(h.state().completedRequests?.[id]?.status).toBe('canceled')
        h.bridge.stop()
    })

    it('continues observing native answers after the remote wait expires', async () => {
        const h = setup()
        const controller = new AbortController()
        h.observe()
        const decision = h.request(question, controller.signal)
        const id = h.id()
        controller.abort()
        expect(await decision).toBeNull()
        expect(h.state().requests).toEqual({})
        expect(h.state().completedRequests?.[id]).toBeUndefined()
        expect(() => h.reply({ id, approved: false })).toThrow('no longer answerable')
        h.bridge.onTranscript({ type: 'user', sessionId: 'native-1', message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Native answer' }]
        }, toolUseResult: { answers: { 'Which colors?': 'Green', 'Which platform?': 'Linux' } } })
        expect(h.state().completedRequests?.[id]).toMatchObject({
            status: 'approved', answers: { '0': ['Green'], '1': ['Linux'] }
        })
        h.bridge.stop()
    })

    it('ignores subagent/foreign completions and duplicate permission hooks', async () => {
        const h = setup()
        h.observe()
        const decision = h.request()
        const id = h.id()
        expect(await h.request()).toBeNull()
        h.bridge.onHook({ ...question, hook_event_name: 'PostToolUse', tool_use_id: 'tool-1', agent_id: 'child' })
        for (const identity of [{ isSidechain: true }, { sessionId: 'foreign' }]) {
            h.bridge.onTranscript({ ...identity, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } })
        }
        expect(h.state().requests?.[id]).toBeDefined()
        h.bridge.stop()
        expect(await decision).toBeNull()
    })

    it('does not intercept plan transitions or unsupported question shapes', async () => {
        const h = setup()
        const unsupported = [
            { ...question, tool_name: 'ExitPlanMode', tool_input: {} },
            { ...question, tool_input: { questions: [] } },
            { ...question, tool_input: { questions: [{ question: 'Duplicate' }, { question: 'Duplicate' }] } }
        ]
        for (const [i, data] of unsupported.entries()) {
            h.observe(`tool-${i}`, data)
            expect(await h.request(data)).toBeNull()
        }
        h.bridge.stop()
    })

    it.each(['abort', 'stop', 'session', 'prompt'] as const)('releases the hook without granting permission on %s', async cause => {
        const h = setup()
        const controller = new AbortController()
        h.observe()
        const decision = h.request(question, controller.signal)
        const id = h.id()
        if (cause === 'abort') controller.abort()
        if (cause === 'stop') h.bridge.stop()
        if (cause === 'session') h.bridge.onHook({ session_id: 'native-2', hook_event_name: 'SessionStart' })
        if (cause === 'prompt') h.bridge.onHook({ session_id: 'native-1', hook_event_name: 'UserPromptSubmit' })
        expect(await decision).toBeNull()
        expect(h.state().requests).toEqual({})
        expect(() => h.reply({ id, approved: true })).toThrow()
        h.bridge.stop()
    })

    it('does not let old cancellation or replies affect a later local activation', async () => {
        const h = setup()
        const controller = new AbortController()
        h.observe()
        const old = h.request(question, controller.signal)
        const oldId = h.id()
        h.bridge.stop()
        expect(await old).toBeNull()
        h.bridge.start('native-1')
        h.observe()
        const next = h.request()
        const nextId = h.id()
        expect(nextId).not.toBe(oldId)
        controller.abort()
        expect(() => h.reply({ id: oldId, approved: false })).toThrow()
        expect(h.state().requests?.[nextId]).toBeDefined()
        h.bridge.stop()
        expect(await next).toBeNull()
    })

    it('handles /clear followed by SessionStart without relaunching the local process', async () => {
        const h = setup()
        h.observe()
        const previous = h.request()
        const previousId = h.id()
        h.bridge.onHook({ session_id: 'native-1', hook_event_name: 'SessionEnd', reason: 'clear' })
        expect(await previous).toBeNull()
        h.bridge.onHook({ session_id: 'native-2', hook_event_name: 'SessionStart', source: 'clear' })
        const nextQuestion = { ...question, session_id: 'native-2' }
        h.observe('tool-2', nextQuestion)
        const next = h.request(nextQuestion)
        expect(h.id()).not.toBe(previousId)
        expect(h.state().requests?.[h.id()]?.toolCallId).toBe('tool-2')
        expect(() => h.reply({ id: previousId, approved: false })).toThrow()
        h.bridge.stop()
        expect(await next).toBeNull()
    })

    it('passes through subagents, foreign sessions, unobserved and ambiguous calls', async () => {
        const h = setup()
        expect(await h.request()).toBeNull()
        h.observe()
        expect(await h.request({ ...question, agent_id: 'background' })).toBeNull()
        expect(await h.request({ ...question, session_id: 'foreign' })).toBeNull()
        expect(await h.request({ ...question, prompt_id: 'other-prompt' })).toBeNull()
        expect(await h.request({ ...question, tool_input: { ...questionInput, questions: { ...questionInput.questions } } })).toBeNull()
        h.observe('tool-2')
        expect(await h.request()).toBeNull()
        expect(h.state().requests).toEqual({})
        h.bridge.stop()
    })

    it('retains the question on malformed/partial answers and accepts an explicit rejection', async () => {
        const h = setup()
        h.observe()
        const decision = h.request()
        const id = h.id()
        expect(() => h.reply({ id, approved: true, answers: { '0': ['Blue'] } })).toThrow('every question')
        expect(() => h.reply({ id, approved: true, answers: { '0': [] } })).toThrow()
        expect(h.state().requests?.[id]).toBeDefined()
        h.reply({ id, approved: false })
        expect(await decision).toMatchObject({ behavior: 'deny' })
        h.bridge.stop()
    })

    it('forwards explicitly requested native session-scoped permissions', async () => {
        const h = setup()
        const bash = { ...question, tool_name: 'Bash', tool_input: { command: 'bun test' } }
        h.observe('tool-1', bash)
        const decision = h.request(bash)
        h.reply({ id: h.id(), approved: true, mode: 'acceptEdits', allowTools: ['Bash(bun test:*)'] })
        expect(await decision).toEqual({ behavior: 'allow', updatedInput: bash.tool_input, updatedPermissions: [
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
            { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'bun test:*' }], behavior: 'allow', destination: 'session' }
        ] })
        h.bridge.stop()
    })
})
