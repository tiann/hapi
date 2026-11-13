import { describe, expect, it } from 'vitest'
import { en, ru, zhCN } from '@/lib/locales'

describe('question card locale strings', () => {
    it('localizes tool.waitingForReply in every shipped locale', () => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru]] as const) {
            expect(dict['tool.waitingForReply'], `${locale} should define the key`).toBeTruthy()
            expect(dict['tool.waitingForReply'], `${locale} should not ship the English copy`).not.toBe(en['tool.waitingForReply'])
        }
    })
})