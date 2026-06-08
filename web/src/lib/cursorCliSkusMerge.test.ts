import { describe, expect, it } from 'vitest'
import { mergeCursorCliModelSkus } from '@/lib/cursorPickerState'

describe('mergeCursorCliModelSkus', () => {
    it('prefers the richer source and unions ids without duplicates', () => {
        const partial = [
            { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
            { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' }
        ]
        const full = [
            ...partial,
            { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
            { modelId: 'gpt-5.5-high', name: 'GPT-5.5 High' }
        ]

        expect(mergeCursorCliModelSkus(partial, full).map((row) => row.modelId)).toEqual([
            'gpt-5.5-high-fast',
            'gpt-5.5-low',
            'gpt-5.5-medium',
            'gpt-5.5-high'
        ])
    })

    it('prefers the richer source name for duplicate model ids', () => {
        const machine = [{ modelId: 'gpt-5.5-medium', name: 'From Machine' }]
        const session = [{ modelId: 'gpt-5.5-medium', name: 'From Session' }]

        expect(mergeCursorCliModelSkus(machine, session)).toEqual([
            { modelId: 'gpt-5.5-medium', name: 'From Machine' }
        ])
    })
})
