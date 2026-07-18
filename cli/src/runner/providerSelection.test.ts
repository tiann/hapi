import { describe, expect, it } from 'vitest'
import * as providerSelection from './providerSelection'

describe('Runner provider selection', () => {
    it('passes the selected DeepSeek model to readiness while keeping OpenCode implicit', () => {
        const resolveReadinessModel = (
            providerSelection as typeof providerSelection & {
                resolveRunnerReadinessModel?: (agent: string, model: string | undefined) => string | undefined
            }
        ).resolveRunnerReadinessModel

        expect(resolveReadinessModel?.('claude-deepseek', 'deepseek-v4-pro[1m]'))
            .toBe('deepseek-v4-pro[1m]')
        expect(resolveReadinessModel?.('opencode', 'ignored-opencode-model'))
            .toBeUndefined()
    })
})
