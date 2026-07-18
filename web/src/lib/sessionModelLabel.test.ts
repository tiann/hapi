import { describe, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_MODEL_LABEL } from '@hapi/protocol'
import { getSessionEffortLabel, getSessionModelLabel } from './sessionModelLabel'

describe('getSessionModelLabel', () => {
    it('prefers the explicit session model', () => {
        expect(getSessionModelLabel({ model: 'gpt-5.4' })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.4'
        })
    })

    it('renders friendly labels for known Claude aliases', () => {
        expect(getSessionModelLabel({ model: 'fable' })).toEqual({
            key: 'session.item.model',
            value: 'Fable 5 · 1M'
        })

        expect(getSessionModelLabel({ model: 'opus' })).toEqual({
            key: 'session.item.model',
            value: 'Opus 4.8 · 1M'
        })
    })

    it('renders friendly labels for known Ark Coding Plan models', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'claude-ark' },
            model: 'deepseek-v4-pro'
        })).toEqual({
            key: 'session.item.model',
            value: 'DeepSeek V4 Pro · 1M'
        })

        expect(getSessionModelLabel({
            metadata: { flavor: 'claude-ark' },
            model: ' doubao-seed-2.0-code '
        })).toEqual({
            key: 'session.item.model',
            value: 'Doubao Seed 2.0 Code'
        })
    })

    it('renders friendly labels for CC-deepseek models', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'claude-deepseek' },
            model: 'deepseek-v4-pro[1m]'
        })).toEqual({
            key: 'session.item.model',
            value: 'DeepSeek V4 Pro · 1M'
        })
        expect(getSessionModelLabel({
            metadata: { flavor: 'claude-deepseek' },
            model: 'deepseek-v4-flash'
        })).toEqual({
            key: 'session.item.model',
            value: 'DeepSeek V4 Flash · 1M'
        })
    })


    it('renders friendly labels for known CC-api models', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'cc-api' },
            model: 'doubao-seed-2.1-pro'
        })).toEqual({
            key: 'session.item.model',
            value: 'Doubao Seed 2.1 Pro · 256K'
        })

        expect(getSessionModelLabel({
            metadata: { flavor: 'cc-api' },
            model: 'glm-5.2[1m]'
        })).toEqual({
            key: 'session.item.model',
            value: 'GLM 5.2 · 1M'
        })

        expect(getSessionModelLabel({
            metadata: { flavor: 'cc-api' },
            model: 'glm-5.2'
        })).toEqual({
            key: 'session.item.model',
            value: 'GLM 5.2 · 1M'
        })

        expect(getSessionModelLabel({
            metadata: { flavor: 'cc-api' },
            model: ' kimi-k3 '
        })).toEqual({
            key: 'session.item.model',
            value: 'Kimi K3 · 1M'
        })
    })

    it('renders friendly labels for Hermes MoA presets', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'hermes-moa' },
            model: 'default'
        })).toEqual({
            key: 'session.item.model',
            value: 'Opus 4.8 · 1M · Max'
        })

        expect(getSessionModelLabel({
            metadata: { flavor: 'hermes-moa' },
            model: ' fable-5-1m-max '
        })).toEqual({
            key: 'session.item.model',
            value: 'Fable 5 · 1M · Max'
        })

        expect(getSessionModelLabel({
            metadata: { flavor: 'hermes-moa' },
            model: 'gpt-5.5-xhigh'
        })).toEqual({
            key: 'session.item.model',
            value: 'GPT-5.5 · 272K · XHigh'
        })

        expect(getSessionModelLabel({
            metadata: { flavor: 'hermes-moa' },
            model: 'gpt-5.6-sol-max'
        })).toEqual({
            key: 'session.item.model',
            value: 'GPT-5.6 Sol · 372K · Max'
        })
    })

    it('returns null when no model is available', () => {
        expect(getSessionModelLabel({})).toBeNull()
    })

    it('shows the default Claude model label when a Claude session has no explicit model', () => {
        const claudeSession = {
            metadata: { flavor: 'claude' }
        } as Parameters<typeof getSessionModelLabel>[0]

        expect(getSessionModelLabel(claudeSession)).toEqual({
            key: 'session.item.model',
            value: DEFAULT_CLAUDE_MODEL_LABEL
        })
    })

    it('normalizes Claude auto/default model aliases to the default Claude label', () => {
        expect(getSessionModelLabel({ model: 'auto', metadata: { flavor: 'claude' } })).toEqual({
            key: 'session.item.model',
            value: DEFAULT_CLAUDE_MODEL_LABEL
        })
        expect(getSessionModelLabel({ model: 'default', metadata: { flavor: 'claude' } })).toEqual({
            key: 'session.item.model',
            value: DEFAULT_CLAUDE_MODEL_LABEL
        })
    })

    it('appends Codex reasoning effort and service tier after the model name', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'codex' },
            model: 'gpt-5.5',
            modelReasoningEffort: 'xhigh',
            serviceTier: 'fast'
        })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.5 · XHigh · Fast'
        })
    })

    it('renders Codex max reasoning effort after GPT-5.6 model names', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'codex' },
            model: 'gpt-5.6-sol',
            modelReasoningEffort: 'max',
            serviceTier: 'fast'
        })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.6-sol · Max · Fast'
        })
    })

    it('renders Codex ultra reasoning effort after GPT-5.6 model names', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'codex' },
            model: 'gpt-5.6-terra',
            modelReasoningEffort: 'ultra'
        })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.6-terra · Ultra'
        })
    })

    it('normalizes Codex priority service tier to Fast in the model label', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'codex' },
            model: 'gpt-5.5',
            serviceTier: 'priority'
        })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.5 · Fast'
        })
    })

    it('shows Codex reasoning effort and service tier even when the model is auto', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'codex' },
            modelReasoningEffort: 'xhigh',
            serviceTier: 'fast'
        })).toEqual({
            key: 'session.item.model',
            value: 'Auto · XHigh · Fast'
        })
    })

    it('does not append Codex suffixes to non-Codex sessions', () => {
        expect(getSessionModelLabel({
            metadata: { flavor: 'agy' },
            model: 'Gemini 3.5 Flash (High)',
            modelReasoningEffort: 'xhigh',
            serviceTier: 'fast'
        })).toEqual({
            key: 'session.item.model',
            value: 'Gemini 3.5 Flash (High)'
        })
    })
})

describe('getSessionEffortLabel', () => {
    it('shows Auto for Claude sessions with no explicit effort', () => {
        expect(getSessionEffortLabel({ metadata: { flavor: 'claude' } })).toEqual({
            key: 'session.item.effort',
            value: 'Auto'
        })
    })

    it('shows the official Claude Code default for CC-deepseek with no explicit effort', () => {
        expect(getSessionEffortLabel({ metadata: { flavor: 'claude-deepseek' } })).toEqual({
            key: 'session.item.effort',
            value: 'Auto (Claude Code default: Max)'
        })
    })

    it('shows Auto for CC-ark sessions with no explicit effort', () => {
        expect(getSessionEffortLabel({ metadata: { flavor: 'claude-ark' } })).toEqual({
            key: 'session.item.effort',
            value: 'Auto'
        })
    })


    it('shows the model-aware Kimi K3 default effort label', () => {
        expect(getSessionEffortLabel({
            metadata: { flavor: 'cc-api' },
            model: 'kimi-k3'
        })).toEqual({
            key: 'session.item.effort',
            value: 'Auto (K3 default: Max)'
        })
    })

    it('shows explicit Claude effort labels', () => {
        expect(getSessionEffortLabel({
            metadata: { flavor: 'claude' },
            effort: 'max'
        })).toEqual({
            key: 'session.item.effort',
            value: 'Max'
        })

        expect(getSessionEffortLabel({
            metadata: { flavor: 'claude' },
            effort: 'xhigh'
        })).toEqual({
            key: 'session.item.effort',
            value: 'XHigh'
        })
    })

    it('shows explicit CC-ark effort labels', () => {
        expect(getSessionEffortLabel({
            metadata: { flavor: 'claude-ark' },
            effort: 'high'
        })).toEqual({
            key: 'session.item.effort',
            value: 'High'
        })
    })


    it('shows explicit CC-api effort labels', () => {
        expect(getSessionEffortLabel({
            metadata: { flavor: 'cc-api' },
            model: 'glm-5.2',
            effort: 'max'
        })).toEqual({
            key: 'session.item.effort',
            value: 'Max'
        })
    })

    it('does not show effort labels for agents without effort support', () => {
        expect(getSessionEffortLabel({
            metadata: { flavor: 'codex' },
            effort: 'max'
        })).toBeNull()
        expect(getSessionEffortLabel({
            metadata: { flavor: 'hermes-moa' },
            effort: 'max'
        })).toBeNull()
    })
})
