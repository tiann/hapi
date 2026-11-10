import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgyTranscriptChunkReader, sendAgyTranscriptEntry, stepKindFromType, stepStatusFromType } from './agyTranscript'

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
    return { status: 'DONE', created_at: '2026-11-10T05:00:00Z', ...overrides }
}

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

describe('stepKindFromType', () => {
    it('maps the known transcript step types onto surface kinds', () => {
        expect(stepKindFromType('USER_INPUT')).toBe('user_input')
        expect(stepKindFromType('EPHEMERAL_MESSAGE')).toBe('ephemeral')
        expect(stepKindFromType('PLANNER_RESPONSE')).toBe('planner')
        expect(stepKindFromType('SYSTEM_MESSAGE')).toBe('system')
        expect(stepKindFromType('GENERIC')).toBe('tool')
        expect(stepKindFromType('RUN_COMMAND')).toBe('tool')
        expect(stepKindFromType('SOMETHING_NEW')).toBe('other')
    })
})

describe('stepStatusFromType', () => {
    it('maps transcript status strings', () => {
        expect(stepStatusFromType('DONE')).toBe('done')
        expect(stepStatusFromType('RUNNING')).toBe('running')
        expect(stepStatusFromType('ACTIVE')).toBe('running')
        expect(stepStatusFromType('ERROR')).toBe('error')
        expect(stepStatusFromType('UNKNOWN')).toBe('done')
    })
})

describe('AgyTranscriptChunkReader', () => {
    it('reads appended lines across chunk rotation and emits only new steps', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-transcript-'))
        const reader = new AgyTranscriptChunkReader(dir)

        expect(await reader.readNew()).toEqual([])

        writeFileSync(join(dir, '00000000.jsonl'), JSON.stringify(entry({
            step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>hi</USER_REQUEST>'
        })) + '\n')
        writeFileSync(join(dir, '00000001.jsonl'), JSON.stringify(entry({
            step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'first answer'
        })) + '\n')

        const first = await reader.readNew()
        expect(first).toHaveLength(2)
        expect(first[0]).toMatchObject({ idx: 0, kind: 'user_input', status: 'done' })
        expect(first[1]).toMatchObject({
            idx: 1, kind: 'planner', content: 'first answer', toolCalls: [], createdAt: '2026-11-10T05:00:00Z'
        })

        // Appending to the last chunk surfaces only the appended step.
        writeFileSync(join(dir, '00000001.jsonl'), JSON.stringify(entry({
            step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'first answer'
        })) + '\n' + JSON.stringify(entry({
            step_index: 2, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'task finished'
        })) + '\n')
        const second = await reader.readNew()
        expect(second).toHaveLength(1)
        expect(second[0]).toMatchObject({ idx: 2, kind: 'system', content: 'task finished' })

        // A new chunk file is picked up wholesale.
        writeFileSync(join(dir, '00000002.jsonl'), JSON.stringify(entry({
            step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'next', tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo next' } }]
        })) + '\n')
        const third = await reader.readNew()
        expect(third).toHaveLength(1)
        expect(third[0]).toMatchObject({
            idx: 3, kind: 'planner', content: 'next', toolCalls: [{ name: 'run_command', args: { CommandLine: 'echo next' } }]
        })
    })

    it('parses planner tool calls and tolerates malformed lines', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-transcript-'))
        writeFileSync(join(dir, '00000000.jsonl'), [
            'not json at all',
            JSON.stringify(entry({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'read_file', args: { Path: 'sample.txt' } }] })),
            ''
        ].join('\n'))
        const reader = new AgyTranscriptChunkReader(dir)
        const steps = await reader.readNew()
        expect(steps).toHaveLength(1)
        expect(steps[0]).toMatchObject({ idx: 5, kind: 'planner', toolCalls: [{ name: 'read_file', args: { Path: 'sample.txt' } }] })
    })

    it('keeps reading after a chunk shrank below the tracked offset', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-transcript-'))
        const file = join(dir, '00000000.jsonl')
        writeFileSync(file, JSON.stringify(entry({ step_index: 0, type: 'USER_INPUT', content: 'a'.repeat(400) })) + '\n')
        const reader = new AgyTranscriptChunkReader(dir)
        expect(await reader.readNew()).toHaveLength(1)

        // A rewrite that loses the tracked offset must not wedge the reader.
        writeFileSync(file, JSON.stringify(entry({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'b' })) + '\n')
        const steps = await reader.readNew()
        expect(steps.map((step) => step.idx)).toEqual([1])
    })

    it('returns nothing for a missing transcript directory', async () => {
        const reader = new AgyTranscriptChunkReader(join(tmpdir(), 'agy-transcript-missing-dir'))
        expect(await reader.readNew()).toEqual([])
    })
})

describe('transcript reader fixture', () => {
    it('shapes the synthetic wakeup fixture used by the launcher tests', async () => {
        type FixtureEntry = { step_index: number; type: string; status: string; content?: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> };
        const fixture = await import('@/agent/backends/acp/__fixtures__/agy-bg-wakeup-transcript.json') as { default: FixtureEntry[] };
        const steps = fixture.default.map((raw) => ({
            idx: raw.step_index,
            kind: stepKindFromType(raw.type),
            status: stepStatusFromType(raw.status),
            content: raw.content ?? '',
            toolCalls: raw.tool_calls ?? []
        }))
        expect(steps.map((step) => step.kind)).toEqual(['user_input', 'ephemeral', 'planner', 'tool', 'planner', 'system', 'planner'])
        expect(steps[5]).toMatchObject({ kind: 'system', status: 'done' })
        expect(steps[6].content.length).toBeGreaterThan(0)
    })
})
