import { describe, expect, it } from 'vitest'
import type { CodexModelSummary } from '@/types/api'
import {
    getCodexModelReasoningEfforts,
    resolveCodexModel,
    supportsCodexReasoningEffort
} from './codexModelCapabilities'

const models: CodexModelSummary[] = [
    {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    },
    {
        id: 'gpt-5.6-luna',
        displayName: 'GPT-5.6-Luna',
        isDefault: false,
        supportedReasoningEfforts: ['LOW', 'medium', 'max', 'max', '  ']
    }
]

describe('Codex model capabilities', () => {
    it('resolves auto and missing model ids to the reported default model', () => {
        expect(resolveCodexModel(models, 'auto')?.id).toBe('gpt-5.6-sol')
        expect(resolveCodexModel(models, null)?.id).toBe('gpt-5.6-sol')
        expect(resolveCodexModel(models, { modelId: 'gpt-5.6-luna' })?.id).toBe('gpt-5.6-luna')
    })

    it('returns normalized, de-duplicated efforts for the selected model', () => {
        expect(getCodexModelReasoningEfforts(models, 'gpt-5.6-luna')).toEqual([
            'low',
            'medium',
            'max'
        ])
    })

    it('distinguishes unsupported efforts from unavailable capability data', () => {
        expect(supportsCodexReasoningEffort(models, 'gpt-5.6-sol', 'ultra')).toBe(true)
        expect(supportsCodexReasoningEffort(models, 'gpt-5.6-luna', 'ultra')).toBe(false)
        expect(supportsCodexReasoningEffort(models, 'unknown', 'ultra')).toBeUndefined()
    })
})
