import { describe, expect, it } from 'bun:test'
import {
    DEFAULT_USAGE_QUERY_TEMPLATES,
    QueryUsageRequestSchema,
    SaveUsageQuerySettingsRequestSchema,
    UsageQueryResultSchema,
    UsageQueryTemplateSchema
} from './usageQuery'

describe('usage query protocol', () => {
    it('keeps the built-in templates valid', () => {
        expect(DEFAULT_USAGE_QUERY_TEMPLATES).toHaveLength(6)
        for (const template of DEFAULT_USAGE_QUERY_TEMPLATES) {
            expect(UsageQueryTemplateSchema.safeParse(template).success).toBe(true)
        }
        expect(DEFAULT_USAGE_QUERY_TEMPLATES.map((template) => template.adapter)).toEqual([
            'kimi-coding',
            'zenmux-subscription',
            'zhipu-coding',
            'minimax-coding',
            'json-path',
            'json-path'
        ])
    })

    it('accepts a draft template without credentials', () => {
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        const parsed = SaveUsageQuerySettingsRequestSchema.safeParse({
            agent: 'claude',
            enabled: true,
            templateId: template.id,
            template
        })
        expect(parsed.success).toBe(true)
    })

    it('rejects mutating HTTP methods in user templates', () => {
        const template = {
            ...DEFAULT_USAGE_QUERY_TEMPLATES[0],
            request: { ...DEFAULT_USAGE_QUERY_TEMPLATES[0].request, method: 'POST' }
        }
        expect(UsageQueryTemplateSchema.safeParse(template).success).toBe(false)
    })

    it('rejects request bodies in read-only templates', () => {
        const template = {
            ...DEFAULT_USAGE_QUERY_TEMPLATES[0],
            request: { ...DEFAULT_USAGE_QUERY_TEMPLATES[0].request, body: '{}' }
        }
        expect(UsageQueryTemplateSchema.safeParse(template).success).toBe(false)
    })

    it('rejects mismatched save template IDs', () => {
        const template = DEFAULT_USAGE_QUERY_TEMPLATES[0]
        const parsed = SaveUsageQuerySettingsRequestSchema.safeParse({
            agent: 'claude',
            enabled: true,
            templateId: 'different-template',
            template
        })
        expect(parsed.success).toBe(false)
        if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['templateId'])
    })

    it('rejects unknown agents and malformed query requests', () => {
        expect(QueryUsageRequestSchema.safeParse({ agent: 'gemini' }).success).toBe(false)
        expect(QueryUsageRequestSchema.safeParse({ agent: 'codex', force: 'yes' }).success).toBe(false)
    })

    it('validates sanitized quota results', () => {
        expect(UsageQueryResultSchema.safeParse({
            agent: 'codex',
            templateId: 'kimi-coding-plan',
            status: 'success',
            fiveHour: { usedPercent: 42, resetsAt: 1_780_000_000_000 },
            sevenDay: { usedPercent: 18, resetsAt: null },
            queriedAt: 1_780_000_000_000,
            stale: false
        }).success).toBe(true)
    })
})
