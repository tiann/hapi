import { describe, expect, it } from 'vitest'
import { en, ja, ru, zhCN } from '@/lib/locales'
import { formatTaskInterval, formatTaskIntervalCount, intervalToMs } from '@/lib/sessionTasks'

describe('question card locale strings', () => {
    it('localizes tool.waitingForReply in every shipped locale', () => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru], ['ja', ja]] as const) {
            expect(dict['tool.waitingForReply'], `${locale} should define the key`).toBeTruthy()
            expect(dict['tool.waitingForReply'], `${locale} should not ship the English copy`).not.toBe(en['tool.waitingForReply'])
        }
    })
})

type Dict = Record<string, string>

function translate(dict: Dict) {
    return (key: string, params?: Record<string, string | number>) => {
        const template = dict[key]
        if (template === undefined) throw new Error(`missing key ${key}`)
        return template.replace(/\{(\w+)\}/g, (_match, name: string) => (params && params[name] !== undefined ? String(params[name]) : `{${name}}`))
    }
}

const locales: [string, Dict][] = [['en', en], ['zh-CN', zhCN], ['ja', ja], ['ru', ru]]

describe('session task strings', () => {
    it('ship every task key in every locale', () => {
        const keys = Object.keys(en).filter((key) => key.startsWith('tasks.') || key.startsWith('composer.task') || key === 'composer.scheduleAndTasks' || key === 'queuedMessages.fromTask' || key === 'queuedMessages.skipTaskPrompt')
        expect(keys.length).toBeGreaterThan(60)
        for (const [locale, dict] of locales) {
            for (const key of keys) {
                expect(dict[key], `${locale} should define ${key}`).toBeTruthy()
            }
        }
    })

    it('count intervals and messages grammatically in every locale', () => {
        for (const [locale, dict] of locales) {
            const t = translate(dict)
            // "Every {interval}" takes the bare unit for one unit, the counted form otherwise.
            const every = (ms: number) => t('tasks.every', { interval: formatTaskInterval(ms, t) })
            expect(every(intervalToMs(10, 'minutes')), locale).not.toMatch(/\b1\b/)
            expect(every(intervalToMs(10, 'minutes')), locale).toMatch(/10/)
            expect(every(intervalToMs(1, 'hours')), locale).toBeTruthy()
            expect(every(intervalToMs(3, 'days')), locale).toMatch(/3/)
            // Inside a sentence the count stays, with the singular for one.
            const count = (ms: number) => formatTaskIntervalCount(ms, t)
            expect(count(intervalToMs(10, 'minutes')), locale).toMatch(/10/)
            expect(count(intervalToMs(1, 'minutes')), locale).toMatch(/(^|\D)1(\D|$)/)
            // Japanese and Russian spell the one-form unit with its numeral, so the counted form must not repeat it.
            for (const unit of ['minutes', 'hours', 'days'] as const) {
                const one = count(intervalToMs(1, unit))
                expect(one, `${locale} ${unit}`).not.toMatch(/1\s+1/)
                expect(one, `${locale} ${unit}`).not.toContain('{unit}')
            }
            if (locale === 'ja') {
                expect(count(intervalToMs(1, 'minutes'))).toBe('1 分')
                expect(count(intervalToMs(1, 'hours'))).toBe('1 時間')
                expect(count(intervalToMs(1, 'days'))).toBe('1 日')
            }
            if (locale === 'ru') {
                expect(count(intervalToMs(1, 'minutes'))).toBe('1 мин')
                expect(count(intervalToMs(1, 'hours'))).toBe('1 ч')
                expect(count(intervalToMs(1, 'days'))).toBe('1 дн')
            }
            // Plural messages and tasks.
            expect(t('composer.taskQueueCount', { count: 2 }), locale).toMatch(/2/)
            expect(t('tasks.count', { count: 3 }), locale).toMatch(/3/)
            expect(t('tasks.countOne'), locale).not.toMatch(/\{count\}/)
            // English is the one that inflects.
            if (locale === 'en') {
                expect(every(intervalToMs(1, 'minutes'))).toBe('Every minute')
                expect(every(intervalToMs(1, 'days'))).toBe('Every day')
                expect(every(intervalToMs(10, 'minutes'))).toBe('Every 10 minutes')
                expect(count(intervalToMs(1, 'minutes'))).toBe('1 minute')
                expect(t('composer.taskQueueCountOne')).toBe('1 message, sent in this order')
                expect(t('tasks.countOne')).toBe('1 task')
                expect(t('composer.taskQueueCount', { count: 1 })).toBe('1 messages, sent in this order')
            }
        }
    })

    it('gives the Russian run limit no numeral phrase, since the numeral sits in the input', () => {
        expect(ru['composer.taskStopAfter']).toBe('Количество запусков')
        expect(ru['composer.taskStopAfterHint']).not.toMatch(/\bраз/)
        expect(ru['composer.taskStopAfterHint']).toBe('Оставьте пустым, чтобы повторять до остановки.')
    })

    it('gives every reason the hub records its own sentence, not the old "the task is paused" claim', () => {
        for (const [locale, dict] of locales.slice(1)) {
            expect(dict['tasks.sessionUnavailable'], locale).not.toBe(en['tasks.sessionUnavailable'])
            expect(dict['tasks.promptIndeterminate'], locale).not.toBe(dict['tasks.promptNotTaken'])
        }
        expect(en['tasks.sessionUnavailable']).toBe('The session cannot be resumed right now; retrying')
        expect(en['tasks.sessionUnavailable']).not.toContain('paused')
    })

    it('gives a failed run in the history its own reason in every locale, apart from the sentence of a task still held up', () => {
        const live: Record<string, string> = {
            machine_offline: 'tasks.waitingForMachine',
            session_unavailable: 'tasks.sessionUnavailable',
            session_archived: 'tasks.sessionArchived',
            send_failed: 'tasks.sendFailed'
        }
        expect(en['tasks.run.failedReason.machine_offline']).toBe('the machine was offline')
        expect(en['tasks.run.failedReason.session_unavailable']).toBe('the session could not be resumed')
        expect(en['tasks.run.failedReason.session_archived']).toBe('the session was archived')
        expect(en['tasks.run.failedReason.send_failed']).toBe('the send failed')
        // A noun phrase after "Failed:", never the live "…; retrying" / "Sends once …" sentence.
        for (const [locale, dict] of locales) {
            for (const [code, liveKey] of Object.entries(live)) {
                const reason = dict[`tasks.run.failedReason.${code}`]
                expect(reason, `${locale} ${code}`).toBeTruthy()
                expect(reason, `${locale} ${code}`).not.toBe(dict[liveKey])
            }
        }
        for (const [locale, dict] of locales.slice(1)) {
            expect(dict['tasks.run.failedReason.machine_offline'], locale).not.toBe(en['tasks.run.failedReason.machine_offline'])
        }
    })
})
