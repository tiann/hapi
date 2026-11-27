import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from './i18n-context'
import { useTranslation } from './use-translation'
import { translateIncomingToast } from './incoming-toast'

const STUCK = '"check the deploy" is waiting in Release: the session could not be resumed. The hub keeps retrying.'
const WITHOUT_PREVIEW = 'A scheduled message is waiting in Release: the session could not be resumed. The hub keeps retrying.'

function translator(locale: string) {
    localStorage.setItem('hapi-lang', locale)
    return renderHook(() => useTranslation(), { wrapper: I18nProvider }).result.current.t
}

describe('incoming hub toasts', () => {
    beforeEach(() => localStorage.clear())

    it.each([
        ['en', 'Scheduled message not sent', STUCK],
        ['zh-CN', '定时消息没有发出', '"check the deploy" 正在 Release 等待：会话无法恢复。Hub 会继续重试。'],
        ['ja', '予約メッセージは送信されていません', '"check the deploy" が Release で待機しています。セッションを再開できませんでした。Hub は再試行を続けます。'],
        ['ru', 'Запланированное сообщение не отправлено', '"check the deploy" ожидает в Release: не удалось возобновить сессию. Hub продолжает попытки.']
    ])('says in %s that a scheduled message waits on a session that will not resume', (locale, title, body) => {
        expect(translateIncomingToast('Scheduled message not sent', STUCK, translator(locale))).toEqual({ title, body })
    })

    it('names a message without a preview in the user\'s language, as the hub names it in English', () => {
        expect(translateIncomingToast('Scheduled message not sent', WITHOUT_PREVIEW, translator('zh-CN'))).toEqual({
            title: '定时消息没有发出',
            body: '一条定时消息 正在 Release 等待：会话无法恢复。Hub 会继续重试。'
        })
    })

    it('keeps a session name that has a colon of its own whole', () => {
        const body = '"ping" is waiting in fix: release: the session could not be resumed. The hub keeps retrying.'
        expect(translateIncomingToast('Scheduled message not sent', body, translator('en'))).toEqual({ title: 'Scheduled message not sent', body })
    })

    it('translates the title and shows the body as it came when the body has another shape', () => {
        expect(translateIncomingToast(' Scheduled message not sent ', 'Something else', translator('zh-CN')))
            .toEqual({ title: '定时消息没有发出', body: 'Something else' })
    })

    it('still translates the other hub toasts and passes the rest through', () => {
        const t = translator('zh-CN')
        expect(translateIncomingToast('Codex needs your input', 'What next?', t)).toEqual({ title: 'Codex 需要你回答', body: 'What next?' })
        expect(translateIncomingToast('Ready for input', 'Codex is waiting in Release', t)).toEqual({ title: '等待输入', body: 'Codex 正在 Release 等待你的输入' })
        expect(translateIncomingToast('Task completed', 'Done', t)).toEqual({ title: '任务完成', body: 'Done' })
        expect(translateIncomingToast('Custom title', 'Custom body', t)).toEqual({ title: 'Custom title', body: 'Custom body' })
    })
})
