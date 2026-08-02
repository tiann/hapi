import { describe, expect, it } from 'vitest'
import { _parseAgyModelsOutputForTests } from './agyModels'

describe('parseAgyModelsOutput', () => {
    it('parses agy 1.1.5 id and display-name columns without duplicating the id', () => {
        expect(_parseAgyModelsOutputForTests([
            'gemini-3.6-flash-high     Gemini 3.6 Flash (High)',
            'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)'
        ].join('\r\n'))).toEqual([
            { modelId: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)' },
            { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }
        ])
    })

    it('keeps legacy display-name-only output compatible', () => {
        expect(_parseAgyModelsOutputForTests('Gemini 3.5 Flash (High)\n')).toEqual([
            { modelId: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)' }
        ])
    })

    it('accepts raw model ids from non-tty output', () => {
        expect(_parseAgyModelsOutputForTests('gemini-3.6-flash-high\ngemini-3.6-flash-low\n')).toEqual([
            { modelId: 'gemini-3.6-flash-high' },
            { modelId: 'gemini-3.6-flash-low' }
        ])
    })
})
