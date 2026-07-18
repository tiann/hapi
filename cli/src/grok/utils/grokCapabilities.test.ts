import { describe, expect, it } from 'vitest'
import { parseGrokCapabilities } from './grokCapabilities'

describe('parseGrokCapabilities', () => {
    it('derives the live model and per-model reasoning efforts from initialize', () => {
        expect(parseGrokCapabilities({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
            _meta: {
                agentVersion: '0.2.93',
                modelState: {
                    currentModelId: 'grok-4.5',
                    availableModels: [{
                        modelId: 'grok-4.5',
                        name: 'Grok 4.5',
                        _meta: {
                            reasoningEfforts: [
                                { id: 'high', label: 'High Effort', default: true },
                                { id: 'low', label: 'Low Effort', default: false }
                            ]
                        }
                    }]
                },
                availableCommands: [{ name: 'compact', description: 'Compact' }]
            }
        })).toMatchObject({
            version: '0.2.93',
            loadSession: true,
            image: false,
            currentModelId: 'grok-4.5',
            currentEffort: 'high',
            models: [{
                id: 'grok-4.5',
                name: 'Grok 4.5',
                efforts: [
                    { id: 'high', label: 'High Effort', isDefault: true },
                    { id: 'low', label: 'Low Effort', isDefault: false }
                ]
            }],
            commands: [{ name: 'compact', description: 'Compact' }]
        })
    })
})
