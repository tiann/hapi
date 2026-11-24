import { describe, expect, it } from 'vitest'
import { en, ja, ru, zhCN } from '@/lib/locales'

describe('question card locale strings', () => {
    it.each([
        'sessions.archivedSection',
        'settings.display.pinInProgressSessions',
        'settings.display.pinInProgressSessions.desc',
        'settings.display.pinInProgressMode.off',
        'settings.display.pinInProgressMode.jobs',
        'settings.display.pinInProgressMode.all',
        'settings.display.pinInProgressSessions.mode',
        'settings.display.pinInProgressSessions.mode.desc',
        'settings.display.pinInProgressSessions.mode.detailed',
        'settings.display.pinInProgressSessions.mode.combined',
        'settings.display.projectSort',
        'settings.display.projectSort.desc',
        'settings.display.projectSort.recent',
        'settings.display.projectSort.count',
    ] as const)('localizes %s in every shipped locale', (key) => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru], ['ja', ja]] as const) {
            expect(dict[key], `${locale} should define ${key}`).toBeTruthy()
            expect(dict[key], `${locale} should not ship English ${key}`).not.toBe(en[key])
        }
    })

    it('localizes tool.waitingForReply in every shipped locale', () => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru], ['ja', ja]] as const) {
            expect(dict['tool.waitingForReply'], `${locale} should define the key`).toBeTruthy()
            expect(dict['tool.waitingForReply'], `${locale} should not ship the English copy`).not.toBe(en['tool.waitingForReply'])
        }
    })
})