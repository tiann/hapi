import { describe, expect, it } from 'vitest'
import { codexAgentCard } from './codexAgents'
import en from '@/lib/locales/en'
import zh from '@/lib/locales/zh-CN'

describe('child card identity and evidence', () => {
    it('does not present requested or parent settings as actual, or infer role', () => {
        const card = codexAgentCard({ model: 'requested', reasoning_effort: 'high', type: 'analyst', agentId: 'uuid' })
        expect(card.title).toBe('Unknown')
        expect(card.subtitle).toBe('Unknown · Unknown · Unknown')
        expect(card.rows.find(row => row.label === 'Role')).toBeUndefined()
    })
    it('renders task, separate nickname, native execution and localized status', () => {
        const input = { agentId: 'full-id', agentStatus: 'completed', agentIdentity: { taskName: 'analyst_298', nickname: 'Aristotle', role: 'reviewer', agentPath: '/root/analyst_298' }, agentExecution: { model: 'gpt-native', reasoningEffort: 'high', turnId: 't' } }
        expect(codexAgentCard(input).title).toBe('analyst_298 · Aristotle')
        expect(codexAgentCard(input).subtitle).toBe('gpt-native · high · Completed')
        expect(codexAgentCard(input).rows.at(-1)).toMatchObject({ value: 'full-id', copy: 'full-id' })
        expect(codexAgentCard(input, key => (zh as Record<string, string>)[key]).subtitle).toBe('gpt-native · high · 已完成')
        expect(codexAgentCard({}, key => (en as Record<string, string>)[key]).title).toBe('Unknown')
    })
})
