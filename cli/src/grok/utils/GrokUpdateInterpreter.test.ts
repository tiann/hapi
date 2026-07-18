import { describe, expect, it } from 'vitest'
import { GrokUpdateInterpreter, type GrokInterpreterEvent } from './GrokUpdateInterpreter'

describe('GrokUpdateInterpreter', () => {
    it('uses one interpretation path for local JSONL and remote ACP updates', () => {
        const events: GrokInterpreterEvent[] = []
        const interpreter = new GrokUpdateInterpreter((event) => events.push(event))

        interpreter.handle('session/update', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } }
        })
        interpreter.handle('session/update', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } }
        })
        interpreter.handle('session/update', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }
        })
        interpreter.handle('_x.ai/session_notification', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }
        })

        expect(events).toEqual([
            { type: 'agent', message: { type: 'user_message', text: 'hello' } },
            { type: 'agent', message: { type: 'reasoning', text: 'think' } },
            { type: 'agent', message: { type: 'text', text: 'answer' } },
            { type: 'agent', message: { type: 'turn_complete', stopReason: 'end_turn' } }
        ])
    })

    it('surfaces config, mode, interaction, retry and unknown events without crashing', () => {
        const events: GrokInterpreterEvent[] = []
        const interpreter = new GrokUpdateInterpreter((event) => events.push(event))

        interpreter.handle('_x.ai/session_notification', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'model_changed', model_id: 'grok-4.5', reasoning_effort: 'medium' }
        })
        interpreter.handle('session/update', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }
        })
        interpreter.handle('_x.ai/session/update', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'retry_state', attempt: 2 }
        })
        interpreter.handle('_x.ai/session_notification', {
            sessionId: 'session-1',
            update: { sessionUpdate: 'pending_interaction', tool_call_id: 'tool-1', kind: 'question' }
        })
        interpreter.handle('_x.ai/future/event', { value: 1 })
        interpreter.handle('_x.ai/session_notification', {
            sessionId: 'session-1', update: { sessionUpdate: 'future_update', payload: 2 }
        })

        expect(events).toEqual([
            { type: 'config', model: 'grok-4.5', effort: 'medium' },
            { type: 'mode', mode: 'plan' },
            { type: 'status', status: 'retry_state', data: { sessionUpdate: 'retry_state', attempt: 2 } },
            { type: 'interaction', status: 'pending', toolCallId: 'tool-1', kind: 'question' },
            { type: 'unknown', method: '_x.ai/future/event', params: { value: 1 } }
            ,{ type: 'unknown', method: '_x.ai/session_notification:future_update', params: { sessionUpdate: 'future_update', payload: 2 } }
        ])
    })
})
