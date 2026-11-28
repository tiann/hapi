import { describe, expect, it } from 'vitest'
import { en, ja, ru, zhCN } from '@/lib/locales'

describe('question card locale strings', () => {
    it('localizes tool.waitingForReply in every shipped locale', () => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru], ['ja', ja]] as const) {
            expect(dict['tool.waitingForReply'], `${locale} should define the key`).toBeTruthy()
            expect(dict['tool.waitingForReply'], `${locale} should not ship the English copy`).not.toBe(en['tool.waitingForReply'])
        }
    })
})

describe('local-session import copy', () => {
    const english: Record<string, string> = en
    const dictionaries: Array<[string, Record<string, string>]> = [['zh-CN', zhCN], ['ru', ru], ['ja', ja]]

    it('ships every dshSync.* key of the English dictionary in every other locale', () => {
        // The DSH import dialog is generic: a missing key silently falls back
        // to English, so a new flavor's keys have to be added to every locale
        // on purpose — nothing else in the suite would notice a gap.
        const keys = Object.keys(english).filter((key) => key.startsWith('dshSync.'))
        expect(keys.length).toBeGreaterThan(20)
        for (const [locale, dict] of dictionaries) {
            const missing = keys.filter((key) => !(key in dict))
            expect(missing, `${locale} is missing dshSync keys`).toEqual([])
        }
    })
})
