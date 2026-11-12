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
describe('Markdown image failure locale strings', () => {
    const keys = [
        'markdownImage.loading',
        'markdownImage.unavailable',
        'markdownImage.retrying',
        'markdownImage.retryImage',
        'markdownImage.failure.notFound',
        'markdownImage.failure.tooLargeWithSize',
        'markdownImage.failure.tooLargeLimit',
        'markdownImage.failure.notRegularFile',
        'markdownImage.failure.fileChanged',
        'markdownImage.failure.accessDenied',
        'markdownImage.failure.pathNotAllowed',
        'markdownImage.failure.sessionUnavailable',
        'markdownImage.failure.unsupportedFormat',
        'markdownImage.failure.decodeFailed',
        'markdownImage.failure.remoteLoadFailed',
        'markdownImage.failure.readFailed',
    ] as const

    it('defines localized copy in every shipped locale', () => {
        for (const [locale, dict] of [['zh-CN', zhCN], ['ru', ru]] as const) {
            for (const key of keys) {
                expect(dict[key], `${locale} should define ${key}`).toBeTruthy()
                expect(dict[key], `${locale} should localize ${key}`).not.toBe(en[key])
            }
        }
    })
})