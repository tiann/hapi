import { describe, expect, test } from 'vitest'
import { parseCursorModelsOutput } from './cursorModels'

describe('parseCursorModelsOutput', () => {
    test('parses Cursor agent model list output', () => {
        const result = parseCursorModelsOutput(`
Available models

auto - Auto
composer-2.5 - Composer 2.5 (current)
composer-2.5-fast - Composer 2.5 Fast (default)
gpt-5.5-high-fast - GPT-5.5 High Fast

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`)

        expect(result).toEqual({
            availableModels: [
                { modelId: 'auto', name: 'Auto' },
                { modelId: 'composer-2.5', name: 'Composer 2.5' },
                { modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
            ],
            currentModelId: 'composer-2.5'
        })
    })

    test('uses default as current when Cursor output has no current marker', () => {
        const result = parseCursorModelsOutput(`
Available models
composer-2.5-fast - Composer 2.5 Fast (default)
composer-2.5 - Composer 2.5
`)

        expect(result.currentModelId).toBe('composer-2.5-fast')
    })
})
