import { AGY_MODEL_LABELS } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import { buildAgyModelNavigationKeys, buildAgyModelPickerTarget, findAgyCurrentModelRow } from './agyModelKeys'

describe('buildAgyModelPickerTarget', () => {
    // Every id is listed: a row that no case pins can drift out of step with
    // the picker on its own, and a partial shift is silent until a live model
    // change lands on the wrong row.
    it.each([
        ['gemini-3.7-flash-high', 0, 2, 'Gemini 3.7 Flash (High)'],
        ['gemini-3.7-flash-medium', 0, 1, 'Gemini 3.7 Flash (Medium)'],
        ['gemini-3.7-flash-low', 0, 0, 'Gemini 3.7 Flash (Low)'],
        ['gemini-3.6-flash-high', 1, 2, 'Gemini 3.6 Flash (High)'],
        ['gemini-3.6-flash-medium', 1, 1, 'Gemini 3.6 Flash (Medium)'],
        ['gemini-3.6-flash-low', 1, 0, 'Gemini 3.6 Flash (Low)'],
        ['gemini-3.5-flash-high', 2, 2, 'Gemini 3.5 Flash (High)'],
        ['gemini-3.5-flash-medium', 2, 1, 'Gemini 3.5 Flash (Medium)'],
        ['gemini-3.5-flash-low', 2, 0, 'Gemini 3.5 Flash (Low)'],
        ['gemini-3.1-pro-high', 3, 2, 'Gemini 3.1 Pro (High)'],
        ['gemini-3.1-pro-low', 3, 0, 'Gemini 3.1 Pro (Low)'],
        ['claude-sonnet-4-6', 4, null, 'Claude Sonnet 4.6 (Thinking)'],
        ['claude-opus-4-6-thinking', 5, null, 'Claude Opus 4.6 (Thinking)'],
        ['gpt-oss-120b-medium', 6, null, 'GPT-OSS 120B (Medium)'],
    ] as const)('maps %s to the verified AGY 1.1.13 picker row', (modelId, row, effort, label) => {
        expect(buildAgyModelPickerTarget(modelId)).toEqual({ row, effort, label })
    })

    it('rejects null and unknown future picker rows', () => {
        expect(() => buildAgyModelPickerTarget(null)).toThrow('Live AGY model reset is not supported')
        expect(() => buildAgyModelPickerTarget('gemini-9-future')).toThrow('Unsupported live AGY model')
    })
})

describe('AGY model picker navigation', () => {
    it('finds the current row and moves relatively without relying on Home', () => {
        // The expected values are MODEL_ROWS indices, not fixture line numbers:
        // the fixture only lists the three rows around the current one.
        const picker = [
            '  Gemini 3.6 Flash',
            '> Gemini 3.5 Flash             (current)',
            '  Gemini 3.1 Pro',
        ].join('\n')
        const target = buildAgyModelPickerTarget('gemini-3.6-flash-low')

        expect(findAgyCurrentModelRow(picker)).toBe(2)
        expect(findAgyCurrentModelRow(picker.replaceAll('\n', ''))).toBe(2)
        expect(buildAgyModelNavigationKeys(target, 2)).toBe(`\x1b[A${'\x1b[D'.repeat(3)}`)
    })

    it('moves down from the current row and does not move vertically for the same row', () => {
        const target = buildAgyModelPickerTarget('gemini-3.1-pro-high')
        expect(buildAgyModelNavigationKeys(target, 1)).toBe(`${'\x1b[B'.repeat(2)}${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(2)}`)
        expect(buildAgyModelNavigationKeys(target, 3)).toBe(`${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(2)}`)
    })

    it('fails closed when the picker does not identify its current row', () => {
        expect(findAgyCurrentModelRow('Switch Model\n  Gemini 3.6 Flash')).toBeNull()
    })

    it('identifies row 0 when agy starts a session on its new Gemini 3.7 Flash default', () => {
        // Real `/model` picker capture (stripTerminalControlSequences output,
        // single line, no newlines) with agy 1.1.13's new default current model.
        const picker = 'Switch Model> Gemini 3.7 Flash  (current)  Gemini 3.6 Flash  Gemini 3.5 Flash  Gemini 3.1 Pro  Claude Sonnet 4.6 (Thinking)  Claude Opus 4.6 (Thinking)  GPT-OSS 120B (Medium)  Effort'
        expect(findAgyCurrentModelRow(picker)).toBe(0)
    })

    it('keeps the delta between pre-existing rows unchanged after the 3.7 row was inserted at the top', () => {
        // gemini-3.6-flash-low is row 1 and gemini-3.5-flash-high is row 2. The
        // +1 shift from adding the 3.7 row moved both uniformly, so the delta
        // between them, and therefore the emitted key sequence, is unchanged.
        const from = buildAgyModelPickerTarget('gemini-3.6-flash-low')
        const to = buildAgyModelPickerTarget('gemini-3.5-flash-high')
        expect(buildAgyModelNavigationKeys(to, from.row)).toBe(`${'\x1b[B'.repeat(1)}${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(2)}`)
    })
})

describe('AGY model table consistency', () => {
    it('has a picker target for every model AGY_MODEL_LABELS advertises, with a matching label', () => {
        // A model offered by the pickers but missing here would only fail once
        // a user actually tried to switch to it mid-session.
        for (const [modelId, label] of Object.entries(AGY_MODEL_LABELS)) {
            expect(buildAgyModelPickerTarget(modelId).label, `picker target for ${modelId}`).toBe(label)
        }
    })
})
