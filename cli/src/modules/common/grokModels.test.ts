import { afterEach, describe, expect, test } from 'vitest'
import { buildGrokModelsArgs, parseGrokInitializeModels, parseGrokModelsOutput } from './grokModels'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
})

describe('Grok model discovery', () => {
    test('runs the official model listing command in the selected cwd', () => {
        expect(buildGrokModelsArgs('/home/user/project')).toEqual([
            '--cwd', '/home/user/project', 'models'
        ])
    })

    test('rejects shell metacharacters in a Windows discovery cwd', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

        expect(() => buildGrokModelsArgs('C:\\repo&whoami')).toThrow('Invalid cwd')
    })

    test('parses available and default models from Grok Build output', () => {
        expect(parseGrokModelsOutput(`
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  * custom-fast
`)).toEqual({
            availableModels: [
                { modelId: 'grok-4.5' },
                { modelId: 'custom-fast' }
            ],
            currentModelId: 'grok-4.5'
        })
    })

    test('parses model names and per-model efforts from ACP initialize metadata', () => {
        expect(parseGrokInitializeModels({
            _meta: {
                availableCommands: [{ name: 'auto' }],
                modelState: {
                    currentModelId: 'grok-4.5',
                    availableModels: [{
                        modelId: 'grok-4.5',
                        name: 'Grok 4.5',
                        _meta: {
                            reasoningEfforts: [
                                { value: 'high', label: 'High Effort', default: true },
                                { value: 'low', label: 'Low Effort', default: false }
                            ]
                        }
                    }]
                }
            }
        })).toEqual({
            currentModelId: 'grok-4.5',
            autoPermissionModeSupported: true,
            availableModels: [{
                modelId: 'grok-4.5',
                name: 'Grok 4.5',
                reasoningEfforts: [
                    { value: 'high', name: 'High Effort', isDefault: true },
                    { value: 'low', name: 'Low Effort', isDefault: false }
                ]
            }]
        })
    })
})
