import { describe, expect, it } from 'vitest'
import { en, ja, ru, zhCN } from '@/lib/locales'

describe('localized strings', () => {
    it.each(['tool.waitingForReply', 'session.item.hibernated', 'session.composer.waking'] as const)('localizes %s in every shipped locale', (key) => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru], ['ja', ja]] as const) {
            expect(dict[key], `${locale} should define the key`).toBeTruthy()
            expect(dict[key], `${locale} should not ship the English copy`).not.toBe(en[key])
        }
    })
})