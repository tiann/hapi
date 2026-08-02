import { describe, expect, it } from 'vitest'
import { buildAgyModelNavigationKeys, buildAgyModelPickerTarget, findAgyCurrentModelRow } from './agyModelKeys'

describe('buildAgyModelPickerTarget', () => {
    it.each([
        ['gemini-3.6-flash-high', 0, 2, 'Gemini 3.6 Flash (High)'],
        ['gemini-3.5-flash-low', 1, 0, 'Gemini 3.5 Flash (Low)'],
        ['gemini-3.1-pro-high', 2, 2, 'Gemini 3.1 Pro (High)'],
        ['claude-sonnet-4-6', 3, null, 'Claude Sonnet 4.6 (Thinking)'],
        ['claude-opus-4-6-thinking', 4, null, 'Claude Opus 4.6 (Thinking)'],
        ['gpt-oss-120b-medium', 5, null, 'GPT-OSS 120B (Medium)'],
    ] as const)('maps %s to the verified AGY 1.1.5 picker row', (modelId, row, effort, label) => {
        expect(buildAgyModelPickerTarget(modelId)).toEqual({ row, effort, label })
    })

    it('rejects null and unknown future picker rows', () => {
        expect(() => buildAgyModelPickerTarget(null)).toThrow('Live AGY model reset is not supported')
        expect(() => buildAgyModelPickerTarget('gemini-9-future')).toThrow('Unsupported live AGY model')
    })
})

describe('AGY model picker navigation', () => {
    it('finds the current row and moves relatively without relying on Home', () => {
        const picker = [
            '  Gemini 3.6 Flash',
            '> Gemini 3.5 Flash             (current)',
            '  Gemini 3.1 Pro',
        ].join('\n')
        const target = buildAgyModelPickerTarget('gemini-3.6-flash-low')

        expect(findAgyCurrentModelRow(picker)).toBe(1)
        expect(findAgyCurrentModelRow(picker.replaceAll('\n', ''))).toBe(1)
        expect(buildAgyModelNavigationKeys(target, 1)).toBe(`\x1b[A${'\x1b[D'.repeat(3)}`)
    })

    it('moves down from the current row and does not move vertically for the same row', () => {
        const target = buildAgyModelPickerTarget('gemini-3.1-pro-high')
        expect(buildAgyModelNavigationKeys(target, 0)).toBe(`${'\x1b[B'.repeat(2)}${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(2)}`)
        expect(buildAgyModelNavigationKeys(target, 2)).toBe(`${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(2)}`)
    })

    it('fails closed when the picker does not identify its current row', () => {
        expect(findAgyCurrentModelRow('Switch Model\n  Gemini 3.6 Flash')).toBeNull()
    })
})
