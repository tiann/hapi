import { describe, expect, it, vi } from 'vitest'
import { sendAgyTranscriptEntry } from './agyTranscript'

function fakeClient() {
    return { sendClaudeSessionMessage: vi.fn(), sendUserMessage: vi.fn() }
}

describe('sendAgyTranscriptEntry', () => {
    it('renders only the USER_REQUEST body, not the sections agy appends', () => {
        const client = fakeClient()

        // The shape agy actually writes for every terminal-typed message.
        sendAgyTranscriptEntry(client as never, {
            type: 'USER_INPUT',
            content: [
                '<USER_REQUEST>',
                'hi',
                '</USER_REQUEST>',
                '<ADDITIONAL_METADATA>',
                'The current local time is: 2026-08-04T09:00:00+09:00.',
                '</ADDITIONAL_METADATA>',
                '<USER_SETTINGS_CHANGE>',
                'The user changed setting `Model Selection` from None to Gemini 3.6 Flash (Low).',
                '</USER_SETTINGS_CHANGE>',
            ].join('\n'),
        })

        expect(client.sendUserMessage).toHaveBeenCalledWith('hi')
        expect(client.sendClaudeSessionMessage).not.toHaveBeenCalled()
    })

    it('sends planner prose as agy_message with the turn model', () => {
        const client = fakeClient()

        sendAgyTranscriptEntry(client as never, { type: 'PLANNER_RESPONSE', content: 'OK', model: 'Gemini 3.7 Flash (Low)' })

        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith({
            type: 'agy_message',
            content: 'OK',
            model: 'Gemini 3.7 Flash (Low)'
        })
    })

    it('sends tool actions as agy_tool_action keyed by conversation and step', () => {
        const client = fakeClient()

        sendAgyTranscriptEntry(
            client as never,
            { type: 'RUN_COMMAND', content: 'hi\n', step_index: 3 },
            'conv-1',
            { name: 'run_command', args: { CommandLine: 'echo hi' } }
        )

        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith({
            type: 'agy_tool_action',
            name: 'RUN_COMMAND',
            content: 'hi\n',
            toolUseId: 'conv-1:3',
            toolName: 'run_command',
            input: { CommandLine: 'echo hi' }
        })
    })
})
