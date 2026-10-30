import { expect, test } from '@playwright/test'
import { join } from 'node:path'

for (const mobile of [false, true]) {
    test.describe(mobile ? 'mobile' : 'desktop', () => {
        test.setTimeout(120_000)
        test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } })

        test.beforeEach(async ({ page }) => {
            await page.goto('/e2e-fixtures/notify-summary-fixture.html', { waitUntil: 'domcontentloaded' })
            await expect(page.getByTestId('notify-summary-footer')).toBeVisible({ timeout: 60_000 })
        })

        test('keeps the completed summary while sending, queueing and starting a new response', async ({ page }) => {
            const screenshots = process.env.HAPI_SUMMARY_SCREENSHOTS
            const prefix = mobile ? 'mobile' : 'desktop'
            const firstText = page.getByTestId('summary-text').first()
            // Observe every DOM mutation during the handoff, not only its final state.
            await firstText.evaluate(element => {
                element.setAttribute('data-raw-seen', 'false')
                new MutationObserver(() => {
                    if (element.textContent?.includes('AGENT_NOTIFY_SUMMARY')) element.setAttribute('data-raw-seen', 'true')
                }).observe(element, { childList: true, subtree: true, characterData: true })
            })
            await page.getByRole('textbox', { name: 'Message' }).fill('Please continue.')
            await page.getByRole('button', { name: 'Send', exact: true }).click()
            await expect(firstText).toHaveAttribute('data-part-status', 'running')
            await expect(firstText.getByTestId('notify-summary-footer')).toBeVisible()
            await expect(firstText).toHaveAttribute('data-raw-seen', 'false')
            if (screenshots) await page.screenshot({ path: join(screenshots, `${prefix}-send-pending.png`), fullPage: true })

            await page.getByRole('button', { name: 'Accept queued message' }).click()
            await expect(firstText).toHaveAttribute('data-part-status', 'complete')
            await expect(firstText.getByTestId('notify-summary-footer')).toBeVisible()
            await page.getByRole('button', { name: 'Stream new response' }).click()
            const newText = page.getByTestId('summary-text').last()
            await expect(newText).toHaveAttribute('data-part-status', 'running')
            await expect(newText).toContainText('AGENT_NOTIFY_SUMMARY')
            await expect(newText.getByTestId('notify-summary-footer')).toHaveCount(0)
            await expect(firstText).toHaveAttribute('data-raw-seen', 'false')

            await page.getByRole('button', { name: 'Complete response', exact: true }).click()
            await expect(page.getByTestId('notify-summary-footer')).toHaveCount(2)
            await expect(page.getByTestId('assistant-message').last()).not.toContainText('AGENT_NOTIFY_SUMMARY')
            if (screenshots) await page.screenshot({ path: join(screenshots, `${prefix}-new-response-complete.png`), fullPage: true })
        })

        test('honors display changes and resumes streaming when completed text changes', async ({ page }) => {
            await page.getByRole('textbox', { name: 'Message' }).fill('Continue.')
            await page.getByRole('button', { name: 'Send', exact: true }).click()
            const text = page.getByTestId('summary-text').first()
            await expect(text).toHaveAttribute('data-part-status', 'running')
            await expect(text.getByTestId('notify-summary-footer')).toBeVisible()
            await page.getByRole('checkbox', { name: 'Show summaries' }).uncheck()
            await expect(text.getByTestId('notify-summary-footer')).toHaveCount(0)
            await expect(text).not.toContainText('AGENT_NOTIFY_SUMMARY')
            await page.getByRole('checkbox', { name: 'Show summaries' }).check()
            await expect(text.getByTestId('notify-summary-footer')).toBeVisible()
            await page.getByRole('button', { name: 'Continue existing text' }).click()
            await expect(text).toContainText('More output.')
            await expect(text.getByTestId('notify-summary-footer')).toHaveCount(0)
        })
    })
}
