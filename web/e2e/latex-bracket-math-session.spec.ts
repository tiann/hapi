import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import {
    getHapiBaseUrl,
    installHapiAuth,
    readCliAccessToken,
} from './helpers/hapi-live'

const liveEnabled = process.env.HAPI_LIVE === '1' && Boolean(process.env.SESSION_ID?.trim())

test.describe('LaTeX bracket math (live HAPI session)', () => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 and SESSION_ID to run against a real hub session')

    test('renders math and exports the share image', async ({ page }, testInfo) => {
        const baseUrl = getHapiBaseUrl()
        const sessionId = process.env.SESSION_ID?.trim()
        if (!sessionId) throw new Error('SESSION_ID is required for the live LaTeX smoke')
        await installHapiAuth(page, baseUrl, readCliAccessToken())
        if (process.env.HAPI_LIVE_MOBILE === '1') {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })
                const nativeMatchMedia = window.matchMedia.bind(window)
                window.matchMedia = (query: string) => {
                    if (query !== '(pointer: coarse)') return nativeMatchMedia(query)
                    return {
                        matches: true,
                        media: query,
                        onchange: null,
                        addListener: () => undefined,
                        removeListener: () => undefined,
                        addEventListener: () => undefined,
                        removeEventListener: () => undefined,
                        dispatchEvent: () => false,
                    }
                }
            })
            await page.setViewportSize({ width: 390, height: 844 })
        }
        await page.goto(`${baseUrl}/sessions/${sessionId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        })
        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'dark'
        })

        const assistant = page.locator('[data-hapi-message-role="assistant"]').last()
        await expect.poll(() => assistant.locator('.katex').count(), { timeout: 30_000 }).toBeGreaterThan(0)
        const pageMathCount = await assistant.locator('.katex').count()
        const pageDisplayMathCount = await assistant.locator('.katex-display').count()
        // The synced seq=701 response contains 79 bracket-delimited display
        // formulas. A small positive assertion would miss regressions where
        // only the simplest formula still renders.
        expect(pageMathCount).toBeGreaterThan(50)
        expect(pageDisplayMathCount).toBeGreaterThan(50)
        await expect.poll(() => assistant.locator('.katex').first().evaluate((element) => (
            getComputedStyle(element).fontFamily.includes('KaTeX')
        ))).toBe(true)

        const mentionExplainer = page.getByRole('dialog', { name: 'New: @mention another session' })
        if (await mentionExplainer.count()) {
            await mentionExplainer.getByRole('button', { name: 'Close explainer' }).click()
        }
        await assistant.locator('[data-hapi-share-action="true"]').click({ force: true })
        const dialog = page.getByRole('dialog', { name: /Share turn as image|将本轮对话分享为图片/ })
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('.katex')).toHaveCount(pageMathCount, { timeout: 30_000 })
        await expect(dialog.locator('.katex-display')).toHaveCount(pageDisplayMathCount)

        const downloadPromise = page.waitForEvent('download')
        await dialog.getByRole('button', { name: /^(Download|下载)$/ }).click()
        const download = await downloadPromise
        const outputPath = testInfo.outputPath('live-latex-share.png')
        await download.saveAs(outputPath)
        const bytes = await readFile(outputPath)
        expect(bytes.subarray(1, 4).toString()).toBe('PNG')
        expect(bytes.length).toBeGreaterThan(80_000)
    })
})
